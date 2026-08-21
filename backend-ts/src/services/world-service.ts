/**
 * The world filesystem — the primary source of world data.
 *
 * Ported from `backend/services/world_service.py` (plus the two
 * `consolidated_history.md` readers from
 * `backend/services/history_compression_service.py`, which live here because
 * they are pure filesystem reads of the same world directory).
 *
 * The database is a cache; `worlds/{name}/` is the truth. Everything the
 * Action Manager's context is built from is read through this module.
 *
 * The worlds directory is an explicit constructor argument rather than a
 * `settings` import so this layer stays testable against a temp directory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { getLogger } from '../infrastructure/logging/logger'
import { HttpError } from '../http/errors'

const logger = getLogger('WorldService')

// ============================================================================
// mtime cache
// ============================================================================

interface CacheEntry {
  mtimeMs: number
  value: unknown
}

/**
 * Path-keyed parse cache invalidated by file mtime.
 *
 * This *is* the hot-reload mechanism: an author editing `lore.md` between
 * turns must be picked up on the next read with no restart, so every read
 * stats the file. Replacing this with a plain memo would silently freeze world
 * data for the lifetime of the process.
 *
 * Unlike the Python original the cache is owned by a service instance instead
 * of living at module scope, so a test can construct a service and get a cold
 * cache instead of inheriting whatever an earlier test left behind. Pass a
 * shared instance to the constructor when two services should share one.
 */
export class MtimeCache {
  private readonly entries = new Map<string, CacheEntry>()

  /**
   * Return the cached parse of `filePath`, re-running `parse` when the file's
   * mtime moved. `null` means the file is gone (and its entry is dropped).
   *
   * `parse` must not throw — callers own their own error handling so they can
   * log a file-specific warning. The `as T` cast is sound because each path is
   * only ever read with one parse shape.
   */
  read<T>(filePath: string, parse: (raw: string) => T): T | null {
    let mtimeMs: number
    try {
      mtimeMs = statSync(filePath).mtimeMs
    } catch {
      this.entries.delete(filePath)
      return null
    }

    // Python compares `cached_mtime >= current_mtime`, which treats a file
    // restored from an older copy as fresh. Exact equality reloads instead.
    const cached = this.entries.get(filePath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.value as T

    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch {
      this.entries.delete(filePath)
      return null
    }

    const value = parse(raw)
    this.entries.set(filePath, { mtimeMs, value })
    return value
  }

  /** Drop one path's entry — used after this process writes the file. */
  invalidate(filePath: string): void {
    this.entries.delete(filePath)
  }

  /**
   * Drop every entry under a directory — used after this process deletes a
   * world.
   *
   * Python names the three caches it knows about (`world_service.py:441-447`)
   * and leaks whatever the location and player services cached for the same
   * world. One prefix sweep covers all of them. It is belt-and-braces rather
   * than load-bearing: a `stat` of a deleted file already drops its entry on
   * the next read.
   */
  invalidatePrefix(dirPath: string): void {
    const prefix = dirPath.endsWith(sep) ? dirPath : `${dirPath}${sep}`
    for (const key of this.entries.keys()) {
      if (key === dirPath || key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * `world.yaml`. On disk (from `worlds/asdf/world.yaml`):
 *
 * ```yaml
 * created_at: '2026-08-06T04:14:54.918838Z'
 * genre: null
 * language: ko
 * name: asdf
 * owner_id: admin
 * phase: onboarding
 * settings:
 *   allow_death: true
 *   difficulty: normal
 *   narrator_style: atmospheric
 * theme: null
 * updated_at: '2026-08-06T04:14:54.918838Z'
 * user_name: 손님
 * ```
 *
 * `pending_phase` is absent unless a deferred phase change is queued — the
 * writer only emits the key when it is set.
 */
export interface WorldConfig {
  name: string
  ownerId: string | null
  /** Player's display name inside the world (`손님` above), not a user id. */
  userName: string | null
  /** `"en" | "ko"` in practice, but not validated — kept as written. */
  language: string
  genre: string | null
  theme: string | null
  phase: string
  createdAt: Date
  updatedAt: Date
  settings: Record<string, unknown>
  /** Deferred phase change, applied once the current agent turn ends. */
  pendingPhase: string | null
}

// ============================================================================
// Helpers
// ============================================================================

/** `## [subtitle]` headings in `consolidated_history.md`. */
const SUBTITLE_PATTERN = /^##\s*\[([^\]]+)\]/gm

/**
 * Characters a world name may contribute to a path.
 *
 * Mirrors Python's `c.isalnum() or c in "._- "`, which is Unicode-aware — a
 * Korean world name survives intact, so `\p{L}\p{N}` rather than `[a-z0-9]`.
 */
const UNSAFE_NAME_CHARS = /[^\p{L}\p{N}._\- ]/gu

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Parse a `created_at` / `updated_at` value.
 *
 * These are written by Python's `datetime.utcnow().isoformat() + "Z"`, so a
 * value carrying no zone designator is still UTC; we append one rather than
 * letting JS reinterpret it in the host timezone. The `yaml` parser hands back
 * a `Date` directly when the timestamp was written unquoted.
 */
function parseTimestamp(value: unknown, fallback: Date): Date {
  if (value instanceof Date) return value
  if (typeof value !== 'string' || value.trim() === '') return fallback

  const trimmed = value.trim()
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
  const parsed = new Date(hasZone ? trimmed : `${trimmed}Z`)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

/**
 * Write a `created_at` / `updated_at` value.
 *
 * Python writes `datetime.utcnow().isoformat() + "Z"` — microsecond
 * precision, zone appended by hand. `toISOString()` is the same string at
 * millisecond precision, and `datetime.fromisoformat` accepts either width, so
 * a file written here still loads in the Python backend.
 *
 * The one visible difference is quoting: PyYAML emits `'2026-…Z'` because it
 * resolves bare timestamps to `datetime` under YAML 1.1, while the `yaml`
 * package follows YAML 1.2 and leaves it bare. Both backends read both forms —
 * `load_world_config` branches on `isinstance(str)` and {@link parseTimestamp}
 * branches on `instanceof Date` — so the divergence is cosmetic.
 */
function utcStamp(when: Date): string {
  return when.toISOString()
}

/**
 * Serialise the way PyYAML's `dump(..., allow_unicode=True,
 * default_flow_style=False)` does: block style, keys sorted, non-ASCII left
 * unescaped. Matching it keeps a file written by either backend diff-clean.
 *
 * Exported because `location-storage.ts` rewrites `_index.yaml` under the same
 * rules; `player-service.ts` predates this and keeps its own copy.
 */
export function dumpYaml(data: unknown): string {
  return stringifyYaml(data, { sortMapEntries: true })
}

// ============================================================================
// Service
// ============================================================================

export class WorldService {
  private readonly worldsDir: string
  private readonly cache: MtimeCache

  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worldsDir = worldsDir
    this.cache = cache
  }

  /** Directory of a world, with the name sanitised for filesystem use. */
  getWorldPath(worldName: string): string {
    return join(this.worldsDir, worldName.replace(UNSAFE_NAME_CHARS, '').trim())
  }

  /** A world counts as existing only once `world.yaml` is on disk. */
  worldExists(worldName: string): boolean {
    try {
      return statSync(join(this.getWorldPath(worldName), 'world.yaml')).isFile()
    } catch {
      return false
    }
  }

  /** Drop this service's cached reads. */
  clearCache(): void {
    this.cache.clear()
  }

  // --------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------

  /** Create `worlds/` if this is the first world on a fresh install. */
  ensureWorldsDir(): void {
    mkdirSync(this.worldsDir, { recursive: true })
  }

  /**
   * Build a world's whole directory tree and return its freshly read config.
   *
   * Every file listed here is created eagerly, empty but well-formed, because
   * the rest of the port reads them without existence checks: `stats.yaml` and
   * `player.yaml` are filled in by the World Seed Generator, `lore.md` and
   * `history.md` carry their headings from turn one, and
   * `locations/_index.yaml` must parse as `{locations: {}}` rather than be
   * absent. `agents/`, `maps/` and `items/` stay empty until something writes
   * into them. Mirrors `world_service.py:64-141`.
   */
  createWorld(
    name: string,
    ownerId: string,
    userName: string | null = null,
    language = 'en',
  ): WorldConfig {
    this.ensureWorldsDir()
    const worldPath = this.getWorldPath(name)

    if (existsSync(worldPath)) {
      // Python raises `ValueError` and its only caller — `worlds.py:169-172` —
      // catches it and re-raises exactly this 400 with `str(e)` as the detail,
      // so throwing the HTTP error here changes nothing on the wire and saves
      // the handler a translation step. Same rationale as `domain/errors.ts`.
      throw new HttpError(400, `World '${name}' already exists`)
    }

    mkdirSync(worldPath, { recursive: true })
    for (const subdirectory of ['agents', 'locations', 'maps', 'items']) {
      mkdirSync(join(worldPath, subdirectory))
    }

    const now = utcStamp(new Date())

    writeFileSync(
      join(worldPath, 'world.yaml'),
      dumpYaml({
        name,
        owner_id: ownerId,
        user_name: userName,
        language,
        genre: null,
        theme: null,
        phase: 'onboarding',
        created_at: now,
        updated_at: now,
        settings: { allow_death: true, difficulty: 'normal', narrator_style: 'atmospheric' },
      }),
      'utf-8',
    )

    writeFileSync(join(worldPath, 'stats.yaml'), dumpYaml({ stats: [], derived: [] }), 'utf-8')

    // `equipment` and `flags` are deliberately absent: Python does not write
    // them either (`world_service.py:116-124`) and `PlayerService` defaults
    // them on read, so a new world and an old one parse identically.
    writeFileSync(
      join(worldPath, 'player.yaml'),
      dumpYaml({
        current_location: null,
        turn_count: 0,
        stats: {},
        inventory: [],
        effects: [],
        recent_actions: [],
        game_time: { hour: 8, minute: 0, day: 1 },
      }),
      'utf-8',
    )

    writeFileSync(join(worldPath, 'lore.md'), '# World Lore\n\n*To be written...*\n', 'utf-8')
    writeFileSync(join(worldPath, 'locations', '_index.yaml'), dumpYaml({ locations: {} }), 'utf-8')
    writeFileSync(join(worldPath, 'history.md'), '# World History\n\n')

    logger.info(`Created world '${name}' at ${worldPath}`)

    const config = this.loadWorldConfig(name)
    // Unreachable — we just wrote the file this reads. Python returns
    // `Optional[WorldConfig]` here and every caller dereferences it anyway.
    if (!config) throw new Error(`World '${name}' was created but world.yaml did not parse`)
    return config
  }

  /**
   * Every world on disk, newest first, optionally narrowed to one owner.
   *
   * A directory without a `world.yaml` is not a world — half-deleted trees and
   * stray folders are skipped rather than reported as broken worlds. Worlds
   * are keyed by *directory* name, which is the sanitised form of the name the
   * player typed. Mirrors `world_service.py:414-429`.
   */
  listWorlds(ownerId: string | null = null): WorldConfig[] {
    let entries: Dirent[]
    try {
      entries = readdirSync(this.worldsDir, { withFileTypes: true })
    } catch {
      return []
    }

    const worlds: WorldConfig[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!existsSync(join(this.worldsDir, entry.name, 'world.yaml'))) continue

      const config = this.loadWorldConfig(entry.name)
      if (!config) continue
      if (ownerId === null || config.ownerId === ownerId) worlds.push(config)
    }

    // Most recently updated first. Both languages sort stably, so worlds
    // sharing an `updated_at` keep directory-listing order.
    return worlds.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  /**
   * Delete a world's whole directory. `false` when there was nothing to
   * delete, which is how the route distinguishes "gone" from "never existed".
   *
   * The database rows are deleted separately, by the caller, before this runs
   * (`worlds.py:404-407`) — the filesystem is the last thing to go.
   */
  deleteWorld(worldName: string): boolean {
    const worldPath = this.getWorldPath(worldName)
    if (!existsSync(worldPath)) return false

    rmSync(worldPath, { recursive: true, force: true })
    this.cache.invalidatePrefix(worldPath)

    logger.info(`Deleted world '${worldName}'`)
    return true
  }

  /**
   * Load a world, creating it if it is not there.
   *
   * The onboarding tools call this on every turn rather than tracking whether
   * they have created the world yet (`onboarding_tools.py:211`), so the common
   * case is the cheap one: an existence check and a cached config read.
   */
  ensureWorldExists(worldName: string, ownerId = 'system'): WorldConfig {
    if (!this.worldExists(worldName)) return this.createWorld(worldName, ownerId)

    const config = this.loadWorldConfig(worldName)
    // `world.yaml` exists but does not parse. Python returns None here
    // (`world_service.py:471`) and lets the caller fail on the attribute
    // access; failing with the reason is more useful and equally fatal.
    if (!config) throw new Error(`World '${worldName}' exists but its world.yaml did not parse`)
    return config
  }

  // --------------------------------------------------------------------
  // world.yaml
  // --------------------------------------------------------------------

  /**
   * Read `world.yaml`. `null` when the world (or its config) is missing or
   * unparseable — a half-built world must still open rather than 500.
   */
  loadWorldConfig(worldName: string): WorldConfig | null {
    const configFile = join(this.getWorldPath(worldName), 'world.yaml')

    return this.cache.read(configFile, (raw): WorldConfig | null => {
      let data: unknown
      try {
        data = parseYaml(raw)
      } catch (error) {
        logger.warning(`Malformed world.yaml for '${worldName}': ${String(error)}`)
        return null
      }

      if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
      const fields = data as Record<string, unknown>

      const now = new Date()
      const createdAt = parseTimestamp(fields.created_at, now)

      return {
        name: asString(fields.name) ?? worldName,
        ownerId: asString(fields.owner_id),
        userName: asString(fields.user_name),
        language: asString(fields.language) ?? 'en',
        genre: asString(fields.genre),
        theme: asString(fields.theme),
        phase: asString(fields.phase) ?? 'onboarding',
        createdAt,
        // A world written before `updated_at` existed falls back to creation.
        updatedAt: parseTimestamp(fields.updated_at, createdAt),
        settings: asRecord(fields.settings),
        pendingPhase: asString(fields.pending_phase),
      }
    })
  }

  /**
   * Rewrite `world.yaml` whole from a config object.
   *
   * `created_at` is carried through from the config; `updated_at` is *always*
   * restamped, even when nothing else changed (`world_service.py:232`), which
   * is what makes {@link listWorlds}'s ordering mean "recently touched".
   */
  saveWorldConfig(name: string, config: WorldConfig): void {
    const configFile = join(this.getWorldPath(name), 'world.yaml')

    const data: Record<string, unknown> = {
      name: config.name,
      owner_id: config.ownerId,
      user_name: config.userName,
      language: config.language,
      genre: config.genre,
      theme: config.theme,
      phase: config.phase,
      created_at: utcStamp(config.createdAt),
      updated_at: utcStamp(new Date()),
      settings: config.settings,
    }

    // `pending_phase` is emitted only when truthy (`world_service.py:237-238`),
    // and dropping the key is the whole clearing mechanism: nothing ever
    // *removes* a pending phase, {@link applyPendingPhase} just nulls the
    // field and saves. Persist it unconditionally and the value survives its
    // own application — `polling.py:221` keeps reporting it and the frontend's
    // "Enter World" banner (`OnboardingPage.tsx:151`) never goes away.
    if (config.pendingPhase) data.pending_phase = config.pendingPhase

    writeFileSync(configFile, dumpYaml(data), 'utf-8')
    this.cache.invalidate(configFile)
  }

  /**
   * Promote a queued phase change and clear it. `true` when one was pending.
   *
   * The `complete` tool sets `pending_phase` mid-turn; applying it there would
   * swap the agent's own tool set out from under it, so the change is deferred
   * to the end of the turn (`worlds.py:728`) and applied here.
   */
  applyPendingPhase(worldName: string): boolean {
    const config = this.loadWorldConfig(worldName)
    if (!config?.pendingPhase) return false

    const oldPhase = config.phase
    config.phase = config.pendingPhase
    config.pendingPhase = null
    this.saveWorldConfig(worldName, config)

    logger.info(`Applied pending phase change for '${worldName}': ${oldPhase} -> ${config.phase}`)
    return true
  }

  // --------------------------------------------------------------------
  // lore.md
  // --------------------------------------------------------------------

  /** Read `lore.md`, or `''` when the world has none yet. */
  loadLore(worldName: string): string {
    const loreFile = join(this.getWorldPath(worldName), 'lore.md')
    return this.cache.read(loreFile, (raw) => raw) ?? ''
  }

  /**
   * Replace `lore.md` wholesale — the World Seed Generator writes it once and
   * the `update_lore` tool rewrites it in full thereafter, so there is no
   * append path here.
   */
  saveLore(worldName: string, lore: string): void {
    const loreFile = join(this.getWorldPath(worldName), 'lore.md')
    writeFileSync(loreFile, lore, 'utf-8')
    this.cache.invalidate(loreFile)
  }

  // --------------------------------------------------------------------
  // history.md
  // --------------------------------------------------------------------

  /** Read `history.md`, or `''` when nothing has been recorded yet. */
  loadHistory(worldName: string): string {
    const historyFile = join(this.getWorldPath(worldName), 'history.md')
    return this.cache.read(historyFile, (raw) => raw) ?? ''
  }

  /**
   * Append a `## Turn {turn} - {location}` entry to `history.md`.
   *
   * The suffix check guards against the model calling `travel` twice in one
   * turn, which would otherwise write the same summary twice. It compares only
   * against the tail of the file, so a summary that legitimately repeats an
   * earlier one — or that happens to be a suffix of the previous entry — is
   * dropped; that is the Python behaviour, reproduced deliberately.
   */
  addHistoryEntry(worldName: string, turn: number, locationName: string, summary: string): void {
    const historyFile = join(this.getWorldPath(worldName), 'history.md')

    let content: string
    try {
      content = readFileSync(historyFile, 'utf-8')
    } catch {
      content = '# World History\n\n'
    }

    if (content.trimEnd().endsWith(summary.trimEnd())) {
      logger.warning(
        `Duplicate history entry for '${worldName}' at Turn ${turn} - ${locationName}, skipping`,
      )
      return
    }

    writeFileSync(historyFile, `${content}\n## Turn ${turn} - ${locationName}\n${summary}\n`, 'utf-8')
    this.cache.invalidate(historyFile)
  }

  // --------------------------------------------------------------------
  // consolidated_history.md
  // --------------------------------------------------------------------

  /**
   * Read `consolidated_history.md` — compressed history sections, each under a
   * `## [subtitle]` heading. Uncached, matching Python: it is only read when
   * the `recall_history` tool fires, not on every turn.
   */
  loadConsolidatedHistory(worldName: string): string {
    try {
      return readFileSync(join(this.getWorldPath(worldName), 'consolidated_history.md'), 'utf-8')
    } catch {
      return ''
    }
  }

  /** Subtitles offered to the model in the `recall_history` tool description. */
  getHistorySubtitles(worldName: string): string[] {
    const content = this.loadConsolidatedHistory(worldName)
    if (!content) return []

    const subtitles: string[] = []
    for (const match of content.matchAll(SUBTITLE_PATTERN)) {
      if (match[1] !== undefined) subtitles.push(match[1])
    }
    return subtitles
  }

  /** Body of one compressed section, or `null` when the subtitle is unknown. */
  getHistoryBySubtitle(worldName: string, subtitle: string): string | null {
    const content = this.loadConsolidatedHistory(worldName)
    if (!content) return null

    const matches = [...content.matchAll(SUBTITLE_PATTERN)]
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i]
      if (match?.[1] !== subtitle || match.index === undefined) continue

      const start = match.index + match[0].length
      const next = matches[i + 1]
      const end = next?.index ?? content.length
      return content.slice(start, end).trim()
    }

    return null
  }
}
