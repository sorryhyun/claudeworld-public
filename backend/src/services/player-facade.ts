/**
 * Filesystem-first player mutations with a write-through to `player_states`.
 * `player.json` is the authoritative save file and the row is a cache the polling
 * endpoint reads; both must move together, which is why this class exists. The
 * filesystem write *is* the operation — the mirror is allowed to fail, so every
 * method returns success once `player.json` is written, and it overwrites whole
 * values rather than replaying the delta.
 *
 * Landmines: the sync never inserts, so a world whose row character creation has
 * not written yet is skipped; the clock has no column, yet {@link advanceTime}
 * syncs anyway, rewriting stats and inventory from disk; the inventory column
 * ends up in mixed shapes (readers go through `InventoryItem.fromReference`);
 * and {@link PlayerService} hands back the object it cached, so a failed write
 * leaves the cache holding unpersisted values. Build one per turn; without
 * `db`/`worldId` it is filesystem-only.
 */

import { eq } from 'drizzle-orm'

import {
  PlayerService,
  type PlayerState,
  type StatDefinitions as FileStatDefinitions,
} from './player-service'
import type { Db } from '@/db'
import { playerStates } from '@/db/schema'
import {
  applyStatChanges,
  InventoryItem,
  mergeInventoryItem,
  removeInventoryItem,
  type InventoryEntry,
  type StatDefinition,
  type StatDefinitions as RuleStatDefinitions,
} from '@/domain/player-rules'
import { PlayerStateSerializer } from '@/domain/player-state-serializer'
import { getLogger } from '@/infrastructure/logging/logger'
// Type-only: no runtime edge from `services/` into `sdk/`.
import type { PlayerMutationsPort, TimeAdvanceResult } from '@/sdk/handlers/ports'

const logger = getLogger('PlayerFacade')

const MINUTES_PER_DAY = 1440

// Unvalidated cast, as in `player-service.ts`: `buildStatMap` throws on an entry
// with no `name`, and pre-empting that here would leave the stat unclamped.
function asRuleDefinitions(definitions: FileStatDefinitions): RuleStatDefinitions {
  return { ...definitions, stats: definitions.stats as StatDefinition[] }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export class PlayerFacade implements PlayerMutationsPort {
  /** `players` is shared with the turn's other services so they see one another's
   * writes through one mtime cache; a `worldId` of `0` disables the sync. */
  constructor(
    private readonly players: PlayerService,
    private readonly db?: Db | null,
    private readonly worldId?: number | null,
  ) {}

  // Never throws: `player.json` is already written, so a failure costs only a
  // stale polling read. The `SELECT` is not redundant with the `WHERE` — a bare
  // `UPDATE` matching no rows would log a sync that never happened.
  private syncToDb(worldName: string, state: PlayerState): void {
    if (!this.db || !this.worldId) return

    try {
      const row = this.db
        .select({ id: playerStates.id })
        .from(playerStates)
        .where(eq(playerStates.worldId, this.worldId))
        .get()

      if (!row) return

      this.db
        .update(playerStates)
        .set({
          stats: PlayerStateSerializer.serializeStats(state.stats),
          inventory: PlayerStateSerializer.serializeInventory(state.inventory),
        })
        .where(eq(playerStates.worldId, this.worldId))
        .run()

      logger.debug(`📥 Synced player state to DB cache for world ${this.worldId} (${worldName})`)
    } catch (error) {
      logger.warning(`Failed to sync player state to DB: ${String(error)}`)
    }
  }

  /** Clamped by the world's stat definitions. `null` means no `player.json`, which
   * the handler treats as "no stats changed" rather than a failed turn. */
  updateStats(worldName: string, changes: Record<string, number>): Record<string, number> | null {
    const state = this.players.loadPlayerState(worldName)
    if (!state) {
      logger.warning(`Player state not found for world: ${worldName}`)
      return null
    }

    state.stats = applyStatChanges(
      state.stats,
      changes,
      asRuleDefinitions(this.players.loadStatDefinitions(worldName)),
    )

    this.players.savePlayerState(worldName, state)
    logger.info(`📊 Updated stats for ${worldName}: ${JSON.stringify(changes)}`)

    this.syncToDb(worldName, state)
    return state.stats
  }

  /** Stacks onto an entry with the same id. Nothing here checks that a template
   * exists; `savePlayerState` creates one, or the reference would dangle. */
  addItem(
    worldName: string,
    item: {
      itemId: string
      name: string
      quantity?: number
      description?: string | null
      properties?: Record<string, unknown> | null
    },
  ): boolean {
    const state = this.players.loadPlayerState(worldName)
    if (!state) {
      logger.warning(`Player state not found for world: ${worldName}`)
      return false
    }

    const quantity = item.quantity ?? 1
    state.inventory = mergeInventoryItem(
      state.inventory,
      new InventoryItem({
        id: item.itemId,
        name: item.name,
        quantity,
        description: item.description,
        properties: item.properties,
      }),
    )

    this.players.savePlayerState(worldName, state)
    logger.info(`📦 Added item to ${worldName}: ${item.name} x${quantity}`)

    this.syncToDb(worldName, state)
    return true
  }

  /** `false` covers no `player.json`, no such item, and holding fewer than asked
   * for — the last writes nothing, so an item cost cannot be part-paid. */
  removeItem(worldName: string, itemId: string, quantity = 1): boolean {
    const state = this.players.loadPlayerState(worldName)
    if (!state) {
      logger.warning(`Player state not found for world: ${worldName}`)
      return false
    }

    const result = removeInventoryItem(state.inventory, itemId, quantity)
    if (!result.success) {
      logger.info(
        `Cannot remove ${quantity} of item ${itemId} (only ${result.remaining} available)`,
      )
      return false
    }

    state.inventory = result.inventory

    this.players.savePlayerState(worldName, state)
    logger.info(`📦 Removed item from ${worldName}: ${itemId} x${quantity}`)

    this.syncToDb(worldName, state)
    return true
  }

  getInventory(worldName: string): InventoryEntry[] {
    return this.players.getResolvedInventory(worldName)
  }

  /** Rolls over at 24:00. `null` for a non-positive `minutes`, checked before the
   * load so "advance by zero" is not even a read. */
  advanceTime(worldName: string, minutes: number): TimeAdvanceResult | null {
    if (minutes <= 0) return null

    const state = this.players.loadPlayerState(worldName)
    if (!state) {
      logger.warning(`Player state not found for world: ${worldName}`)
      return null
    }

    const oldTime = { ...state.gameTime }

    // Subtracting the floored quotient rather than using `%` keeps the rollover
    // correct for a clock that has somehow gone negative.
    const totalMinutes = state.gameTime.hour * 60 + state.gameTime.minute + minutes
    const daysPassed = Math.floor(totalMinutes / MINUTES_PER_DAY)
    const remainingMinutes = totalMinutes - daysPassed * MINUTES_PER_DAY

    const newHour = Math.floor(remainingMinutes / 60)
    state.gameTime = {
      hour: newHour,
      minute: remainingMinutes - newHour * 60,
      day: state.gameTime.day + daysPassed,
    }

    this.players.savePlayerState(worldName, state)
    logger.info(
      `⏰ Advanced time for ${worldName}: +${minutes}min -> ` +
        `${pad2(state.gameTime.hour)}:${pad2(state.gameTime.minute)} Day ${state.gameTime.day}`,
    )

    this.syncToDb(worldName, state)
    return { oldTime, newTime: state.gameTime }
  }

  loadPlayerState(worldName: string): PlayerState | null {
    return this.players.loadPlayerState(worldName)
  }
}
