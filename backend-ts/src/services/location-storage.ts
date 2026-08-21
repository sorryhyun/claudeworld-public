/**
 * Locations under `worlds/{name}/locations/`.
 *
 * Ported from `backend/services/location_storage.py`, minus
 * `add_location_event`, which has no call site in the Python tree.
 *
 * A location is split across two places: its row in `locations/_index.yaml`
 * (map position, adjacency, discovery flag) and its own directory
 * (`description.md`, `events.md`). The index is authoritative for *which*
 * locations exist, but an entry whose directory is gone is treated as stale
 * and skipped — the world generator can leave the index ahead of the
 * filesystem, and the Action Manager must not be told about a place with no
 * description.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { dumpYaml, MtimeCache, WorldService } from './world-service'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('LocationStorage')

// ============================================================================
// Types
// ============================================================================

/**
 * One location. The index row is written as:
 *
 * ```yaml
 * locations:
 *   old_mill:
 *     adjacent: []
 *     is_discovered: true
 *     is_draft: false
 *     label: null
 *     name: The Old Mill
 *     position: [3, 4]
 * ```
 *
 * (`worlds/asdf/locations/_index.yaml` is still `locations: {}` — the world is
 * mid-onboarding — so this shape comes from the writer in
 * `location_storage.py::create_location`.)
 */
export interface LocationConfig {
  /** Directory name — the key used everywhere else in the codebase. */
  name: string
  /** Human-facing name from the index's `name` field. */
  displayName: string
  label: string | null
  /** `[x, y]` on the map grid. */
  position: [number, number]
  isDiscovered: boolean
  /** Directory names of neighbours reachable in one move. */
  adjacent: string[]
  /** Full text of `description.md`, or `''` when the file is missing. */
  description: string
  /** True while the location awaits enrichment by the Location Designer. */
  isDraft: boolean
}

// ============================================================================
// Helpers
// ============================================================================

function asMapping(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parsePosition(value: unknown): [number, number] {
  if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return [value[0], value[1]]
  }
  return [0, 0]
}

function parseAdjacent(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

// ============================================================================
// Service
// ============================================================================

export class LocationStorage {
  private readonly worlds: WorldService
  private readonly cache: MtimeCache

  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
    this.cache = cache
  }

  private locationsDir(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), 'locations')
  }

  private indexFile(worldName: string): string {
    return join(this.locationsDir(worldName), '_index.yaml')
  }

  /** Drop this service's cached reads. */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Raw `locations` mapping from `_index.yaml`, keyed by directory name.
   * `{}` when the index is missing or malformed.
   *
   * Python re-reads and re-parses this on every call. Caching it here is safe
   * because invalidation is by mtime: an externally edited index still takes
   * effect on the next read, and the per-turn context build stops paying for
   * a parse it already did.
   */
  private loadIndex(worldName: string): Record<string, unknown> {
    const indexFile = this.indexFile(worldName)

    const parsed = this.cache.read(indexFile, (raw): Record<string, unknown> => {
      try {
        return asMapping(asMapping(parseYaml(raw)).locations)
      } catch (error) {
        logger.warning(
          `Malformed locations/_index.yaml for '${worldName}': ${String(error)}`,
        )
        return {}
      }
    })

    return parsed ?? {}
  }

  private buildConfig(name: string, row: Record<string, unknown>, worldName: string): LocationConfig {
    const descriptionFile = join(this.locationsDir(worldName), name, 'description.md')
    const description = this.cache.read(descriptionFile, (raw) => raw) ?? ''

    return {
      name,
      displayName: typeof row.name === 'string' ? row.name : name,
      label: typeof row.label === 'string' ? row.label : null,
      position: parsePosition(row.position),
      // Undiscovered locations exist on the map but are hidden from the
      // player, so an index row missing the flag defaults to visible.
      isDiscovered: row.is_discovered !== false,
      adjacent: parseAdjacent(row.adjacent),
      description,
      isDraft: row.is_draft === true,
    }
  }

  /**
   * One location, or `null` when it has no index row or no directory on disk.
   */
  loadLocation(worldName: string, locationName: string): LocationConfig | null {
    const row = this.loadIndex(worldName)[locationName]
    if (row === undefined) return null

    // The directory is what carries the prose; an index row without one is a
    // stale entry left by a deleted location.
    if (!this.hasDirectory(worldName, locationName)) return null

    return this.buildConfig(locationName, asMapping(row), worldName)
  }

  /**
   * Every location that exists both in the index and on disk, keyed by
   * directory name. Insertion order follows the index file.
   */
  loadAllLocations(worldName: string): Record<string, LocationConfig> {
    const locations: Record<string, LocationConfig> = {}

    for (const [name, row] of Object.entries(this.loadIndex(worldName))) {
      if (!this.hasDirectory(worldName, name)) continue
      locations[name] = this.buildConfig(name, asMapping(row), worldName)
    }

    return locations
  }

  /** Contents of a location's `events.md`, trimmed. `''` when absent. */
  loadLocationEvents(worldName: string, locationName: string): string {
    try {
      return readFileSync(join(this.locationsDir(worldName), locationName, 'events.md'), 'utf-8').trim()
    } catch {
      return ''
    }
  }

  private hasDirectory(worldName: string, locationName: string): boolean {
    try {
      return statSync(join(this.locationsDir(worldName), locationName)).isDirectory()
    } catch {
      return false
    }
  }

  // --------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------

  /**
   * The *whole* `_index.yaml` document, read fresh for a read-modify-write.
   *
   * `null` means the file is absent, which is Python's falsy `{}` from
   * `_load_index` (`location_storage.py:19-27`) and the reason
   * {@link updateLocation} and {@link cleanupStaleEntries} decline to do
   * anything for a world that has no index yet.
   *
   * Two divergences from {@link loadIndex}, both deliberate. It returns the
   * top-level document rather than just `locations`, because anything else up
   * there has to survive the rewrite. And it does not swallow a YAML error:
   * degrading to `{}` here would make the next save replace a corrupt index
   * with an empty one, destroying every location in the world. Python has no
   * guard at that line for the same reason — the read path is forgiving
   * precisely because it never writes back.
   */
  private readIndexDocument(worldName: string): Record<string, unknown> | null {
    let raw: string
    try {
      raw = readFileSync(this.indexFile(worldName), 'utf-8')
    } catch {
      return null
    }

    // `yaml.safe_load(f) or {"locations": {}}` — an existing but empty index
    // is still an index, and gets rows added to it rather than being skipped.
    const parsed = parseYaml(raw) as unknown
    return parsed === null || parsed === undefined ? { locations: {} } : asMapping(parsed)
  }

  /**
   * Write `_index.yaml` whole and drop its cached parse.
   *
   * The invalidation is not housekeeping. {@link loadIndex} keys its cache on
   * mtime, and mtime has millisecond resolution here — a location created and
   * then immediately read, which is exactly what the world generator does,
   * can land inside the same millisecond and serve the pre-write index.
   */
  private saveIndex(worldName: string, document: Record<string, unknown>): void {
    const indexFile = this.indexFile(worldName)
    writeFileSync(indexFile, dumpYaml(document), 'utf-8')
    this.cache.invalidate(indexFile)
  }

  /**
   * Create a location: its directory, its two markdown files, and its row in
   * the index. Mirrors `location_storage.py:62-99`.
   *
   * Both halves matter — the row is what makes the location *exist*, and the
   * directory is what stops it being pruned as stale by the read paths and by
   * {@link cleanupStaleEntries}.
   *
   * `isDraft` marks a location the World Seed Generator sketched but the
   * Location Designer has not enriched yet; a draft is a real, enterable
   * place, so it is written `is_discovered: true` like any other.
   */
  createLocation(
    worldName: string,
    locationName: string,
    displayName: string,
    description: string,
    position: [number, number],
    adjacent: string[] = [],
    isDraft = false,
  ): void {
    const locationPath = join(this.locationsDir(worldName), locationName)
    // Python uses `mkdir(exist_ok=True)`, which fails when `locations/` is
    // missing. Every world built by `WorldService.createWorld` has it, so
    // `recursive` costs nothing and is forgiving of hand-made worlds.
    mkdirSync(locationPath, { recursive: true })

    const descriptionFile = join(locationPath, 'description.md')
    writeFileSync(descriptionFile, `# ${displayName}\n\n${description}\n`, 'utf-8')
    // Re-creating a location over an existing one has the same
    // same-millisecond problem as the index: a read that already missed this
    // file cached nothing, but one that read the old text did.
    this.cache.invalidate(descriptionFile)

    writeFileSync(join(locationPath, 'events.md'), `# Events at ${displayName}\n\n`, 'utf-8')

    const document = this.readIndexDocument(worldName) ?? {}
    const locations = asMapping(document.locations)
    locations[locationName] = {
      name: displayName,
      label: null,
      position: [...position],
      is_discovered: true,
      adjacent,
      is_draft: isDraft,
    }
    document.locations = locations
    this.saveIndex(worldName, document)

    logger.info(`Created location '${locationName}' in world '${worldName}' (isDraft=${isDraft})`)
  }

  /**
   * Patch an existing index row. `false` when the world has no index or the
   * location is not in it.
   *
   * Only the two mutable index fields are patchable: discovery (set when the
   * player first arrives) and the map label. Everything else about a location
   * is rewritten by {@link createLocation} or edited by hand.
   */
  updateLocation(
    worldName: string,
    locationName: string,
    changes: { isDiscovered?: boolean | null; label?: string | null },
  ): boolean {
    const document = this.readIndexDocument(worldName)
    if (document === null) return false

    const locations = asMapping(document.locations)
    const row = locations[locationName]
    if (row === undefined) {
      logger.warning(`Location '${locationName}' not found in world '${worldName}'`)
      return false
    }

    // `null` means "leave alone", not "clear". Python's parameters default to
    // None and are applied only when set (`location_storage.py:161-164`), and
    // `persistence_manager.py:388-394` depends on it: it forwards
    // `label=location.label` on every discovery change, and that label is None
    // for most rows.
    const updated = asMapping(row)
    if (changes.isDiscovered !== undefined && changes.isDiscovered !== null) {
      updated.is_discovered = changes.isDiscovered
    }
    if (changes.label !== undefined && changes.label !== null) updated.label = changes.label

    locations[locationName] = updated
    document.locations = locations
    this.saveIndex(worldName, document)

    logger.info(`Updated location '${locationName}' in world '${worldName}'`)
    return true
  }

  /**
   * Drop index rows whose directory is gone, returning the names removed.
   *
   * This is the counterpart to the stale rule the read paths enforce: they
   * *skip* a directory-less row on every read, this is what finally deletes
   * it. The world-reset route calls it (`worlds.py:525`) so a rebuilt world
   * does not carry the previous run's phantom locations in its map data.
   */
  cleanupStaleEntries(worldName: string): string[] {
    const document = this.readIndexDocument(worldName)
    if (document === null) return []

    const kept: Record<string, unknown> = {}
    const removed: string[] = []

    for (const [name, row] of Object.entries(asMapping(document.locations))) {
      if (this.hasDirectory(worldName, name)) {
        kept[name] = row
      } else {
        removed.push(name)
        logger.info(`Removing stale location '${name}' from _index.yaml`)
      }
    }

    // Only rewritten when something changed, so a clean world's index keeps
    // its mtime — and with it the cached parse the per-turn context uses.
    if (removed.length > 0) {
      document.locations = kept
      this.saveIndex(worldName, document)
    }

    return removed
  }
}
