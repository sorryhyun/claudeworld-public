/**
 * The startup conversion of a YAML-era world tree. The payloads here are written
 * in the exact shapes the `yaml` package used to emit — block scalars, sequence
 * items flush with their key, unquoted non-ASCII — because those are what is
 * actually sitting in an upgraded install's `worlds/`.
 *
 * Every test builds its own throwaway worlds root; nothing here may touch the
 * repository's `worlds/`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrateWorldDataToJson } from '@/services/world-json-migration'
import { ItemService } from '@/services/item-service'
import { LocationStorage } from '@/services/location-storage'
import { PlayerService } from '@/services/player-service'
import { WorldService } from '@/services/world-service'

const WORLD = 'oldworld'

let worldsDir: string

function worldPath(): string {
  return join(worldsDir, WORLD)
}

function write(relativePath: string, content: string): void {
  const filePath = join(worldPath(), relativePath)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
}

function read(relativePath: string): string {
  return readFileSync(join(worldPath(), relativePath), 'utf-8')
}

/** A world in the shape the `yaml` writers left behind. */
function seedYamlWorld(): void {
  write(
    'world.yaml',
    [
      "created_at: '2026-08-06T04:14:54.918838Z'",
      'genre: null',
      'language: ko',
      `name: ${WORLD}`,
      'owner_id: admin',
      'phase: active',
      'settings:',
      '  allow_death: true',
      '  difficulty: normal',
      "updated_at: '2026-08-06T04:14:54.918849Z'",
      'user_name: 손님',
      '',
    ].join('\n'),
  )

  write(
    'player.yaml',
    [
      'current_location: old_mill',
      'effects: []',
      'game_time:',
      '  day: 2',
      '  hour: 17',
      '  minute: 40',
      'inventory:',
      '- item_id: lamp',
      '  count: 1',
      'recent_actions: []',
      'stats:',
      '  hp: 7',
      'turn_count: 12',
      '',
    ].join('\n'),
  )

  write('stats.yaml', 'derived: []\nstats:\n- name: hp\n  default: 10\n')

  write(
    join('locations', '_index.yaml'),
    [
      'locations:',
      '  old_mill:',
      '    adjacent: [creek]',
      '    is_discovered: true',
      '    is_draft: false',
      '    label: null',
      '    name: The Old Mill',
      '    position: [3, 4]',
      '',
    ].join('\n'),
  )
  write(join('locations', 'old_mill', 'description.md'), '# The Old Mill\n\nDust and gears.\n')

  write(
    join('items', 'lamp.yaml'),
    [
      'default_properties: {}',
      'description: |-',
      '  A dented lantern.',
      '  The glass is cracked.',
      'id: lamp',
      'name: 놋쇠 등불',
      'tags:',
      '- light',
      '',
    ].join('\n'),
  )
}

beforeEach(() => {
  worldsDir = mkdtempSync(join(tmpdir(), 'cw-json-migration-'))
})

afterEach(() => {
  rmSync(worldsDir, { recursive: true, force: true })
})

describe('migrateWorldDataToJson', () => {
  test('converts every world data file and deletes the YAML', () => {
    seedYamlWorld()

    expect(migrateWorldDataToJson(worldsDir)).toBe(5)

    for (const gone of [
      'world.yaml',
      'player.yaml',
      'stats.yaml',
      join('locations', '_index.yaml'),
      join('items', 'lamp.yaml'),
    ]) {
      expect(existsSync(join(worldPath(), gone))).toBe(false)
    }

    for (const present of [
      'world.json',
      'player.json',
      'stats.json',
      join('locations', '_index.json'),
      join('items', 'lamp.json'),
    ]) {
      expect(existsSync(join(worldPath(), present))).toBe(true)
    }

    // Untouched: only the five data files are the migration's business.
    expect(read(join('locations', 'old_mill', 'description.md'))).toContain('Dust and gears.')
  })

  test('the converted world reads back through the services that own it', () => {
    seedYamlWorld()
    migrateWorldDataToJson(worldsDir)

    const config = new WorldService(worldsDir).loadWorldConfig(WORLD)
    expect(config?.phase).toBe('active')
    expect(config?.userName).toBe('손님')
    expect(config?.language).toBe('ko')
    expect(config?.createdAt.toISOString()).toBe('2026-08-06T04:14:54.918Z')

    const players = new PlayerService(worldsDir)
    const state = players.loadPlayerState(WORLD)
    expect(state?.turnCount).toBe(12)
    expect(state?.currentLocation).toBe('old_mill')
    expect(state?.stats).toEqual({ hp: 7 })
    expect(state?.gameTime).toEqual({ day: 2, hour: 17, minute: 40 })
    expect(players.loadStatDefinitions(WORLD).stats).toEqual([{ name: 'hp', default: 10 }])

    expect(new LocationStorage(worldsDir).loadLocation(WORLD, 'old_mill')?.displayName).toBe(
      'The Old Mill',
    )

    // The block scalar survives as a real newline, not as an escaped one.
    const lamp = new ItemService(worldsDir).loadItemTemplate(WORLD, 'lamp')
    expect(lamp?.name).toBe('놋쇠 등불')
    expect(lamp?.description).toBe('A dented lantern.\nThe glass is cracked.')
  })

  test('a second run is a no-op', () => {
    seedYamlWorld()
    migrateWorldDataToJson(worldsDir)
    const before = read('world.json')

    expect(migrateWorldDataToJson(worldsDir)).toBe(0)
    expect(read('world.json')).toBe(before)
  })

  test('a world already in JSON is left alone', () => {
    new WorldService(worldsDir).createWorld(WORLD, 'admin')
    const before = read('world.json')

    expect(migrateWorldDataToJson(worldsDir)).toBe(0)
    expect(read('world.json')).toBe(before)
  })

  test('a malformed document is left in place rather than half-converted', () => {
    write('world.yaml', '\tnot: [valid')
    write('player.yaml', 'turn_count: 3\n')

    // The good file still converts: one bad world file must not strand the rest.
    expect(migrateWorldDataToJson(worldsDir)).toBe(1)
    expect(existsSync(join(worldPath(), 'world.yaml'))).toBe(true)
    expect(existsSync(join(worldPath(), 'world.json'))).toBe(false)
    expect(existsSync(join(worldPath(), 'player.json'))).toBe(true)
  })

  test('an existing JSON file wins and its YAML twin is kept, not deleted', () => {
    write('world.yaml', 'name: from-yaml\n')
    write('world.json', '{"name": "from-json"}')

    expect(migrateWorldDataToJson(worldsDir)).toBe(0)
    expect(read('world.json')).toBe('{"name": "from-json"}')
    expect(existsSync(join(worldPath(), 'world.yaml'))).toBe(true)
  })

  test('an empty document becomes an empty mapping, not a null one', () => {
    write('stats.yaml', '')

    expect(migrateWorldDataToJson(worldsDir)).toBe(1)
    expect(JSON.parse(read('stats.json'))).toEqual({})
    expect(new PlayerService(worldsDir).loadStatDefinitions(WORLD)).toEqual({
      stats: [],
      derived: [],
    })
  })

  test('a missing worlds directory is not an error', () => {
    expect(migrateWorldDataToJson(join(worldsDir, 'nope'))).toBe(0)
  })

  test('a loose file beside the world directories is ignored', () => {
    writeFileSync(join(worldsDir, 'README.md'), '# worlds\n', 'utf-8')
    expect(migrateWorldDataToJson(worldsDir)).toBe(0)
  })
})
