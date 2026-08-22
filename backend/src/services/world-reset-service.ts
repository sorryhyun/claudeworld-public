/**
 * The initial-state snapshot — `worlds/{name}/_initial.json`.
 *
 * Ported from `backend/services/world_reset_service.py`.
 *
 * Onboarding ends by freezing where the character starts, what stats they have
 * and what they are carrying; "reset world" replays that snapshot over the live
 * `player.yaml`. It is written once, at the end of `complete_onboarding`
 * (`onboarding_tools.py:231-237`), and read only by the reset route.
 *
 * The file is JSON rather than YAML — unlike every other file in a world
 * directory — because it is a machine-written record no author is expected to
 * edit. Its keys are snake_case: the Python backend reads the same bytes.
 *
 * **A missing snapshot and an empty one are different things.** A world created
 * before this feature existed has no file at all and cannot be reset (the route
 * raises); a world whose character started with nothing has a file holding empty
 * collections and resets fine. {@link WorldResetService.loadInitialState}
 * returning `null` therefore means "absent or unreadable", never "empty", and
 * {@link WorldResetService.hasInitialState} answers the existence question on
 * its own.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { MtimeCache, WorldService } from './world-service'
import type { InventoryEntry } from '../domain/player-rules'
import { getLogger } from '../infrastructure/logging/logger'
import type { GameTime } from './player-service'

const logger = getLogger('WorldResetService')

/** Filename for the initial state snapshot. */
const INITIAL_STATE_FILE = '_initial.json'

// ============================================================================
// Types
// ============================================================================

/**
 * `_initial.json`. Keys are the on-disk names, not TypeScript identifiers.
 *
 * `initial_game_time` is absent from worlds captured before the in-world clock
 * existed, and from any capture where the clock was falsy — see
 * {@link WorldResetService.createInitialStateSnapshot}.
 */
export interface InitialStateSnapshot {
  /** Location *folder* name the character starts in. */
  starting_location: string
  initial_stats: Record<string, number>
  /** Reference-format entries, the same shape `player.yaml` stores. */
  initial_inventory: InventoryEntry[]
  /** `datetime.utcnow().isoformat() + "Z"`. Recorded for humans, never parsed. */
  captured_at: string
  initial_game_time?: GameTime
}

/** Arguments to {@link WorldResetService.createInitialStateSnapshot}. */
export interface InitialStateInput {
  startingLocation: string
  initialStats: Record<string, number>
  initialInventory: InventoryEntry[]
  initialGameTime?: GameTime | null
}

// ============================================================================
// Helpers
// ============================================================================

/** Whether a value is a plain JSON object, i.e. what Python calls a `dict`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Timestamp in Python's `datetime.utcnow().isoformat() + "Z"` shape: UTC, no
 * offset, microsecond precision, trailing `Z`. JS only has millisecond
 * resolution, so the last three digits are padding — the same accommodation
 * `room-mapping.ts::localIsoNow` makes, and for the same reason: the field is
 * written for humans and never parsed back.
 */
function utcIsoNow(now: Date = new Date()): string {
  // `toISOString()` already ends in `Z`; drop it before padding so the suffix is
  // not doubled.
  return `${now.toISOString().slice(0, -1)}000Z`
}

// ============================================================================
// Service
// ============================================================================

export class WorldResetService {
  private readonly worlds: WorldService

  /**
   * @param worldsDir Root of the `worlds/` tree.
   * @param cache Share a {@link MtimeCache} with other services, or omit for a
   *   private one. `_initial.json` is read twice in a world's life, so it is
   *   read uncached; the cache only reaches the wrapped {@link WorldService}.
   */
  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
  }

  /** Path to a world's snapshot, whether or not it exists. */
  getInitialStatePath(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), INITIAL_STATE_FILE)
  }

  /** Whether the world has a snapshot at all — i.e. whether it can be reset. */
  hasInitialState(worldName: string): boolean {
    return existsSync(this.getInitialStatePath(worldName))
  }

  /**
   * Read the snapshot. `null` when it is missing or unreadable.
   *
   * Python distinguishes the two cases in the log only (a warning for absent, an
   * error for a decode failure) and returns `None` from both; the caller cannot
   * tell them apart and does not need to, because either way the world cannot be
   * reset. That is kept.
   */
  loadInitialState(worldName: string): InitialStateSnapshot | null {
    const initialFile = this.getInitialStatePath(worldName)

    if (!existsSync(initialFile)) {
      logger.warning(`No ${INITIAL_STATE_FILE} found for world '${worldName}'`)
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(initialFile, 'utf-8'))
    } catch (error) {
      logger.error(`Failed to load ${INITIAL_STATE_FILE}: ${String(error)}`)
      return null
    }

    // Valid JSON of the wrong kind (a list, a string, `null`) is treated as a
    // decode failure. Python hands it straight to the reset route, which then
    // fails on the first `.get` — a file holding the wrong shape is corrupt
    // under either backend, so it is reported as one here.
    if (!isRecord(parsed)) {
      logger.error(`${INITIAL_STATE_FILE} for world '${worldName}' is not an object`)
      return null
    }

    return parsed as unknown as InitialStateSnapshot
  }

  /**
   * Write the snapshot, returning whether it landed.
   *
   * `indent: 2` and unescaped non-ASCII match Python's
   * `json.dump(..., ensure_ascii=False, indent=2)`, so a Korean location name
   * stays legible in the file and the two backends produce identical bytes.
   */
  saveInitialState(worldName: string, initialState: InitialStateSnapshot): boolean {
    try {
      writeFileSync(
        this.getInitialStatePath(worldName),
        JSON.stringify(initialState, null, 2),
        'utf-8',
      )
    } catch (error) {
      logger.error(`Failed to save ${INITIAL_STATE_FILE}: ${String(error)}`)
      return false
    }

    logger.info(`Saved initial state for world '${worldName}'`)
    return true
  }

  /**
   * Build a snapshot from the player state as onboarding leaves it.
   *
   * Static because it touches no filesystem — it is a shape, not a read.
   *
   * `initial_game_time` is emitted only when the clock is truthy (Python's
   * `if initial_game_time:`), which for a mapping means non-empty as well as
   * non-null. A reset with the key absent leaves the current clock alone rather
   * than winding it to midnight of day zero.
   */
  static createInitialStateSnapshot(input: InitialStateInput): InitialStateSnapshot {
    const snapshot: InitialStateSnapshot = {
      starting_location: input.startingLocation,
      initial_stats: input.initialStats,
      initial_inventory: input.initialInventory,
      captured_at: utcIsoNow(),
    }

    if (input.initialGameTime && Object.keys(input.initialGameTime).length > 0) {
      snapshot.initial_game_time = input.initialGameTime
    }

    return snapshot
  }
}
