/**
 * `LocationStorage` write paths — creation, index patching and stale pruning.
 *
 * Each test builds an empty world under the OS temp directory through
 * `WorldService.createWorld`, so `locations/_index.json` starts in exactly the
 * shape a real world starts in: present, parseable and empty.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocationStorage } from '../services/location-storage'
import { WorldService } from '../services/world-service'

const WORLD = 'w'

let worldsDir: string

beforeEach(() => {
  worldsDir = mkdtempSync(join(tmpdir(), 'cw-location-writes-'))
  new WorldService(worldsDir).createWorld(WORLD, 'admin')
})
afterEach(() => {
  rmSync(worldsDir, { recursive: true, force: true })
})

function locationsDir(): string {
  return join(worldsDir, WORLD, 'locations')
}

function indexFile(): string {
  return join(locationsDir(), '_index.json')
}

/** The raw `locations` mapping, so tests can assert on the on-disk keys. */
function rawIndex(): Record<string, Record<string, unknown>> {
  const document = JSON.parse(readFileSync(indexFile(), 'utf-8')) as Record<string, unknown>
  return document.locations as Record<string, Record<string, unknown>>
}

/** A location directory with no index row — the inverse of a stale entry. */
function orphanDirectory(name: string): void {
  mkdirSync(join(locationsDir(), name), { recursive: true })
}

/** An index row with no directory — a stale entry. */
function staleRow(name: string): void {
  const document = JSON.parse(readFileSync(indexFile(), 'utf-8')) as Record<string, unknown>
  const locations = document.locations as Record<string, unknown>
  locations[name] = { name, label: null, position: [0, 0], is_discovered: true, adjacent: [], is_draft: false }
  writeFileSync(indexFile(), JSON.stringify(document), 'utf-8')
}

// ============================================================================
// createLocation
// ============================================================================

describe('createLocation', () => {
  test('writes the directory, both markdown files and the index row', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust and gears.', [3, 4], ['creek'])

    expect(statSync(join(locationsDir(), 'old_mill')).isDirectory()).toBe(true)
    expect(readFileSync(join(locationsDir(), 'old_mill', 'description.md'), 'utf-8')).toBe(
      '# The Old Mill\n\nDust and gears.\n',
    )
    expect(readFileSync(join(locationsDir(), 'old_mill', 'events.md'), 'utf-8')).toBe(
      '# Events at The Old Mill\n\n',
    )
    expect(rawIndex().old_mill).toEqual({
      name: 'The Old Mill',
      label: null,
      position: [3, 4],
      is_discovered: true,
      adjacent: ['creek'],
      is_draft: false,
    })
  })

  test('the new location reads back through loadLocation', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust and gears.', [3, 4])

    expect(storage.loadLocation(WORLD, 'old_mill')).toEqual({
      name: 'old_mill',
      displayName: 'The Old Mill',
      label: null,
      position: [3, 4],
      isDiscovered: true,
      adjacent: [],
      description: '# The Old Mill\n\nDust and gears.\n',
      isDraft: false,
    })
  })

  test('a draft location is still discovered and enterable', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'ruins', 'The Ruins', 'A sketch.', [1, 1], [], true)

    expect(rawIndex().ruins?.is_draft).toBe(true)
    expect(rawIndex().ruins?.is_discovered).toBe(true)
    expect(storage.loadLocation(WORLD, 'ruins')?.isDraft).toBe(true)
  })

  test('adding a second location leaves the first alone', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])
    storage.createLocation(WORLD, 'creek', 'Winding Creek', 'Water.', [4, 4], ['old_mill'])

    expect(Object.keys(rawIndex()).sort()).toEqual(['creek', 'old_mill'])
    expect(rawIndex().old_mill?.name).toBe('The Old Mill')
  })

  test('a world with no _index.json gets one', () => {
    rmSync(indexFile())
    const storage = new LocationStorage(worldsDir)

    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])

    expect(Object.keys(rawIndex())).toEqual(['old_mill'])
  })

  test('unrelated top-level keys in the index survive the rewrite', () => {
    writeFileSync(indexFile(), '{"locations": {}, "version": 3}', 'utf-8')
    new LocationStorage(worldsDir).createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])

    const document = JSON.parse(readFileSync(indexFile(), 'utf-8')) as Record<string, unknown>
    expect(document.version).toBe(3)
    expect(Object.keys(document.locations as Record<string, unknown>)).toEqual(['old_mill'])
  })
})

// ============================================================================
// Cache invalidation
// ============================================================================

describe('index cache invalidation', () => {
  test('a write is visible to the very next read, even at an unchanged mtime', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])

    // This read caches the index against its current mtime.
    expect(Object.keys(storage.loadAllLocations(WORLD))).toEqual(['old_mill'])
    const pinned = statSync(indexFile()).mtime

    storage.createLocation(WORLD, 'creek', 'Winding Creek', 'Water.', [4, 4])
    // Roll the mtime back to what the cache recorded. This is the
    // same-millisecond write the world generator produces for real, made
    // deterministic: without the invalidation in `saveIndex`, the read below
    // serves the pre-write index and only sees `old_mill`.
    utimesSync(indexFile(), pinned, pinned)

    expect(Object.keys(storage.loadAllLocations(WORLD)).sort()).toEqual(['creek', 'old_mill'])
  })

  test('updateLocation is visible to the next read at an unchanged mtime', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])
    storage.updateLocation(WORLD, 'old_mill', { isDiscovered: false })

    expect(storage.loadLocation(WORLD, 'old_mill')?.isDiscovered).toBe(false)
    const pinned = statSync(indexFile()).mtime

    storage.updateLocation(WORLD, 'old_mill', { isDiscovered: true })
    utimesSync(indexFile(), pinned, pinned)

    expect(storage.loadLocation(WORLD, 'old_mill')?.isDiscovered).toBe(true)
  })

  test('re-creating a location replaces its cached description', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'A draft.', [3, 4])
    expect(storage.loadLocation(WORLD, 'old_mill')?.description).toBe('# The Old Mill\n\nA draft.\n')

    const descriptionFile = join(locationsDir(), 'old_mill', 'description.md')
    const pinned = statSync(descriptionFile).mtime

    // The Location Designer enriching a draft: same path, new prose.
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust and gears.', [3, 4])
    utimesSync(descriptionFile, pinned, pinned)

    expect(storage.loadLocation(WORLD, 'old_mill')?.description).toBe(
      '# The Old Mill\n\nDust and gears.\n',
    )
  })
})

// ============================================================================
// updateLocation
// ============================================================================

describe('updateLocation', () => {
  beforeEach(() => {
    new LocationStorage(worldsDir).createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])
  })

  test('patches discovery and label', () => {
    const storage = new LocationStorage(worldsDir)

    expect(storage.updateLocation(WORLD, 'old_mill', { isDiscovered: false, label: '방앗간' })).toBe(true)

    expect(rawIndex().old_mill?.is_discovered).toBe(false)
    expect(rawIndex().old_mill?.label).toBe('방앗간')
    expect(storage.loadLocation(WORLD, 'old_mill')?.label).toBe('방앗간')
  })

  test('null means "leave alone", not "clear"', () => {
    const storage = new LocationStorage(worldsDir)
    storage.updateLocation(WORLD, 'old_mill', { label: '방앗간' })

    // `persistence_manager.py` forwards `label=location.label` on every
    // discovery change, and that label is None for most rows.
    storage.updateLocation(WORLD, 'old_mill', { isDiscovered: false, label: null })

    expect(rawIndex().old_mill?.label).toBe('방앗간')
    expect(rawIndex().old_mill?.is_discovered).toBe(false)
  })

  test('an omitted field is untouched', () => {
    const storage = new LocationStorage(worldsDir)
    storage.updateLocation(WORLD, 'old_mill', { label: '방앗간' })

    expect(rawIndex().old_mill?.is_discovered).toBe(true)
    expect(rawIndex().old_mill?.position).toEqual([3, 4])
    expect(rawIndex().old_mill?.name).toBe('The Old Mill')
  })

  test('an unknown location reports false and writes nothing', () => {
    const storage = new LocationStorage(worldsDir)
    const before = readFileSync(indexFile(), 'utf-8')

    expect(storage.updateLocation(WORLD, 'nowhere', { isDiscovered: true })).toBe(false)
    expect(readFileSync(indexFile(), 'utf-8')).toBe(before)
  })

  test('a world with no index reports false', () => {
    rmSync(indexFile())
    expect(new LocationStorage(worldsDir).updateLocation(WORLD, 'old_mill', { label: 'x' })).toBe(false)
  })

  test('a location row with no directory can still be patched', () => {
    // The index is authoritative for the row; the read paths are what apply
    // the stale rule, not the writer.
    staleRow('ghost_town')
    const storage = new LocationStorage(worldsDir)

    expect(storage.updateLocation(WORLD, 'ghost_town', { isDiscovered: false })).toBe(true)
    expect(rawIndex().ghost_town?.is_discovered).toBe(false)
    expect(storage.loadLocation(WORLD, 'ghost_town')).toBeNull()
  })
})

// ============================================================================
// cleanupStaleEntries
// ============================================================================

describe('cleanupStaleEntries', () => {
  test('removes exactly the rows whose directory is gone', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])
    storage.createLocation(WORLD, 'creek', 'Winding Creek', 'Water.', [4, 4])
    staleRow('ghost_town')
    staleRow('sunken_road')

    expect(storage.cleanupStaleEntries(WORLD).sort()).toEqual(['ghost_town', 'sunken_road'])

    expect(Object.keys(rawIndex()).sort()).toEqual(['creek', 'old_mill'])
    expect(rawIndex().old_mill?.name).toBe('The Old Mill')
  })

  test('a directory with no row is not stale and is not touched', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])
    orphanDirectory('unlisted')

    expect(storage.cleanupStaleEntries(WORLD)).toEqual([])
    expect(existsSync(join(locationsDir(), 'unlisted'))).toBe(true)
  })

  test('a clean index is left byte-identical', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])
    const before = readFileSync(indexFile(), 'utf-8')

    expect(storage.cleanupStaleEntries(WORLD)).toEqual([])
    expect(readFileSync(indexFile(), 'utf-8')).toBe(before)
  })

  test('the pruned index is what the next read sees', () => {
    const storage = new LocationStorage(worldsDir)
    storage.createLocation(WORLD, 'old_mill', 'The Old Mill', 'Dust.', [3, 4])
    staleRow('ghost_town')

    // Populate the cache with the pre-prune index first.
    expect(Object.keys(storage.loadAllLocations(WORLD))).toEqual(['old_mill'])
    const pinned = statSync(indexFile()).mtime

    storage.cleanupStaleEntries(WORLD)
    utimesSync(indexFile(), pinned, pinned)

    expect(Object.keys(rawIndex())).toEqual(['old_mill'])
    expect(Object.keys(storage.loadAllLocations(WORLD))).toEqual(['old_mill'])
  })

  test('a world with no index has nothing to clean', () => {
    rmSync(indexFile())
    expect(new LocationStorage(worldsDir).cleanupStaleEntries(WORLD)).toEqual([])
  })

  test('a missing world has nothing to clean', () => {
    expect(new LocationStorage(worldsDir).cleanupStaleEntries('no-such-world')).toEqual([])
  })

  test('an empty index has nothing to clean', () => {
    expect(new LocationStorage(worldsDir).cleanupStaleEntries(WORLD)).toEqual([])
  })
})
