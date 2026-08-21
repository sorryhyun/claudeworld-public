/**
 * Player state (`worlds/{name}/player.yaml`) and stat definitions
 * (`worlds/{name}/stats.yaml`).
 *
 * Ported from `backend/services/player_service.py`.
 *
 * `player.yaml` is the game's save file: location, turn counter, stats,
 * inventory and the in-world clock. It is read on every turn to build the
 * Action Manager's context, hence the same mtime cache the other world files
 * use.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { MtimeCache, WorldService } from './world-service'

// ============================================================================
// Types
// ============================================================================

/**
 * The in-world clock. Written to `player.yaml` as:
 *
 * ```yaml
 * game_time:
 *   day: 1
 *   hour: 8
 *   minute: 0
 * ```
 *
 * A copy of this object is frozen onto each message as `game_time_snapshot`,
 * so the UI can show when a line was spoken rather than the clock's value now.
 */
export interface GameTime {
  hour: number
  minute: number
  day: number
}

/** Where a freshly created world starts: 08:00 on day 1. */
export const DEFAULT_GAME_TIME: GameTime = { hour: 8, minute: 0, day: 1 }

/**
 * `player.yaml`. A newly created world (`worlds/asdf/player.yaml`) looks like:
 *
 * ```yaml
 * current_location: null
 * effects: []
 * game_time:
 *   day: 1
 *   hour: 8
 *   minute: 0
 * inventory: []
 * recent_actions: []
 * stats: {}
 * turn_count: 0
 * ```
 *
 * `equipment` and `flags` are absent from worlds created before those fields
 * existed, which is why every field is defaulted on read.
 */
export interface PlayerState {
  /** Location *folder* name, not display name. `null` during onboarding. */
  currentLocation: string | null
  turnCount: number
  stats: Record<string, number>
  /**
   * Inventory in reference format — `{item_id, quantity, instance_properties}`
   * entries pointing at templates under `items/`. Left untyped because the
   * item template layer is not ported here; entries round-trip verbatim.
   */
  inventory: Record<string, unknown>[]
  effects: Record<string, unknown>[]
  recentActions: Record<string, unknown>[]
  gameTime: GameTime
  /** Slot name -> item id, `null` for an empty slot. */
  equipment: Record<string, string | null>
  /** Affordance / progression flags, e.g. `{ boss_defeated: true }`. */
  flags: Record<string, boolean>
}

/**
 * `stats.yaml`. Empty on a fresh world (`{derived: [], stats: []}`); the World
 * Seed Generator fills it in. Entries are left as raw records because only the
 * clamping rules (not ported) read their shape.
 */
export interface StatDefinitions {
  stats: Record<string, unknown>[]
  derived: Record<string, unknown>[]
}

// ============================================================================
// Helpers
// ============================================================================

function asRecordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  )
}

function asMapping(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseGameTime(value: unknown): GameTime {
  const raw = asMapping(value)
  return {
    hour: asNumber(raw.hour, DEFAULT_GAME_TIME.hour),
    minute: asNumber(raw.minute, DEFAULT_GAME_TIME.minute),
    day: asNumber(raw.day, DEFAULT_GAME_TIME.day),
  }
}

function parseStats(value: unknown): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const [key, raw] of Object.entries(asMapping(value))) {
    if (typeof raw === 'number' && Number.isFinite(raw)) stats[key] = raw
  }
  return stats
}

function parseEquipment(value: unknown): Record<string, string | null> {
  const equipment: Record<string, string | null> = {}
  for (const [slot, raw] of Object.entries(asMapping(value))) {
    equipment[slot] = typeof raw === 'string' ? raw : null
  }
  return equipment
}

function parseFlags(value: unknown): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(asMapping(value))) {
    if (typeof raw === 'boolean') flags[key] = raw
  }
  return flags
}

/** State of a world whose `player.yaml` is present but empty. */
function emptyPlayerState(): PlayerState {
  return {
    currentLocation: null,
    turnCount: 0,
    stats: {},
    inventory: [],
    effects: [],
    recentActions: [],
    gameTime: { ...DEFAULT_GAME_TIME },
    equipment: {},
    flags: {},
  }
}

/**
 * Serialise the way PyYAML's `dump(..., allow_unicode=True,
 * default_flow_style=False)` does: block style, keys sorted, no escaping of
 * non-ASCII. Matching it keeps files written by either backend diff-clean.
 */
function dumpYaml(data: unknown): string {
  return stringifyYaml(data, { sortMapEntries: true })
}

// ============================================================================
// Service
// ============================================================================

export class PlayerService {
  private readonly worlds: WorldService
  private readonly cache: MtimeCache

  /**
   * @param worldsDir Root of the `worlds/` tree.
   * @param cache Share a {@link MtimeCache} with other services, or omit for
   *   a private one (which is what makes tests order-independent).
   */
  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
    this.cache = cache
  }

  private playerFile(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), 'player.yaml')
  }

  /** Drop this service's cached reads. */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Read `player.yaml`. `null` only when the file is absent — an empty or
   * malformed file yields a default state so a broken save still opens.
   */
  loadPlayerState(worldName: string): PlayerState | null {
    return this.cache.read(this.playerFile(worldName), (raw): PlayerState => {
      let data: unknown
      try {
        data = parseYaml(raw)
      } catch (error) {
        console.warn(`[player-service] Malformed player.yaml for '${worldName}': ${String(error)}`)
        return emptyPlayerState()
      }

      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return emptyPlayerState()
      }

      const fields = data as Record<string, unknown>
      return {
        currentLocation: typeof fields.current_location === 'string' ? fields.current_location : null,
        turnCount: asNumber(fields.turn_count, 0),
        stats: parseStats(fields.stats),
        inventory: asRecordList(fields.inventory),
        effects: asRecordList(fields.effects),
        recentActions: asRecordList(fields.recent_actions),
        gameTime: parseGameTime(fields.game_time),
        equipment: parseEquipment(fields.equipment),
        flags: parseFlags(fields.flags),
      }
    })
  }

  /**
   * Write `player.yaml` and invalidate the cached read.
   *
   * `recentActions` is truncated to the last 10 entries — the file is context
   * material, and older actions live in `history.md` instead.
   *
   * Python additionally funnels the inventory through
   * `ItemService.to_reference_format`, which materialises missing item
   * templates under `items/`. That layer is not ported here, so the inventory
   * is written exactly as given: callers must hand over reference-format
   * entries.
   */
  savePlayerState(worldName: string, state: PlayerState): void {
    const worldPath = this.worlds.getWorldPath(worldName)
    mkdirSync(worldPath, { recursive: true })

    const data = {
      current_location: state.currentLocation,
      turn_count: state.turnCount,
      stats: state.stats,
      inventory: state.inventory,
      effects: state.effects,
      recent_actions: state.recentActions.slice(-10),
      game_time: state.gameTime,
      equipment: state.equipment,
      flags: state.flags,
    }

    const playerFile = join(worldPath, 'player.yaml')
    writeFileSync(playerFile, dumpYaml(data), 'utf-8')
    this.cache.invalidate(playerFile)
  }

  /**
   * Read `stats.yaml`. Missing or malformed yields the empty shape, which is
   * also what a world looks like before the World Seed Generator has run.
   */
  loadStatDefinitions(worldName: string): StatDefinitions {
    const statsFile = join(this.worlds.getWorldPath(worldName), 'stats.yaml')

    const parsed = this.cache.read(statsFile, (raw): StatDefinitions => {
      let data: unknown
      try {
        data = parseYaml(raw)
      } catch (error) {
        console.warn(`[player-service] Malformed stats.yaml for '${worldName}': ${String(error)}`)
        return { stats: [], derived: [] }
      }

      const fields = asMapping(data)
      return { stats: asRecordList(fields.stats), derived: asRecordList(fields.derived) }
    })

    return parsed ?? { stats: [], derived: [] }
  }
}
