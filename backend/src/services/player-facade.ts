/**
 * Filesystem-first player mutations, with a write-through to `player_states`.
 *
 * Ported from `backend/services/facades/player_facade.py`.
 *
 * `worlds/{name}/player.yaml` is the authoritative save file; the
 * `player_states` row is a cache the polling endpoint reads. Both have to move
 * together, and *that* is the only reason this class exists rather than a
 * handful of {@link PlayerService} calls: a stat change that lands only on disk
 * is invisible to the player until something else forces a full state reload,
 * and one that lands only in the row is lost on the next `savePlayerState`.
 *
 * ## The two sides are not symmetric
 *
 * The filesystem write is the operation. The database write is a mirror of
 * whatever the filesystem now holds, and it is allowed to fail: Python wraps
 * `_sync_to_db` in a bare `except` that logs a warning
 * (`player_facade.py:127-128`), so a locked or closed database degrades the
 * player's *display* for one turn instead of failing their turn. Reproduced
 * exactly — every method here returns success once `player.yaml` is written.
 *
 * This also means the mirror is a whole-value overwrite, not a replay of the
 * delta. The `crud/player-state.ts` mutators are deliberately *not* used for
 * it: `updateStats` there would add the same delta a second time, to a blob
 * that may already have drifted from disk, and `addInventoryItem` would store
 * the embedded item shape where this path stores what the save file holds. The
 * facade's contract is "the row says what the file says", so it writes the two
 * columns directly.
 *
 * ## Parity landmines
 *
 * - **`_sync_to_db` never inserts.** A world whose `player_states` row does not
 *   exist yet is written to disk and skipped here (`if db_state:`). Character
 *   creation is what creates that row; the facade must not race it.
 * - **The clock has no column.** `player_states` stores stats, inventory,
 *   effects and action history — there is nowhere to put `game_time`. Python
 *   still calls `_sync_to_db` after `advance_time`, so advancing the clock
 *   rewrites the *stats and inventory* columns from disk as a side effect. That
 *   is load-bearing in one direction (it repairs a row that had drifted) and
 *   surprising in the other (it overwrites whatever a `crud` mutator wrote
 *   since the last save), and it is reproduced rather than optimised away.
 * - **The inventory column ends up in mixed shapes.** What is synced is the
 *   *in-memory* inventory: entries read from `player.yaml` are in reference
 *   form (`{item_id, quantity, instance_properties}`), while an entry
 *   {@link addItem} just merged in is in the embedded form
 *   `InventoryItem.toDict()` produces. `savePlayerState` converts on the way to
 *   disk but does not touch the object it was handed, so the row receives the
 *   pre-conversion list. Python behaves identically (`player_service.py:105`
 *   builds a separate `inventory_refs`), and every reader of that column goes
 *   through `InventoryItem.fromReference`, which accepts both shapes.
 * - **The loaded state is the cached state.** {@link PlayerService} hands back
 *   the object it cached, so assigning to `state.stats` here mutates the cache
 *   too. If the filesystem write then throws, the in-memory cache is left
 *   holding values that were never persisted, until `player.yaml`'s mtime
 *   moves. Python's `_player_state_cache` has exactly this property.
 *
 * ## Binding
 *
 * Python constructs the facade per world (`PlayerFacade(world_name, db,
 * world_id)`); {@link PlayerMutationsPort} instead takes the world *name* per
 * call, so the filesystem side is chosen by the caller and only the database
 * binding lives on the instance. Build one per turn, the way `servers.ts` binds
 * a `PersistenceManager`. Constructed without `db`/`worldId` it is the
 * filesystem-only mode Python's `PlayerFacade(world_name)` gives, which is what
 * a sub-agent running before the world has a row wants.
 */

import { eq } from 'drizzle-orm'

import {
  PlayerService,
  type PlayerState,
  type StatDefinitions as FileStatDefinitions,
} from './player-service'
import type { Db } from '../db'
import { playerStates } from '../db/schema'
import {
  applyStatChanges,
  InventoryItem,
  mergeInventoryItem,
  removeInventoryItem,
  type InventoryEntry,
  type StatDefinition,
  type StatDefinitions as RuleStatDefinitions,
} from '../domain/player-rules'
import { PlayerStateSerializer } from '../domain/player-state-serializer'
import { getLogger } from '../infrastructure/logging/logger'
// Type-only, so this does not put a runtime edge from `services/` into `sdk/`:
// the interface lives next to the handlers that consume it, and implementing it
// by name is what stops the two drifting apart.
import type { PlayerMutationsPort, TimeAdvanceResult } from '../sdk/handlers/ports'

const logger = getLogger('PlayerFacade')

/** Minutes in a day — the modulus `advance_time` rolls the clock over on. */
const MINUTES_PER_DAY = 1440

/**
 * Hand `stats.yaml` to the domain rules.
 *
 * The same cast `player-service.ts` performs, and for the same reason: this
 * layer read whatever the file held, and `buildStatMap` throws on an entry with
 * no `name` exactly as Python's `stat["name"]` raises. Pre-empting that here
 * would silently leave the stat unclamped.
 */
function asRuleDefinitions(definitions: FileStatDefinitions): RuleStatDefinitions {
  return { ...definitions, stats: definitions.stats as StatDefinition[] }
}

/** Two-digit clock field, matching Python's `{:02d}` in the log line. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export class PlayerFacade implements PlayerMutationsPort {
  /**
   * @param players The filesystem layer. Shared with the rest of the turn's
   *   services so they see one another's writes through one mtime cache.
   * @param db Omit for filesystem-only mode.
   * @param worldId The row to mirror onto. Required for any database write;
   *   `0` disables the sync as surely as `undefined` does, matching Python's
   *   truthiness check on `self.world_id`.
   */
  constructor(
    private readonly players: PlayerService,
    private readonly db?: Db | null,
    private readonly worldId?: number | null,
  ) {}

  // ==========================================================================
  // Write-through
  // ==========================================================================

  /**
   * Mirror the filesystem state onto the `player_states` row.
   *
   * Never throws. The caller has already written `player.yaml`, so the
   * mutation succeeded whatever happens here; all a failure costs is a stale
   * polling read until the next successful sync.
   *
   * The `SELECT` before the `UPDATE` is Python's `if db_state:` and is not
   * redundant with the `WHERE`: a bare `UPDATE` matching no rows would log a
   * sync that did not happen, and "this world has no player state yet" is a
   * routine state during onboarding rather than an anomaly.
   */
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

  // ==========================================================================
  // Stats
  // ==========================================================================

  /**
   * Apply `name -> delta` changes, clamped by the world's stat definitions.
   *
   * `null` means the world has no `player.yaml` — a world that does not exist,
   * or one whose files were deleted underneath a running turn. Python returns
   * `None` and logs the same warning; the tool handler treats it as "no stats
   * changed" rather than a failed turn.
   *
   * {@link PlayerService.updateStats} does load-apply-save already, but it
   * reports a missing save file as `{}`, which a world whose stats are legitimately
   * empty is indistinguishable from — and the write-through needs the loaded
   * state's *inventory* anyway. So the state is loaded here and the domain rule
   * is applied directly, which is also what Python does.
   */
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

  // ==========================================================================
  // Inventory
  // ==========================================================================

  /**
   * Add an item, stacking onto an entry with the same id.
   *
   * `false` only when there is no `player.yaml` (Python's `None`). The add
   * itself cannot fail: nothing here checks that a template exists — that gate
   * lives in `change_stat`, which refuses to add an item the world has not
   * defined, while `persist_item` calls this immediately *after* writing the
   * template.
   *
   * The template is created regardless, by `savePlayerState` →
   * `ItemService.toReferenceFormat`, since the reference this writes into
   * `player.yaml` would otherwise dangle.
   */
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

  /**
   * Remove `quantity` of an item.
   *
   * `false` covers three cases Python's caller cannot distinguish either: no
   * `player.yaml`, no such item, and holding fewer than were asked for. The
   * third writes nothing at all — {@link removeInventoryItem} refuses a partial
   * removal, so a caller charging an item cost cannot end up having taken part
   * payment. Neither side is touched on a failure, which keeps the row and the
   * file in step through the failure too.
   *
   * Python returns the shortfall as a message on its result object; the port
   * returns a boolean, so the only place left for "you have 2, not 4" is the
   * log — the alternative is losing it entirely.
   */
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

  /**
   * The inventory with every reference resolved against its `items/` template.
   *
   * Python's `get_inventory(resolved=True)`. The `resolved=False` branch is not
   * ported: {@link PlayerMutationsPort} does not offer it, and the only Python
   * caller (`mechanics_tools.py:233`) asks for the resolved list — a raw
   * reference list would render as bare ids in the model's context.
   */
  getInventory(worldName: string): InventoryEntry[] {
    return this.players.getResolvedInventory(worldName)
  }

  // ==========================================================================
  // Clock
  // ==========================================================================

  /**
   * Advance the in-world clock, rolling over at 24:00.
   *
   * `null` for a non-positive `minutes` — checked *before* the state is loaded,
   * so "advance by zero" is not even a read — and for a world with no
   * `player.yaml`. `advance_time` renders its success text off this result, so
   * both cases silently degrade to a message without a time in it.
   *
   * There is no clock column to sync; see the note on the write-through in this
   * file's header for why the sync is issued anyway.
   */
  advanceTime(worldName: string, minutes: number): TimeAdvanceResult | null {
    if (minutes <= 0) return null

    const state = this.players.loadPlayerState(worldName)
    if (!state) {
      logger.warning(`Player state not found for world: ${worldName}`)
      return null
    }

    const oldTime = { ...state.gameTime }

    // Python's `//` and `%` floor toward negative infinity and take the
    // divisor's sign; JS's `/` and `%` do neither. Subtracting the floored
    // quotient reproduces Python's pair for a clock that has somehow gone
    // negative, which is the only input where the two disagree.
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

  // ==========================================================================
  // Reads
  // ==========================================================================

  /**
   * The raw save state, for the handlers that need the clock or the turn count.
   *
   * A straight delegation, present because the handlers hold the port rather
   * than a {@link PlayerService}. Python's equivalents are the facade's
   * `get_stats` / `get_game_time`; those two, and `apply_stat_calc_result`,
   * have no call site in the Python tree and are not ported.
   */
  loadPlayerState(worldName: string): PlayerState | null {
    return this.players.loadPlayerState(worldName)
  }
}
