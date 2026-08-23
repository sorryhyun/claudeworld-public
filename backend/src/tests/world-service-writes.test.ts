/**
 * `WorldService` write paths — world creation, config saves, listing and
 * deletion.
 *
 * Every test builds its own empty `worlds/` under the OS temp directory. The
 * checked-in `worlds/asdf` fixture is deliberately not copied here: these are
 * the paths that create and delete whole trees, and none of them should ever
 * need a pre-existing world to work against.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HttpError } from '@/domain/errors'
import { WorldService } from '@/services/world-service'

let worldsDir: string

beforeEach(() => {
  worldsDir = mkdtempSync(join(tmpdir(), 'cw-world-writes-'))
})
afterEach(() => {
  rmSync(worldsDir, { recursive: true, force: true })
})

/** The raw `world.json` mapping, so tests can assert on key *presence*. */
function rawWorldYaml(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(worldsDir, name, 'world.json'), 'utf-8')) as Record<string, unknown>
}

/**
 * Normalise a timestamp read back from YAML. The `yaml` package emits bare
 * timestamps and reads them back as strings, but a file written by PyYAML
 * comes back as a `Date`; tests should not care which.
 */
function stamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/** A hand-written world, so a test can choose its owner and timestamps. */
function seedWorld(name: string, ownerId: string, updatedAt: string): void {
  mkdirSync(join(worldsDir, name), { recursive: true })
  writeFileSync(
    join(worldsDir, name, 'world.json'),
    JSON.stringify({
      name,
      owner_id: ownerId,
      user_name: null,
      language: 'en',
      genre: null,
      theme: null,
      phase: 'active',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: updatedAt,
      settings: {},
    }),
    'utf-8',
  )
}

// ============================================================================
// createWorld
// ============================================================================

describe('createWorld', () => {
  test('builds the whole tree a world is expected to have', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('Mist Harbour', 'admin', '손님', 'ko')

    const worldPath = join(worldsDir, 'Mist Harbour')
    for (const directory of ['agents', 'locations', 'maps', 'items']) {
      expect(statSync(join(worldPath, directory)).isDirectory()).toBe(true)
    }
    for (const file of ['world.json', 'stats.json', 'player.json', 'lore.md', 'history.md']) {
      expect(statSync(join(worldPath, file)).isFile()).toBe(true)
    }
    expect(statSync(join(worldPath, 'locations', '_index.json')).isFile()).toBe(true)
  })

  test('seeds the markdown files with their headings', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('w', 'admin')

    expect(readFileSync(join(worldsDir, 'w', 'lore.md'), 'utf-8')).toBe(
      '# World Lore\n\n*To be written...*\n',
    )
    expect(readFileSync(join(worldsDir, 'w', 'history.md'), 'utf-8')).toBe('# World History\n\n')
  })

  test('seeds parseable, empty stats / player / location files', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('w', 'admin')

    const read = (...parts: string[]): unknown =>
      JSON.parse(readFileSync(join(worldsDir, 'w', ...parts), 'utf-8'))

    expect(read('stats.json')).toEqual({ stats: [], derived: [] })
    expect(read('locations', '_index.json')).toEqual({ locations: {} })
    expect(read('player.json')).toEqual({
      current_location: null,
      turn_count: 0,
      stats: {},
      inventory: [],
      effects: [],
      recent_actions: [],
      game_time: { hour: 8, minute: 0, day: 1 },
    })
  })

  test('returns the config it just wrote, in onboarding phase', () => {
    const config = new WorldService(worldsDir).createWorld('w', 'admin', '손님', 'ko')

    expect(config.name).toBe('w')
    expect(config.ownerId).toBe('admin')
    expect(config.userName).toBe('손님')
    expect(config.language).toBe('ko')
    expect(config.phase).toBe('onboarding')
    expect(config.pendingPhase).toBeNull()
    expect(config.settings).toEqual({
      allow_death: true,
      difficulty: 'normal',
      narrator_style: 'atmospheric',
    })
  })

  test('a name with no owner-supplied user name writes an explicit null', () => {
    new WorldService(worldsDir).createWorld('w', 'admin')

    expect(rawWorldYaml('w').user_name).toBeNull()
    expect(new WorldService(worldsDir).loadWorldConfig('w')?.userName).toBeNull()
  })

  test('creating over an existing world is the 400 the route reports', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('w', 'admin')

    expect(() => service.createWorld('w', 'admin')).toThrow(HttpError)
    try {
      service.createWorld('w', 'admin')
    } catch (error) {
      expect((error as HttpError).status).toBe(400)
      expect((error as HttpError).detail).toBe("World 'w' already exists")
    }
  })

  test('the worlds directory is created on demand', () => {
    const nested = join(worldsDir, 'does', 'not', 'exist')
    new WorldService(nested).createWorld('w', 'admin')

    expect(existsSync(join(nested, 'w', 'world.json'))).toBe(true)
  })
})

// ============================================================================
// saveWorldConfig
// ============================================================================

describe('saveWorldConfig', () => {
  test('preserves created_at and always restamps updated_at', () => {
    const service = new WorldService(worldsDir)
    seedWorld('w', 'admin', '2020-01-01T00:00:00.000Z')

    const config = service.loadWorldConfig('w')
    if (!config) throw new Error('seeded world did not load')
    service.saveWorldConfig('w', config)

    const raw = rawWorldYaml('w')
    expect(stamp(raw.created_at)).toBe('2020-01-01T00:00:00.000Z')
    // Nothing about the config changed, but the file is still touched — this
    // is what makes listWorlds' ordering mean "recently played".
    expect(new Date(stamp(raw.updated_at)).getFullYear()).toBeGreaterThan(2020)
  })

  test('pending_phase is written when set and the key is absent when not', () => {
    const service = new WorldService(worldsDir)
    const config = service.createWorld('w', 'admin')

    expect('pending_phase' in rawWorldYaml('w')).toBe(false)

    config.pendingPhase = 'active'
    service.saveWorldConfig('w', config)
    expect(rawWorldYaml('w').pending_phase).toBe('active')

    // Clearing the field removes the key entirely rather than writing null.
    config.pendingPhase = null
    service.saveWorldConfig('w', config)
    expect('pending_phase' in rawWorldYaml('w')).toBe(false)
  })

  test('an empty-string pending phase is falsy and is dropped too', () => {
    const service = new WorldService(worldsDir)
    const config = service.createWorld('w', 'admin')

    config.pendingPhase = ''
    service.saveWorldConfig('w', config)

    expect('pending_phase' in rawWorldYaml('w')).toBe(false)
  })

  test('the write invalidates the cached config rather than serving the old one', () => {
    const service = new WorldService(worldsDir)
    const config = service.createWorld('w', 'admin')
    expect(service.loadWorldConfig('w')?.phase).toBe('onboarding')

    config.phase = 'active'
    service.saveWorldConfig('w', config)

    expect(service.loadWorldConfig('w')?.phase).toBe('active')
  })

  test('round-trips the fields the frontend reads', () => {
    const service = new WorldService(worldsDir)
    const config = service.createWorld('w', 'admin', '손님', 'ko')

    config.genre = '다크 판타지'
    config.theme = 'revenge'
    config.settings = { difficulty: 'hard', allow_death: false }
    service.saveWorldConfig('w', config)

    const reloaded = service.loadWorldConfig('w')
    expect(reloaded?.genre).toBe('다크 판타지')
    expect(reloaded?.theme).toBe('revenge')
    expect(reloaded?.userName).toBe('손님')
    expect(reloaded?.settings).toEqual({ difficulty: 'hard', allow_death: false })
  })
})

// ============================================================================
// applyPendingPhase
// ============================================================================

describe('applyPendingPhase', () => {
  test('promotes the queued phase and then clears it', () => {
    const service = new WorldService(worldsDir)
    const config = service.createWorld('w', 'admin')

    config.pendingPhase = 'active'
    service.saveWorldConfig('w', config)

    expect(service.applyPendingPhase('w')).toBe(true)

    const applied = service.loadWorldConfig('w')
    expect(applied?.phase).toBe('active')
    expect(applied?.pendingPhase).toBeNull()
    // The key must be gone from disk, not present-and-null: that is what stops
    // the "Enter World" banner reappearing on every poll.
    expect('pending_phase' in rawWorldYaml('w')).toBe(false)
  })

  test('is idempotent — a second call has nothing to apply', () => {
    const service = new WorldService(worldsDir)
    const config = service.createWorld('w', 'admin')
    config.pendingPhase = 'active'
    service.saveWorldConfig('w', config)

    expect(service.applyPendingPhase('w')).toBe(true)
    expect(service.applyPendingPhase('w')).toBe(false)
    expect(service.loadWorldConfig('w')?.phase).toBe('active')
  })

  test('a world with nothing pending is left untouched', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('w', 'admin')
    const before = readFileSync(join(worldsDir, 'w', 'world.json'), 'utf-8')

    expect(service.applyPendingPhase('w')).toBe(false)
    expect(readFileSync(join(worldsDir, 'w', 'world.json'), 'utf-8')).toBe(before)
  })

  test('a missing world reports nothing applied instead of throwing', () => {
    expect(new WorldService(worldsDir).applyPendingPhase('no-such-world')).toBe(false)
  })
})

// ============================================================================
// listWorlds
// ============================================================================

describe('listWorlds', () => {
  test('filters by owner and sorts by updated_at descending', () => {
    seedWorld('oldest', 'admin', '2021-01-01T00:00:00.000Z')
    seedWorld('newest', 'admin', '2023-01-01T00:00:00.000Z')
    seedWorld('middle', 'admin', '2022-01-01T00:00:00.000Z')
    seedWorld('someone-elses', 'guest', '2024-01-01T00:00:00.000Z')

    const service = new WorldService(worldsDir)

    expect(service.listWorlds('admin').map((world) => world.name)).toEqual([
      'newest',
      'middle',
      'oldest',
    ])
    expect(service.listWorlds('guest').map((world) => world.name)).toEqual(['someone-elses'])
    // No owner means every world, still newest first.
    expect(service.listWorlds().map((world) => world.name)).toEqual([
      'someone-elses',
      'newest',
      'middle',
      'oldest',
    ])
  })

  test('a directory without world.json is not a world', () => {
    seedWorld('real', 'admin', '2023-01-01T00:00:00.000Z')
    mkdirSync(join(worldsDir, 'half-deleted', 'locations'), { recursive: true })
    writeFileSync(join(worldsDir, 'stray.txt'), 'not a world', 'utf-8')

    expect(new WorldService(worldsDir).listWorlds().map((world) => world.name)).toEqual(['real'])
  })

  test('a world whose config does not parse is skipped, not fatal', () => {
    seedWorld('good', 'admin', '2023-01-01T00:00:00.000Z')
    mkdirSync(join(worldsDir, 'broken'), { recursive: true })
    writeFileSync(join(worldsDir, 'broken', 'world.json'), '\tnot: [valid', 'utf-8')

    expect(new WorldService(worldsDir).listWorlds().map((world) => world.name)).toEqual(['good'])
  })

  test('an absent worlds directory lists nothing', () => {
    expect(new WorldService(join(worldsDir, 'nope')).listWorlds()).toEqual([])
  })

  test('an owner id nobody matches lists nothing', () => {
    seedWorld('real', 'admin', '2023-01-01T00:00:00.000Z')
    expect(new WorldService(worldsDir).listWorlds('stranger')).toEqual([])
  })
})

// ============================================================================
// deleteWorld
// ============================================================================

describe('deleteWorld', () => {
  test('removes the tree and stops serving cached reads of it', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('w', 'admin')

    // Populate every cache entry the world owns before deleting it.
    expect(service.loadLore('w')).not.toBe('')
    expect(service.loadHistory('w')).not.toBe('')
    expect(service.loadWorldConfig('w')).not.toBeNull()

    expect(service.deleteWorld('w')).toBe(true)

    expect(existsSync(join(worldsDir, 'w'))).toBe(false)
    expect(service.worldExists('w')).toBe(false)
    expect(service.loadWorldConfig('w')).toBeNull()
    expect(service.loadLore('w')).toBe('')
    expect(service.loadHistory('w')).toBe('')
    expect(service.listWorlds()).toEqual([])
  })

  test('deleting a world that is not there reports false', () => {
    expect(new WorldService(worldsDir).deleteWorld('no-such-world')).toBe(false)
  })

  test('a world can be recreated under the same name afterwards', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('w', 'admin')
    service.saveLore('w', '# Version one\n')
    service.deleteWorld('w')

    service.createWorld('w', 'admin')
    expect(service.loadLore('w')).toBe('# World Lore\n\n*To be written...*\n')
  })

  test('deleting one world leaves its neighbours alone', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('keep', 'admin')
    service.createWorld('drop', 'admin')

    service.deleteWorld('drop')

    expect(service.worldExists('keep')).toBe(true)
    expect(service.listWorlds().map((world) => world.name)).toEqual(['keep'])
  })
})

// ============================================================================
// saveLore
// ============================================================================

describe('saveLore', () => {
  test('replaces the file and the next read sees the new text immediately', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('w', 'admin')
    expect(service.loadLore('w')).toBe('# World Lore\n\n*To be written...*\n')

    // No mtime nudge: back-to-back writes land in the same millisecond, so
    // this only passes because the write invalidates the cache entry.
    service.saveLore('w', '# 안개 항구\n\n소금기 어린 바람.\n')

    expect(service.loadLore('w')).toBe('# 안개 항구\n\n소금기 어린 바람.\n')
    expect(readFileSync(join(worldsDir, 'w', 'lore.md'), 'utf-8')).toBe(
      '# 안개 항구\n\n소금기 어린 바람.\n',
    )
  })
})

// ============================================================================
// ensureWorldExists
// ============================================================================

describe('ensureWorldExists', () => {
  test('creates the world on first call and reuses it on the next', () => {
    const service = new WorldService(worldsDir)

    const created = service.ensureWorldExists('w')
    expect(created.ownerId).toBe('system')
    expect(created.phase).toBe('onboarding')

    service.saveLore('w', '# Written by the seed generator\n')
    const second = service.ensureWorldExists('w')

    expect(second.createdAt.getTime()).toBe(created.createdAt.getTime())
    expect(service.loadLore('w')).toBe('# Written by the seed generator\n')
  })

  test('the owner id is only used when creating', () => {
    const service = new WorldService(worldsDir)
    service.createWorld('w', 'admin')

    expect(service.ensureWorldExists('w', 'someone-else').ownerId).toBe('admin')
  })
})
