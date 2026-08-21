/**
 * Location reads from `worlds/{name}/locations/`.
 *
 * Ported from `backend/services/location_storage.py` (read paths only).
 *
 * A location is split across two places: its row in `locations/_index.yaml`
 * (map position, adjacency, discovery flag) and its own directory
 * (`description.md`, `events.md`). The index is authoritative for *which*
 * locations exist, but an entry whose directory is gone is treated as stale
 * and skipped — the world generator can leave the index ahead of the
 * filesystem, and the Action Manager must not be told about a place with no
 * description.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { MtimeCache, WorldService } from './world-service'
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
    const indexFile = join(this.locationsDir(worldName), '_index.yaml')

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
}
