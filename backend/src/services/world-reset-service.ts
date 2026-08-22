/**
 * The initial-state snapshot — `worlds/{name}/_initial.json`. Written once at
 * the end of onboarding, read only by the reset route.
 *
 * **A missing snapshot and an empty one are different things.** A world with no
 * file cannot be reset; a character who started with nothing has a file of
 * empty collections and resets fine — so `loadInitialState` returning `null`
 * means "absent or unreadable", never "empty".
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { MtimeCache, WorldService } from './world-service'
import type { InventoryEntry } from '../domain/player-rules'
import { getLogger } from '../infrastructure/logging/logger'
import type { GameTime } from './player-service'

const logger = getLogger('WorldResetService')

const INITIAL_STATE_FILE = '_initial.json'

/** Keys are the on-disk names. `initial_game_time` is absent when unset. */
export interface InitialStateSnapshot {
  /** Location *folder* name the character starts in. */
  starting_location: string
  initial_stats: Record<string, number>
  initial_inventory: InventoryEntry[]
  captured_at: string
  initial_game_time?: GameTime
}

export interface InitialStateInput {
  startingLocation: string
  initialStats: Record<string, number>
  initialInventory: InventoryEntry[]
  initialGameTime?: GameTime | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// UTC with a trailing `Z`; the last three digits are padding, never parsed.
function utcIsoNow(now: Date = new Date()): string {
  // `toISOString()` already ends in `Z`; drop it before padding.
  return `${now.toISOString().slice(0, -1)}000Z`
}

export class WorldResetService {
  private readonly worlds: WorldService

  /** `_initial.json` is read uncached; `cache` only reaches {@link WorldService}. */
  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
  }

  getInitialStatePath(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), INITIAL_STATE_FILE)
  }

  /** Whether the world can be reset at all. */
  hasInitialState(worldName: string): boolean {
    return existsSync(this.getInitialStatePath(worldName))
  }

  /** `null` when missing or unreadable; either way the world cannot be reset. */
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

    // Valid JSON of the wrong kind (a list, a string, `null`) is a corrupt
    // file, reported as a decode failure rather than handed to the caller.
    if (!isRecord(parsed)) {
      logger.error(`${INITIAL_STATE_FILE} for world '${worldName}' is not an object`)
      return null
    }

    return parsed as unknown as InitialStateSnapshot
  }

  /** Indented, non-ASCII unescaped, so a Korean location name stays legible. */
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
   * `initial_game_time` is emitted only for a non-empty clock: absent, a reset
   * leaves the clock alone rather than winding it to midnight of day zero.
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
