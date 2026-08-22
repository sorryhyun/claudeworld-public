/**
 * CRUD for PlayerState: read the row, hand the JSON blob to
 * `domain/player-rules.ts`, write it back. Those rules are shared with
 * `services/player-service.ts`, which runs the same mutations against
 * `player.json`, so none of the logic is inlined here.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { locations, playerStates, type Location, type PlayerState } from '../db/schema'
import {
  applyStatChanges,
  initializeStatsFromDefinitions,
  InventoryItem,
  mergeInventoryItem,
  removeInventoryItem as removeItemFromList,
  type InventoryEntry,
  type InventoryItemFields,
  type StatDefinitions,
} from '../domain/player-rules'
import { PlayerStateSerializer } from '../domain/player-state-serializer'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('PlayerStateCRUD')

export interface PlayerStateWithLocation extends PlayerState {
  currentLocation: Location | null
}

/** How many entries `action_history` keeps. Older ones are dropped on write. */
const ACTION_HISTORY_LIMIT = 10

export interface ActionHistoryEntry {
  turn: number
  action: string
  result: string
}

// `world_id` is UNIQUE, so this is always at most one row.
function loadState(db: Db, worldId: number): PlayerState | null {
  return db.select().from(playerStates).where(eq(playerStates.worldId, worldId)).get() ?? null
}

export function getPlayerState(db: Db, worldId: number): PlayerStateWithLocation | null {
  const row = db
    .select({ state: playerStates, currentLocation: locations })
    .from(playerStates)
    .leftJoin(locations, eq(playerStates.currentLocationId, locations.id))
    .where(eq(playerStates.worldId, worldId))
    .get()

  return row ? { ...row.state, currentLocation: row.currentLocation } : null
}

/**
 * Move the player to a location. Three writes in one transaction: a poll landing
 * between the first and third would render a map with two current locations or
 * none. Visiting also *discovers* the location, which is what makes somewhere
 * the `travel` tool moved to appear in the player's list.
 */
export function setCurrentLocation(
  db: Db,
  worldId: number,
  locationId: number,
): PlayerStateWithLocation | null {
  const state = loadState(db, worldId)
  if (!state) return null

  db.transaction(() => {
    if (state.currentLocationId !== null) {
      db.update(locations)
        .set({ isCurrent: false })
        .where(eq(locations.id, state.currentLocationId))
        .run()
    }

    db.update(locations)
      .set({ isCurrent: true, isDiscovered: true })
      .where(eq(locations.id, locationId))
      .run()

    db.update(playerStates)
      .set({ currentLocationId: locationId })
      .where(eq(playerStates.worldId, worldId))
      .run()
  })

  return getPlayerState(db, worldId)
}

// 0 when the world has no player state; callers treat the turn number as
// advisory display data. `turn_count` is nullable, hence the fold.
export function incrementTurn(db: Db, worldId: number): number {
  const state = loadState(db, worldId)
  if (!state) return 0

  const next = (state.turnCount ?? 0) + 1
  db.update(playerStates).set({ turnCount: next }).where(eq(playerStates.worldId, worldId)).run()
  return next
}

// The cast is deliberate: unlike `services/player-service.ts`, nothing is
// filtered out — that would silently delete stats from the stored column.
function readStats(state: PlayerState): Record<string, number> {
  return PlayerStateSerializer.parseStats(state.stats) as Record<string, number>
}

// Omitting `statDefinitions` means unbounded stats — how a stat an agent
// invented mid-game behaves.
export function updateStats(
  db: Db,
  worldId: number,
  changes: Record<string, number>,
  statDefinitions?: StatDefinitions | null,
): Record<string, number> {
  const state = loadState(db, worldId)
  if (!state) return {}

  const newStats = applyStatChanges(readStats(state), changes, statDefinitions)

  db.update(playerStates)
    .set({ stats: PlayerStateSerializer.serializeStats(newStats) })
    .where(eq(playerStates.worldId, worldId))
    .run()

  return newStats
}

/**
 * Build the starting stat block from the world's definitions. This *replaces*
 * the blob rather than merging, so a second call mid-campaign wipes the
 * player's progress; character creation is the only caller.
 */
export function initializePlayerStats(
  db: Db,
  worldId: number,
  statDefinitions: StatDefinitions,
  initialStats?: Record<string, number> | null,
): Record<string, number> {
  const state = loadState(db, worldId)
  if (!state) return {}

  const newStats = initializeStatsFromDefinitions(statDefinitions, initialStats)

  db.update(playerStates)
    .set({ stats: PlayerStateSerializer.serializeStats(newStats) })
    .where(eq(playerStates.worldId, worldId))
    .run()

  return newStats
}

/**
 * Add an item to the inventory. The stored shape is the embedded one, *not* the
 * reference shape `player.json` uses — the column holds the full item.
 */
export function addInventoryItem(
  db: Db,
  worldId: number,
  item: InventoryItemFields,
): InventoryEntry[] {
  const state = loadState(db, worldId)
  if (!state) return []

  const inventory = PlayerStateSerializer.parseInventory<InventoryEntry>(state.inventory)
  const newInventory = mergeInventoryItem(inventory, new InventoryItem(item))

  db.update(playerStates)
    .set({ inventory: PlayerStateSerializer.serializeInventory(newInventory) })
    .where(eq(playerStates.worldId, worldId))
    .run()

  return newInventory
}

export interface RemoveInventoryItemResult {
  success: boolean
  /** Quantity left afterwards; on a shortfall, the quantity actually held. */
  remaining: number
}

/**
 * Remove `quantity` of an item. Nothing is written when the removal fails,
 * shortfalls included, so a caller charging an item cost cannot take partial
 * payment; `remaining` is then what the player actually holds.
 */
export function removeInventoryItem(
  db: Db,
  worldId: number,
  itemId: string,
  quantity = 1,
): RemoveInventoryItemResult {
  const state = loadState(db, worldId)
  if (!state) return { success: false, remaining: 0 }

  const inventory = PlayerStateSerializer.parseInventory<InventoryEntry>(state.inventory)
  const result = removeItemFromList(inventory, itemId, quantity)

  if (!result.success) return { success: false, remaining: result.remaining }

  db.update(playerStates)
    .set({ inventory: PlayerStateSerializer.serializeInventory(result.inventory) })
    .where(eq(playerStates.worldId, worldId))
    .run()

  return { success: true, remaining: result.remaining }
}

// A corrupt blob throws rather than silently resetting the history; quietly
// discarding a player's recent actions is the worse failure.
export function addActionToHistory(db: Db, worldId: number, entry: ActionHistoryEntry): void {
  const state = db
    .select({ actionHistory: playerStates.actionHistory })
    .from(playerStates)
    .where(eq(playerStates.worldId, worldId))
    .get()

  if (!state) return

  const history: unknown = state.actionHistory ? JSON.parse(state.actionHistory) : []
  if (!Array.isArray(history)) {
    throw new TypeError(`player_states.action_history for world ${worldId} is not a JSON array`)
  }

  history.push({ turn: entry.turn, action: entry.action, result: entry.result })

  db.update(playerStates)
    .set({ actionHistory: JSON.stringify(history.slice(-ACTION_HISTORY_LIMIT)) })
    .where(eq(playerStates.worldId, worldId))
    .run()
}

// Chat mode and gameplay share a room and the `messages` table, and
// `chat_session_id` is the whole mechanism keeping the two transcripts apart.
// The next two functions own that id's lifetime.

/**
 * Enter chat mode, minting the session id every chat message will carry. `null`
 * both when there is no player state and when already in chat mode: either way
 * the caller must not start a second session, and minting a fresh id would
 * strand the running session's messages under the old one.
 */
export function enterChatMode(db: Db, worldId: number, startMessageId: number): number | null {
  const state = loadState(db, worldId)
  if (!state) {
    logger.warning(`Cannot enter chat mode: PlayerState not found for world ${worldId}`)
    return null
  }

  if (state.isChatMode) {
    logger.info(`Already in chat mode for world ${worldId}`)
    return null
  }

  const chatSessionId = Date.now() % (2 ** 31 - 1)

  db.update(playerStates)
    .set({
      isChatMode: true,
      chatModeStartMessageId: startMessageId,
      chatSessionId,
    })
    .where(eq(playerStates.worldId, worldId))
    .run()

  logger.info(
    `Entered chat mode for world ${worldId}, start_message_id=${startMessageId}, chat_session_id=${chatSessionId}`,
  )
  return chatSessionId
}

export interface ExitChatModeResult {
  /** The message the session started from; the frontend resumes rendering here. */
  startMessageId: number | null
  chatSessionId: number | null
}

/**
 * Leave chat mode, reporting the session that just ended.
 * `chat_mode_start_message_id` is deliberately *not* cleared — the frontend
 * reads it after the exit as where to resume the gameplay transcript.
 * `chat_session_id` *is*, or the next message would look like part of it.
 */
export function exitChatMode(db: Db, worldId: number): ExitChatModeResult | null {
  const state = loadState(db, worldId)
  if (!state) {
    logger.warning(`Cannot exit chat mode: PlayerState not found for world ${worldId}`)
    return null
  }

  if (!state.isChatMode) {
    logger.info(`Not in chat mode for world ${worldId}`)
    return null
  }

  const startMessageId = state.chatModeStartMessageId
  const chatSessionId = state.chatSessionId

  db.update(playerStates)
    .set({ isChatMode: false, chatSessionId: null })
    .where(eq(playerStates.worldId, worldId))
    .run()

  logger.info(
    `Exited chat mode for world ${worldId}, start_message_id=${startMessageId}, chat_session_id=${chatSessionId}`,
  )
  return { startMessageId, chatSessionId }
}
