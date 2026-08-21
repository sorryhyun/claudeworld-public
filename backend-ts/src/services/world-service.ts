/**
 * World filesystem reads — the primary source of world data.
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

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { getLogger } from '../infrastructure/logging/logger'

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

  // --------------------------------------------------------------------
  // lore.md
  // --------------------------------------------------------------------

  /** Read `lore.md`, or `''` when the world has none yet. */
  loadLore(worldName: string): string {
    const loreFile = join(this.getWorldPath(worldName), 'lore.md')
    return this.cache.read(loreFile, (raw) => raw) ?? ''
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
