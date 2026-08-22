/**
 * CRUD operations for PlayerState — port of `backend/crud/player_state.py`.
 *
 * Every mutation here is a read-modify-write of one row: fetch, hand the JSON
 * blob to the domain rules, write the result back. The rules themselves live in
 * `domain/player-rules.ts` and are shared with `services/player-service.ts`,
 * which performs the same mutations against `worlds/<world>/player.yaml` — the
 * two persistence paths must not be able to disagree about what "add an item"
 * means, which is the whole reason none of the logic is inlined here.
 *
 * Synchronous throughout; see `src/crud/agents.ts` for why the Python locking
 * decorators have no counterpart.
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

/** Player state with its `current_location` resolved, as Python eager-loads it. */
export interface PlayerStateWithLocation extends PlayerState {
  currentLocation: Location | null
}

/** How many entries `action_history` keeps. Older ones are dropped on write. */
const ACTION_HISTORY_LIMIT = 10

/** One row of `action_history`, as Python writes it (snake_case in the JSON). */
export interface ActionHistoryEntry {
  turn: number
  action: string
  result: string
}

/**
 * The row every mutation below starts from.
 *
 * Python re-issues `select(PlayerState).where(world_id == ...)` in each
 * function; this is that statement, named once. `world_id` carries a UNIQUE
 * constraint, so "the player state for a world" is always at most one row.
 */
function loadState(db: Db, worldId: number): PlayerState | null {
  return db.select().from(playerStates).where(eq(playerStates.worldId, worldId)).get() ?? null
}

/** Get the player state for a world, with its current location resolved. */
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
 * Move the player to a location, updating the two flags on the location rows.
 *
 * Three writes, one transaction: the old location loses `is_current`, the new
 * one gains it, and the player state points at the new id. Python commits them
 * together for the same reason — a poll landing between the first and third
 * write would render a map with either two current locations or none.
 *
 * Visiting a location also *discovers* it (`player_state.py:74`), which is what
 * makes a location travelled to by an agent's `travel` tool appear in the
 * player's location list at all.
 *
 * A `locationId` that does not exist is not rejected here. Python assigns the
 * id and lets the commit fail on the foreign key, and `PRAGMA foreign_keys=ON`
 * is set on both backends' connections, so this raises in exactly the same
 * place rather than quietly storing a dangling reference.
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
      // Python fetches the row first and skips the write when it is gone; a
      // bare UPDATE with a WHERE is the same thing in one statement.
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

/**
 * Increment the turn counter and return the new value.
 *
 * Returns 0 when the world has no player state — Python's way of saying "no
 * turns happened" without raising, since callers treat the turn number as
 * advisory display data.
 *
 * `turn_count` is nullable in the DDL even though the column defaults to 0, so
 * the null has to be folded in before adding.
 */
export function incrementTurn(db: Db, worldId: number): number {
  const state = loadState(db, worldId)
  if (!state) return 0

  const next = (state.turnCount ?? 0) + 1
  db.update(playerStates).set({ turnCount: next }).where(eq(playerStates.worldId, worldId)).run()
  return next
}

/**
 * Read the `stats` blob as a numeric mapping.
 *
 * The cast is deliberate and is *not* the filtering `parseStats` that
 * `services/player-service.ts` applies to `player.yaml`. That one drops
 * non-numeric values because it builds a fresh object; this one hands the blob
 * to {@link applyStatChanges}, which copies every key and only touches the ones
 * being changed. Filtering here would silently delete a stat from the stored
 * column that Python would have preserved.
 *
 * The residual difference is confined to a corrupt blob whose *changed* stat
 * holds a string: Python raises on `"5" + 1`, JavaScript concatenates. A
 * malformed stats column is broken under either backend, and refusing to write
 * would not repair it.
 */
function readStats(state: PlayerState): Record<string, number> {
  return PlayerStateSerializer.parseStats(state.stats) as Record<string, number>
}

/**
 * Apply `name -> delta` changes to the player's stats and return the result.
 *
 * `{}` for a world with no player state — Python's non-raising "nothing to
 * update", which the tool handlers surface as an empty stat panel rather than a
 * failed turn.
 *
 * Clamping belongs to {@link applyStatChanges}; passing `statDefinitions` is
 * what enables it. Omitting them is legal and means unbounded stats, which is
 * how a stat an agent invented mid-game behaves.
 */
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
 * Build the starting stat block from the world's definitions and store it.
 *
 * Distinct from {@link updateStats} in that it *replaces* the blob rather than
 * merging into it: every declared stat is reset to its default before the
 * `initialStats` overrides land. Character creation is the only caller, and a
 * second call mid-campaign would wipe the player's progress — which is Python's
 * behaviour too.
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
 * Add an item to the inventory, returning the whole new list.
 *
 * Stacking is {@link mergeInventoryItem}'s job: an id already held gains
 * quantity instead of producing a second entry. The stored shape is the legacy
 * embedded one (`InventoryItem.toDict`, all five keys), *not* the reference
 * shape `player.yaml` uses — the DB column has always held the full item and a
 * reader of an existing database would find nothing but an id otherwise.
 *
 * `[]` for a world with no player state, matching Python.
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

/** Result of {@link removeInventoryItem} — Python's `(success, remaining)` tuple. */
export interface RemoveInventoryItemResult {
  success: boolean
  /** Quantity left afterwards; on a shortfall, the quantity actually held. */
  remaining: number
}

/**
 * Remove `quantity` of an item from the inventory.
 *
 * Nothing is written when the removal fails, and that includes the shortfall
 * case: {@link removeItemFromList} refuses to remove more than is held rather
 * than draining the stack, so a caller charging an item cost cannot end up
 * having taken a partial payment. The reported `remaining` is then the quantity
 * the player actually has, which is what lets the handler say how short they
 * were.
 *
 * A world with no player state reports `{success: false, remaining: 0}` — the
 * same shape as "the player does not hold that item", which Python cannot
 * distinguish either.
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

/**
 * Append an action to the player's history, keeping only the newest entries.
 *
 * A no-op when the world has no player state, matching Python's early return.
 *
 * The column is TEXT holding a JSON array, and the whole array is rewritten on
 * every turn. Python parses it with a bare `json.loads`, so a corrupted blob
 * raises rather than silently resetting the history; that is preserved here
 * because quietly discarding a player's recent actions is the worse failure.
 */
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

// ============================================================================
// Chat mode
// ============================================================================
// Chat mode and gameplay share a room and the `messages` table;
// `chat_session_id` is the entire mechanism that keeps the two transcripts
// apart (see `getChatSessionMessages` / `getMessagesExcludingChat` in
// `crud/messages.ts`). These two functions own that id's lifetime.

/**
 * Enter chat mode, minting the session id every chat message will carry.
 *
 * Returns the new id, or `null` when there is no player state *or* when the
 * world is already in chat mode. Collapsing those two into one null is Python's
 * (`player_state.py:279-283`) and is load-bearing: the caller's only correct
 * reaction to either is "do not start a second chat session", and an early
 * return that looked like success would mint a fresh id while the messages of
 * the session already running still carry the old one.
 *
 * The id is the current time in milliseconds folded into a signed 32-bit range,
 * exactly as Python computes it. It is not a counter and not unique by
 * construction — two sessions started in the same millisecond would collide —
 * but the value only has to distinguish *consecutive* sessions in one world,
 * and a player cannot open two in the same millisecond.
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

  // `int(time.time() * 1000) % (2**31 - 1)`. `Date.now()` is already integer
  // milliseconds, so only the modulus is needed.
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

/** What {@link exitChatMode} reports about the session that just ended. */
export interface ExitChatModeResult {
  /** The message the session started from; the frontend resumes rendering here. */
  startMessageId: number | null
  /** The id the session's messages carry, for filtering the transcript. */
  chatSessionId: number | null
}

/**
 * Leave chat mode, reporting what the session that just ended was.
 *
 * `null` when there is no player state or the world was not in chat mode — the
 * same collapsed signal as {@link enterChatMode}, and for the same reason: an
 * exit that was already done must not look like an exit that just happened.
 *
 * Note `chat_mode_start_message_id` is deliberately *not* cleared
 * (`player_state.py:331-332`). The frontend reads it after the exit as the
 * point to resume the gameplay transcript from; it is overwritten on the next
 * entry. `chat_session_id` *is* cleared, because a lingering value would make
 * the next gameplay message look like it belonged to the finished session.
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
