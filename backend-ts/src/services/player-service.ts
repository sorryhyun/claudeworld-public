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

import { ItemService } from './item-service'
import { MtimeCache, WorldService } from './world-service'
import { applyStatChanges } from '../domain/player-rules'
import type {
  InventoryEntry,
  StatDefinition as RuleStatDefinition,
  StatDefinitions as RuleStatDefinitions,
} from '../domain/player-rules'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('PlayerService')

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
   * entries pointing at templates under `items/`. Older worlds hold the legacy
   * embedded form instead; {@link InventoryEntry} covers both, and
   * {@link savePlayerState} rewrites whatever it is given into references.
   */
  inventory: InventoryEntry[]
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

/**
 * Read the `stats` mapping, dropping any non-numeric value.
 *
 * `src/domain/player-state-serializer.ts` is the sibling of this function, but
 * it is not a replacement: it is the JSON boundary for the `player_states`
 * *columns* and returns `Record<string, unknown>`, deliberately passing whatever
 * the blob held straight through. Stats read from `player.yaml` feed
 * `applyStatChanges`, which adds a delta to each one, so a string that reached
 * that far would concatenate instead of adding. The filter is what keeps this
 * layer's `Record<string, number>` honest and stays here for that reason.
 */
function parseStats(value: unknown): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const [key, raw] of Object.entries(asMapping(value))) {
    if (typeof raw === 'number' && Number.isFinite(raw)) stats[key] = raw
  }
  return stats
}

/**
 * Read the `inventory` list.
 *
 * The cast is a widening: {@link InventoryEntry} declares optional fields over
 * an `unknown` index signature, so every mapping in the file already satisfies
 * it structurally — the entries are validated where they are used, in
 * `InventoryItem.fromReference`, exactly as Python's untyped dicts are.
 */
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
 * non-ASCII, and sequence items flush with their key (`indentSeq: false` —
 * PyYAML writes `- x` where the `yaml` package would indent it two spaces).
 * Matching it keeps files written by either backend diff-clean.
 *
 * The one remaining divergence is where a plain scalar longer than 80
 * characters folds; see the note on `dumpYaml` in `item-service.ts`.
 */
function dumpYaml(data: unknown): string {
  return stringifyYaml(data, { sortMapEntries: true, indentSeq: false })
}

/**
 * Hand `stats.yaml` to the domain rules.
 *
 * The rules type declares `name: string` on every entry; this layer reads
 * whatever the file held, so the conversion is a cast, not a validation.
 * `buildStatMap` throws on an entry with no name — that is Python's `KeyError`
 * from `stat["name"]`, and pre-empting it here would silently un-clamp the stat.
 */
function asRuleDefinitions(definitions: StatDefinitions): RuleStatDefinitions {
  return { ...definitions, stats: definitions.stats as RuleStatDefinition[] }
}

// ============================================================================
// Service
// ============================================================================

export class PlayerService {
  private readonly worlds: WorldService
  private readonly items: ItemService
  private readonly cache: MtimeCache

  /**
   * @param worldsDir Root of the `worlds/` tree.
   * @param cache Share a {@link MtimeCache} with other services, or omit for
   *   a private one (which is what makes tests order-independent).
   */
  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
    // Python imports `ItemService` inside the two methods that need it, to
    // break an import cycle it never actually had; here it is a plain field.
    this.items = new ItemService(worldsDir, cache)
    this.cache = cache
  }

  private playerFile(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), 'player.yaml')
  }

  /** Drop this service's cached reads, item templates included. */
  clearCache(): void {
    this.cache.clear()
    this.items.clearCache()
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
        logger.warning(`Malformed player.yaml for '${worldName}': ${String(error)}`)
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
   * Write `player.yaml` and invalidate the cached read.
   *
   * The inventory is funnelled through `ItemService.toReferenceFormat` first
   * (`player_service.py:105`), which does two things at once: it strips each
   * entry down to `{item_id, quantity, instance_properties}` so the save file
   * cannot shadow an edited template with a stale name, and it *creates* the
   * template for any item that does not have one yet. The second half is why
   * this cannot be left to callers — an item an agent invented during the turn
   * becomes a durable definition here or not at all.
   *
   * `recentActions` is truncated to the last 10 entries — the file is context
   * material, and older actions live in `history.md` instead.
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

    const playerFile = join(worldPath, 'player.yaml')
    writeFileSync(playerFile, dumpYaml(data), 'utf-8')
    this.cache.invalidate(playerFile)
  }

  /**
   * The player's inventory with each reference resolved against its template:
   * full name, description and merged properties.
   *
   * This is what `/state` and `/state/inventory` return and what the Action
   * Manager's context describes — never the raw reference entries, which carry
   * only an id and a count.
   */
  getResolvedInventory(worldName: string): InventoryEntry[] {
    const state = this.loadPlayerState(worldName)
    // Python's `not state.inventory` short-circuits on the empty list, skipping
    // the template load entirely; the same skip is worth keeping, since an empty
    // inventory is the common case during onboarding.
    if (!state || state.inventory.length === 0) return []

    return this.items.resolveInventory(worldName, state.inventory)
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
        logger.warning(`Malformed stats.yaml for '${worldName}': ${String(error)}`)
        return { stats: [], derived: [] }
      }

      const fields = asMapping(data)
      return { stats: asRecordList(fields.stats), derived: asRecordList(fields.derived) }
    })

    return parsed ?? { stats: [], derived: [] }
  }

  /**
   * Write `stats.yaml`. Called once, by the World Seed Generator, after it has
   * decided what the world measures.
   *
   * The `mkdir -p` is Python's (`player_service.py:163`) and is not redundant:
   * stat definitions can be persisted before anything else has created the
   * world directory.
   */
  saveStatDefinitions(worldName: string, definitions: StatDefinitions): void {
    const worldPath = this.worlds.getWorldPath(worldName)
    mkdirSync(worldPath, { recursive: true })

    const statsFile = join(worldPath, 'stats.yaml')
    writeFileSync(statsFile, dumpYaml(definitions), 'utf-8')

    // Python has no cache on `load_stat_definitions` and so needs no
    // invalidation; this port reads `stats.yaml` through the mtime cache, so the
    // entry has to be dropped or a same-millisecond write stays invisible.
    this.cache.invalidate(statsFile)
  }

  /**
   * Apply `name -> delta` changes to the player's stats and persist them.
   *
   * Clamping is the domain layer's (`applyStatChanges`), so the filesystem and
   * database paths cannot disagree about what a stat's bounds mean. Returns the
   * new values, or `{}` when the world has no `player.yaml` — a caller that
   * cannot tell those apart is asking about a world that does not exist.
   */
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
