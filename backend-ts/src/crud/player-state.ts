/**
 * CRUD operations for PlayerState — port of `backend/crud/player_state.py`.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { locations, playerStates, type Location, type PlayerState } from '../db/schema'

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
  const state: PlayerState | undefined = db
    .select()
    .from(playerStates)
    .where(eq(playerStates.worldId, worldId))
    .get()

  if (!state) return 0

  const next = (state.turnCount ?? 0) + 1
  db.update(playerStates).set({ turnCount: next }).where(eq(playerStates.worldId, worldId)).run()
  return next
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
