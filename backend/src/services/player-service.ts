/**
 * Player state (`player.json` — the game's save file) and stat definitions
 * (`stats.json`). Read on every turn to build the Action Manager's context,
 * hence the same mtime cache the other world files use.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ItemService } from './item-service'
import { dumpJson, MtimeCache, PLAYER_STATE_FILE, STAT_DEFINITIONS_FILE, WorldService } from './world-service'
import { applyStatChanges } from '../domain/player-rules'
import type {
  InventoryEntry,
  StatDefinition as RuleStatDefinition,
  StatDefinitions as RuleStatDefinitions,
} from '../domain/player-rules'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('PlayerService')

/** A copy is frozen onto each message as `game_time_snapshot`, so the UI shows
 * when a line was spoken rather than the clock's value now. */
export interface GameTime {
  hour: number
  minute: number
  day: number
}

export const DEFAULT_GAME_TIME: GameTime = { hour: 8, minute: 0, day: 1 }

/** `player.json`, snake_case on disk. `equipment` and `flags` are absent from
 * older worlds, hence the defaults on read. */
export interface PlayerState {
  /** Location *folder* name, not display name. `null` during onboarding. */
  currentLocation: string | null
  turnCount: number
  stats: Record<string, number>
  /** References into `items/`; older worlds hold the legacy embedded form, and
   * {@link savePlayerState} rewrites whatever it is given into references. */
  inventory: InventoryEntry[]
  effects: Record<string, unknown>[]
  recentActions: Record<string, unknown>[]
  gameTime: GameTime
  /** Slot name -> item id, `null` for an empty slot. */
  equipment: Record<string, string | null>
  /** Affordance / progression flags, e.g. `{ boss_defeated: true }`. */
  flags: Record<string, boolean>
}

export interface StatDefinitions {
  stats: Record<string, unknown>[]
  derived: Record<string, unknown>[]
}

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

// Non-numeric values are dropped: these feed `applyStatChanges`, where a string
// would concatenate instead of adding.
function parseStats(value: unknown): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const [key, raw] of Object.entries(asMapping(value))) {
    if (typeof raw === 'number' && Number.isFinite(raw)) stats[key] = raw
  }
  return stats
}

// A widening cast; entries are validated in `InventoryItem.fromReference`.
function asInventoryEntries(value: unknown): InventoryEntry[] {
  return asRecordList(value) as InventoryEntry[]
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

// A cast, not a validation: `buildStatMap` throws on a nameless entry, and
// pre-empting that would silently un-clamp the stat.
function asRuleDefinitions(definitions: StatDefinitions): RuleStatDefinitions {
  return { ...definitions, stats: definitions.stats as RuleStatDefinition[] }
}

export class PlayerService {
  private readonly worlds: WorldService
  private readonly items: ItemService
  private readonly cache: MtimeCache

  // A shared {@link MtimeCache}, or a private one — which is what makes tests
  // order-independent.
  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
    this.items = new ItemService(worldsDir, cache)
    this.cache = cache
  }

  private playerFile(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), PLAYER_STATE_FILE)
  }

  clearCache(): void {
    this.cache.clear()
    this.items.clearCache()
  }

  /** `null` only when the file is absent; a malformed one yields a default
   * state, so a broken save still opens. */
  loadPlayerState(worldName: string): PlayerState | null {
    return this.cache.read(this.playerFile(worldName), (raw): PlayerState => {
      let data: unknown
      try {
        data = JSON.parse(raw)
      } catch (error) {
        logger.warning(`Malformed player.json for '${worldName}': ${String(error)}`)
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
        inventory: asInventoryEntries(fields.inventory),
        effects: asRecordList(fields.effects),
        recentActions: asRecordList(fields.recent_actions),
        gameTime: parseGameTime(fields.game_time),
        equipment: parseEquipment(fields.equipment),
        flags: parseFlags(fields.flags),
      }
    })
  }

  /**
   * Write `player.json` and invalidate the cached read. The inventory goes
   * through `ItemService.toReferenceFormat`, which both strips each entry to a
   * reference and *creates* the template for any item lacking one — an item an
   * agent invented this turn becomes durable here or not at all.
   * `recentActions` is truncated to 10; older actions live in `history.md`.
   */
  savePlayerState(worldName: string, state: PlayerState): void {
    const worldPath = this.worlds.getWorldPath(worldName)
    // Ahead of `toReferenceFormat`, which writes into `items/` beneath it.
    mkdirSync(worldPath, { recursive: true })

    const data = {
      current_location: state.currentLocation,
      turn_count: state.turnCount,
      stats: state.stats,
      inventory: this.items.toReferenceFormat(worldName, state.inventory),
      effects: state.effects,
      recent_actions: state.recentActions.slice(-10),
      game_time: state.gameTime,
      equipment: state.equipment,
      flags: state.flags,
    }

    const playerFile = join(worldPath, PLAYER_STATE_FILE)
    writeFileSync(playerFile, dumpJson(data), 'utf-8')
    this.cache.invalidate(playerFile)
  }

  /** Each reference resolved against its template — what `/state` and the
   * Action Manager's context use, never the raw id-and-count entries. */
  getResolvedInventory(worldName: string): InventoryEntry[] {
    const state = this.loadPlayerState(worldName)
    // Skip the template load; an empty inventory is the onboarding common case.
    if (!state || state.inventory.length === 0) return []

    return this.items.resolveInventory(worldName, state.inventory)
  }

  /** Missing or malformed yields the empty shape. */
  loadStatDefinitions(worldName: string): StatDefinitions {
    const statsFile = join(this.worlds.getWorldPath(worldName), STAT_DEFINITIONS_FILE)

    const parsed = this.cache.read(statsFile, (raw): StatDefinitions => {
      let data: unknown
      try {
        data = JSON.parse(raw)
      } catch (error) {
        logger.warning(`Malformed stats.json for '${worldName}': ${String(error)}`)
        return { stats: [], derived: [] }
      }

      const fields = asMapping(data)
      return { stats: asRecordList(fields.stats), derived: asRecordList(fields.derived) }
    })

    return parsed ?? { stats: [], derived: [] }
  }

  /** The `mkdir -p` is not redundant: stats can be persisted before anything
   * else has created the world directory. */
  saveStatDefinitions(worldName: string, definitions: StatDefinitions): void {
    const worldPath = this.worlds.getWorldPath(worldName)
    mkdirSync(worldPath, { recursive: true })

    const statsFile = join(worldPath, STAT_DEFINITIONS_FILE)
    writeFileSync(statsFile, dumpJson(definitions), 'utf-8')

    // Read through the mtime cache, so a same-millisecond write would otherwise
    // stay invisible.
    this.cache.invalidate(statsFile)
  }

  /** Clamping stays in `applyStatChanges`, so the filesystem and database paths
   * cannot disagree about a stat's bounds. `{}` when there is no `player.json`. */
  updateStats(worldName: string, changes: Record<string, number>): Record<string, number> {
    const state = this.loadPlayerState(worldName)
    if (!state) return {}

    state.stats = applyStatChanges(
      state.stats,
      changes,
      asRuleDefinitions(this.loadStatDefinitions(worldName)),
    )

    this.savePlayerState(worldName, state)
    return state.stats
  }
}
