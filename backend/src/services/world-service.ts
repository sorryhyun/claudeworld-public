/**
 * The world filesystem — the primary source of world data; the database is a
 * cache. The worlds directory is a constructor argument, not a `settings`
 * import, so this layer is testable against a temp directory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { getLogger } from '../infrastructure/logging/logger'
import { HttpError } from '../http/errors'

const logger = getLogger('WorldService')

interface CacheEntry {
  mtimeMs: number
  value: unknown
}

// Path-keyed parse cache invalidated by file mtime. This *is* the hot-reload
// mechanism: every read stats the file, and a plain memo would freeze world
// data for the life of the process.
export class MtimeCache {
  private readonly entries = new Map<string, CacheEntry>()

  /** `null` when the file is gone. `parse` must not throw. */
  read<T>(filePath: string, parse: (raw: string) => T): T | null {
    let mtimeMs: number
    try {
      mtimeMs = statSync(filePath).mtimeMs
    } catch {
      this.entries.delete(filePath)
      return null
    }

    // Exact equality, not `>=`: a file restored from an older copy must reload.
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

  invalidate(filePath: string): void {
    this.entries.delete(filePath)
  }

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

/** `world.yaml`. `pending_phase` is absent unless a change is queued. */
export interface WorldConfig {
  name: string
  ownerId: string | null
  /** Display name inside the world, not a user id. */
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

const SUBTITLE_PATTERN = /^##\s*\[([^\]]+)\]/gm

// Stripped from a world name before it contributes to a path. Unicode-aware
// (`\p{L}\p{N}`, not `[a-z0-9]`) so a Korean world name survives intact.
const UNSAFE_NAME_CHARS = /[^\p{L}\p{N}._\- ]/gu

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// A stored timestamp with no zone designator is still UTC; append one rather
// than letting JS reinterpret it in the host timezone.
function parseTimestamp(value: unknown, fallback: Date): Date {
  if (value instanceof Date) return value
  if (typeof value !== 'string' || value.trim() === '') return fallback

  const trimmed = value.trim()
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
  const parsed = new Date(hasZone ? trimmed : `${trimmed}Z`)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

function utcStamp(when: Date): string {
  return when.toISOString()
}

/** Block style, keys sorted, non-ASCII unescaped. `location-storage.ts` too. */
export function dumpYaml(data: unknown): string {
  return stringifyYaml(data, { sortMapEntries: true })
}

export class WorldService {
  private readonly worldsDir: string
  private readonly cache: MtimeCache

  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worldsDir = worldsDir
    this.cache = cache
  }

  getWorldPath(worldName: string): string {
    return join(this.worldsDir, worldName.replace(UNSAFE_NAME_CHARS, '').trim())
  }

  /** A world exists only once `world.yaml` is on disk. */
  worldExists(worldName: string): boolean {
    try {
      return statSync(join(this.getWorldPath(worldName), 'world.yaml')).isFile()
    } catch {
      return false
    }
  }

  clearCache(): void {
    this.cache.clear()
  }

  ensureWorldsDir(): void {
    mkdirSync(this.worldsDir, { recursive: true })
  }

  /** Every file is created eagerly: the readers downstream skip existence checks. */
  createWorld(
    name: string,
    ownerId: string,
    userName: string | null = null,
    language = 'en',
  ): WorldConfig {
    this.ensureWorldsDir()
    const worldPath = this.getWorldPath(name)

    if (existsSync(worldPath)) {
      // Thrown as the HTTP error the route would translate it into anyway.
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

    // `equipment` and `flags` are deliberately absent: `PlayerService` defaults
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
    // Unreachable — we just wrote the file this reads.
    if (!config) throw new Error(`World '${name}' was created but world.yaml did not parse`)
    return config
  }

  /** Newest first. A directory without a `world.yaml` is skipped, not broken. */
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

    // Most recently updated first; the sort is stable, so worlds sharing an
    // `updated_at` keep directory-listing order.
    return worlds.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  /** `false` distinguishes "gone" from "never existed". Rows are deleted first. */
  deleteWorld(worldName: string): boolean {
    const worldPath = this.getWorldPath(worldName)
    if (!existsSync(worldPath)) return false

    rmSync(worldPath, { recursive: true, force: true })
    this.cache.invalidatePrefix(worldPath)

    logger.info(`Deleted world '${worldName}'`)
    return true
  }

  ensureWorldExists(worldName: string, ownerId = 'system'): WorldConfig {
    if (!this.worldExists(worldName)) return this.createWorld(worldName, ownerId)

    const config = this.loadWorldConfig(worldName)
    if (!config) throw new Error(`World '${worldName}' exists but its world.yaml did not parse`)
    return config
  }

  /** `null` when missing or unparseable — a half-built world must still open. */
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

  /** `updated_at` is *always* restamped; that is what orders {@link listWorlds}. */
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

    // Dropping the key is the whole clearing mechanism. Persist it
    // unconditionally and the value survives its own application.
    if (config.pendingPhase) data.pending_phase = config.pendingPhase

    writeFileSync(configFile, dumpYaml(data), 'utf-8')
    this.cache.invalidate(configFile)
  }

  /** Deferred here: applying mid-turn swaps the agent's tool set out from under it. */
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

  loadLore(worldName: string): string {
    const loreFile = join(this.getWorldPath(worldName), 'lore.md')
    return this.cache.read(loreFile, (raw) => raw) ?? ''
  }

  /** Replace `lore.md` wholesale; there is deliberately no append path. */
  saveLore(worldName: string, lore: string): void {
    const loreFile = join(this.getWorldPath(worldName), 'lore.md')
    writeFileSync(loreFile, lore, 'utf-8')
    this.cache.invalidate(loreFile)
  }

  loadHistory(worldName: string): string {
    const historyFile = join(this.getWorldPath(worldName), 'history.md')
    return this.cache.read(historyFile, (raw) => raw) ?? ''
  }

  /** The suffix check guards against `travel` firing twice in one turn. */
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

  /** Compressed history sections. Uncached: only `recall_history` reads it. */
  loadConsolidatedHistory(worldName: string): string {
    try {
      return readFileSync(join(this.getWorldPath(worldName), 'consolidated_history.md'), 'utf-8')
    } catch {
      return ''
    }
  }

  getHistorySubtitles(worldName: string): string[] {
    const content = this.loadConsolidatedHistory(worldName)
    if (!content) return []

    const subtitles: string[] = []
    for (const match of content.matchAll(SUBTITLE_PATTERN)) {
      if (match[1] !== undefined) subtitles.push(match[1])
    }
    return subtitles
  }

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
