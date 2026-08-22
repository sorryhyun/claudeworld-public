/**
 * Locations under `worlds/{name}/locations/`: a row in `locations/_index.yaml`
 * (position, adjacency, discovery) plus the location's own directory
 * (`description.md`, `events.md`). The index is authoritative for *which*
 * locations exist, but a row whose directory is gone is stale and skipped — the
 * world generator can leave the index ahead of the filesystem, and the Action
 * Manager must not be told about a place with no description.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { dumpYaml, MtimeCache, WorldService } from './world-service'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('LocationStorage')

/**
 * One location, assembled from its index row (`adjacent`, `is_discovered`,
 * `is_draft`, `label`, `name`, `position`) and its `description.md`.
 */
export interface LocationConfig {
  /** Directory name — the key used everywhere else in the codebase. */
  name: string
  displayName: string
  label: string | null
  position: [number, number]
  isDiscovered: boolean
  /** Directory names of neighbours reachable in one move. */
  adjacent: string[]
  description: string
  /** True while the location awaits enrichment by the Location Designer. */
  isDraft: boolean
}

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

  clearCache(): void {
    this.cache.clear()
  }

  // Cached by mtime, so an externally edited index still takes effect on the
  // next read.
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
      // A row missing the flag defaults to visible.
      isDiscovered: row.is_discovered !== false,
      adjacent: parseAdjacent(row.adjacent),
      description,
      isDraft: row.is_draft === true,
    }
  }

  /** One location, or `null` when it has no index row or no directory on disk. */
  loadLocation(worldName: string, locationName: string): LocationConfig | null {
    const row = this.loadIndex(worldName)[locationName]
    if (row === undefined) return null

    // A row without a directory is a stale entry left by a deleted location.
    if (!this.hasDirectory(worldName, locationName)) return null

    return this.buildConfig(locationName, asMapping(row), worldName)
  }

  /** Locations present in both the index and on disk, in index-file order. */
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

  // The *whole* document, read fresh for a read-modify-write; `null` when
  // absent. Unlike {@link loadIndex} it keeps the top level (anything up there
  // must survive the rewrite) and does not swallow a YAML error — degrading to
  // `{}` would make the next save replace a corrupt index with an empty one.
  private readIndexDocument(worldName: string): Record<string, unknown> | null {
    let raw: string
    try {
      raw = readFileSync(this.indexFile(worldName), 'utf-8')
    } catch {
      return null
    }

    // An existing but empty index is still an index: rows get added to it.
    const parsed = parseYaml(raw) as unknown
    return parsed === null || parsed === undefined ? { locations: {} } : asMapping(parsed)
  }

  // The invalidation is not housekeeping: mtime has millisecond resolution, so a
  // location created and immediately read would serve the pre-write index.
  private saveIndex(worldName: string, document: Record<string, unknown>): void {
    const indexFile = this.indexFile(worldName)
    writeFileSync(indexFile, dumpYaml(document), 'utf-8')
    this.cache.invalidate(indexFile)
  }

  /**
   * Create a location: directory, two markdown files, index row. Both halves
   * matter — the row makes it *exist*, the directory stops it being pruned as
   * stale. A draft (not yet enriched by the Location Designer) is still a real,
   * enterable place, so it is written `is_discovered: true` like any other.
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
    // `recursive` is forgiving of hand-made worlds missing `locations/`.
    mkdirSync(locationPath, { recursive: true })

    const descriptionFile = join(locationPath, 'description.md')
    writeFileSync(descriptionFile, `# ${displayName}\n\n${description}\n`, 'utf-8')
    // Same same-millisecond problem as the index, for the old description text.
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
   * Patch an existing index row; `false` when the world has no index or the
   * location is not in it. Only discovery and the map label are mutable.
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

    // `null` means "leave alone", not "clear": `PersistenceManager` forwards the
    // existing label on every discovery change, and it is null for most rows.
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
   * Drop index rows whose directory is gone. The read paths only *skip* such a
   * row; this deletes it, so a world reset leaves no phantom map entries.
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

    // Only rewritten when something changed, so a clean world's index keeps its
    // mtime, and with it the cached parse the per-turn context uses.
    if (removed.length > 0) {
      document.locations = kept
      this.saveIndex(worldName, document)
    }

    return removed
  }
}
