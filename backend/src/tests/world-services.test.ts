/**
 * World filesystem read layer.
 *
 * Read paths run against the repo's real `worlds/asdf/` so the types stay
 * honest about what is actually on disk. Anything that writes works on a
 * throwaway copy — `worlds/asdf` is checked-in fixture data and must never be
 * mutated by the suite.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { LocationStorage } from '../services/location-storage'
import { PlayerService } from '../services/player-service'
import { RoomMappingService } from '../services/room-mapping'
import { MtimeCache, WorldService } from '../services/world-service'

/**
 * The fixture worlds tree, checked in under `src/tests/fixtures/worlds/`.
 *
 * This used to point at the repo's own `worlds/` directory, which is
 * `.gitignore`d — so the suite passed only on a machine that happened to have
 * played that world locally, and failed on every fresh checkout including CI.
 * `worlds/asdf` is reproduced here byte-for-byte instead: same fresh-world
 * shape, same timestamps, now tracked.
 */
const REAL_WORLDS_DIR = join(import.meta.dir, 'fixtures', 'worlds')
const WORLD = 'asdf'

/** A writable copy of `worlds/`, recreated per test in the write suites. */
let tempWorldsDir: string

function makeTempWorlds(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-worlds-'))
  cpSync(join(REAL_WORLDS_DIR, WORLD), join(dir, WORLD), { recursive: true })
  return dir
}

/** Force a distinct mtime — two writes can otherwise land in the same ms. */
function touchFuture(filePath: string): void {
  const future = new Date(Date.now() + 5_000)
  utimesSync(filePath, future, future)
}

/** Fixed mtime used to simulate an edit the cache must not notice. */
const PINNED_MTIME = new Date(1_700_000_000_000)

/** Write `content` but pin the mtime, so a cached reader sees no change. */
function writeStale(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8')
  utimesSync(filePath, PINNED_MTIME, PINNED_MTIME)
}

// ============================================================================
// WorldService — reads
// ============================================================================

describe('WorldService reads', () => {
  const service = new WorldService(REAL_WORLDS_DIR)

  test('loadWorldConfig maps world.yaml onto camelCase fields', () => {
    const config = service.loadWorldConfig(WORLD)

    expect(config).not.toBeNull()
    expect(config?.name).toBe('asdf')
    expect(config?.ownerId).toBe('admin')
    expect(config?.userName).toBe('손님')
    expect(config?.language).toBe('ko')
    expect(config?.phase).toBe('onboarding')
    expect(config?.genre).toBeNull()
    expect(config?.theme).toBeNull()
    expect(config?.pendingPhase).toBeNull()
    expect(config?.settings).toEqual({
      allow_death: true,
      difficulty: 'normal',
      narrator_style: 'atmospheric',
    })
  })

  test('timestamps without a zone designator are read as UTC', () => {
    // world.yaml holds '2026-08-06T04:14:54.918838Z'; JS keeps only millis.
    expect(service.loadWorldConfig(WORLD)?.createdAt.toISOString()).toBe('2026-08-06T04:14:54.918Z')
  })

  test('loadLore returns the file verbatim', () => {
    expect(service.loadLore(WORLD)).toBe('# World Lore\n\n*To be written...*\n')
  })

  test('loadHistory returns the file verbatim', () => {
    expect(service.loadHistory(WORLD)).toBe('# World History\n\n')
  })

  test('a world with no consolidated_history.md has no subtitles', () => {
    expect(service.getHistorySubtitles(WORLD)).toEqual([])
    expect(service.getHistoryBySubtitle(WORLD, 'anything')).toBeNull()
  })

  test('worldExists tracks world.yaml, not just the directory', () => {
    expect(service.worldExists(WORLD)).toBe(true)
    expect(service.worldExists('no-such-world')).toBe(false)
  })

  test('a missing world degrades instead of throwing', () => {
    expect(service.loadWorldConfig('no-such-world')).toBeNull()
    expect(service.loadLore('no-such-world')).toBe('')
    expect(service.loadHistory('no-such-world')).toBe('')
  })

  test('getWorldPath strips path separators but keeps non-ASCII names', () => {
    expect(service.getWorldPath('../etc')).toBe(join(REAL_WORLDS_DIR, '..etc'))
    expect(service.getWorldPath('마법의 숲')).toBe(join(REAL_WORLDS_DIR, '마법의 숲'))
  })
})

// ============================================================================
// Mtime cache
// ============================================================================

describe('mtime caching', () => {
  beforeEach(() => {
    tempWorldsDir = makeTempWorlds()
  })
  afterEach(() => {
    rmSync(tempWorldsDir, { recursive: true, force: true })
  })

  test('a changed mtime reloads the file (this is the hot-reload path)', () => {
    const service = new WorldService(tempWorldsDir)
    const loreFile = join(tempWorldsDir, WORLD, 'lore.md')

    expect(service.loadLore(WORLD)).toBe('# World Lore\n\n*To be written...*\n')

    writeFileSync(loreFile, '# Rewritten', 'utf-8')
    touchFuture(loreFile)

    expect(service.loadLore(WORLD)).toBe('# Rewritten')
  })

  test('an unchanged mtime serves the cached parse', () => {
    const service = new WorldService(tempWorldsDir)
    const loreFile = join(tempWorldsDir, WORLD, 'lore.md')

    writeStale(loreFile, '# First')
    expect(service.loadLore(WORLD)).toBe('# First')

    // Rewrite the content but pin the same mtime: a real read would see the new
    // text, so the old text proves the cache is doing the work.
    writeStale(loreFile, '# Should not be seen')

    expect(service.loadLore(WORLD)).toBe('# First')
    service.clearCache()
    expect(service.loadLore(WORLD)).toBe('# Should not be seen')
  })

  test('each service owns its cache unless one is shared explicitly', () => {
    const shared = new MtimeCache()
    const a = new WorldService(tempWorldsDir, shared)
    const b = new WorldService(tempWorldsDir, shared)
    const loreFile = join(tempWorldsDir, WORLD, 'lore.md')

    writeStale(loreFile, '# First')
    a.loadLore(WORLD)
    writeStale(loreFile, '# Should not be seen')

    expect(b.loadLore(WORLD)).toBe('# First')
    expect(new WorldService(tempWorldsDir).loadLore(WORLD)).toBe('# Should not be seen')
  })

  test('a deleted file drops its cache entry and reads empty', () => {
    const service = new WorldService(tempWorldsDir)
    const loreFile = join(tempWorldsDir, WORLD, 'lore.md')

    service.loadLore(WORLD)
    rmSync(loreFile)

    expect(service.loadLore(WORLD)).toBe('')
  })
})

// ============================================================================
// History writes
// ============================================================================

describe('addHistoryEntry', () => {
  beforeEach(() => {
    tempWorldsDir = makeTempWorlds()
  })
  afterEach(() => {
    rmSync(tempWorldsDir, { recursive: true, force: true })
  })

  test('appends a turn heading and invalidates the cached read', () => {
    const service = new WorldService(tempWorldsDir)

    expect(service.loadHistory(WORLD)).toBe('# World History\n\n')
    service.addHistoryEntry(WORLD, 3, 'Old Mill', 'The player oiled the gears.')

    expect(service.loadHistory(WORLD)).toBe(
      '# World History\n\n\n## Turn 3 - Old Mill\nThe player oiled the gears.\n',
    )
  })

  test('a repeated summary is dropped (travel called twice in one turn)', () => {
    const service = new WorldService(tempWorldsDir)

    service.addHistoryEntry(WORLD, 3, 'Old Mill', 'The player oiled the gears.')
    service.addHistoryEntry(WORLD, 3, 'Old Mill', 'The player oiled the gears.')

    const occurrences = service.loadHistory(WORLD).split('## Turn 3').length - 1
    expect(occurrences).toBe(1)
  })

  test('a world with no history.md gets one seeded', () => {
    const service = new WorldService(tempWorldsDir)
    rmSync(join(tempWorldsDir, WORLD, 'history.md'))

    service.addHistoryEntry(WORLD, 1, 'Start', 'It begins.')

    expect(service.loadHistory(WORLD)).toBe('# World History\n\n\n## Turn 1 - Start\nIt begins.\n')
  })
})

// ============================================================================
// consolidated_history.md
// ============================================================================

describe('history subtitles', () => {
  beforeEach(() => {
    tempWorldsDir = makeTempWorlds()
    writeFileSync(
      join(tempWorldsDir, WORLD, 'consolidated_history.md'),
      [
        '# Consolidated History',
        '',
        '## [숲으로의 여정]',
        '일행은 숲으로 향했다.',
        '',
        '## Turn 4 - not a subtitle',
        '',
        '## [폐허 탐사]',
        'They searched the ruins.',
        '',
      ].join('\n'),
      'utf-8',
    )
  })
  afterEach(() => {
    rmSync(tempWorldsDir, { recursive: true, force: true })
  })

  test('only bracketed headings count as subtitles', () => {
    expect(new WorldService(tempWorldsDir).getHistorySubtitles(WORLD)).toEqual([
      '숲으로의 여정',
      '폐허 탐사',
    ])
  })

  test('a section body runs to the next subtitle, not the next heading', () => {
    const service = new WorldService(tempWorldsDir)

    expect(service.getHistoryBySubtitle(WORLD, '숲으로의 여정')).toBe(
      '일행은 숲으로 향했다.\n\n## Turn 4 - not a subtitle',
    )
    expect(service.getHistoryBySubtitle(WORLD, '폐허 탐사')).toBe('They searched the ruins.')
    expect(service.getHistoryBySubtitle(WORLD, 'missing')).toBeNull()
  })
})

// ============================================================================
// PlayerService
// ============================================================================

describe('PlayerService reads', () => {
  const service = new PlayerService(REAL_WORLDS_DIR)

  test('loadPlayerState maps a freshly created player.yaml', () => {
    const state = service.loadPlayerState(WORLD)

    expect(state).not.toBeNull()
    expect(state?.currentLocation).toBeNull()
    expect(state?.turnCount).toBe(0)
    expect(state?.stats).toEqual({})
    expect(state?.inventory).toEqual([])
    expect(state?.effects).toEqual([])
    expect(state?.recentActions).toEqual([])
    expect(state?.equipment).toEqual({})
    expect(state?.flags).toEqual({})
  })

  test('game_time carries the clock used for game_time_snapshot', () => {
    expect(service.loadPlayerState(WORLD)?.gameTime).toEqual({ hour: 8, minute: 0, day: 1 })
  })

  test('a missing player.yaml yields null rather than throwing', () => {
    expect(service.loadPlayerState('no-such-world')).toBeNull()
  })

  test('loadStatDefinitions reads the empty pre-generation shape', () => {
    expect(service.loadStatDefinitions(WORLD)).toEqual({ stats: [], derived: [] })
    expect(service.loadStatDefinitions('no-such-world')).toEqual({ stats: [], derived: [] })
  })
})

describe('savePlayerState', () => {
  beforeEach(() => {
    tempWorldsDir = makeTempWorlds()
  })
  afterEach(() => {
    rmSync(tempWorldsDir, { recursive: true, force: true })
  })

  test('round-trips through snake_case YAML', () => {
    const service = new PlayerService(tempWorldsDir)
    const state = service.loadPlayerState(WORLD)
    expect(state).not.toBeNull()
    if (!state) return

    state.currentLocation = 'old_mill'
    state.turnCount = 7
    state.stats = { hp: 12, sanity: 3 }
    state.inventory = [{ item_id: 'lantern', quantity: 1 }]
    state.gameTime = { hour: 21, minute: 45, day: 4 }
    state.equipment = { main_hand: 'iron_sword', head: null }
    state.flags = { boss_defeated: true }
    service.savePlayerState(WORLD, state)

    const onDisk = parseYaml(readFileSync(join(tempWorldsDir, WORLD, 'player.yaml'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(onDisk.current_location).toBe('old_mill')
    expect(onDisk.turn_count).toBe(7)
    expect(onDisk.game_time).toEqual({ hour: 21, minute: 45, day: 4 })
    expect(onDisk.equipment).toEqual({ main_hand: 'iron_sword', head: null })

    // Reloading must see the write, not the pre-save cache entry.
    expect(service.loadPlayerState(WORLD)).toEqual(state)
  })

  test('recent_actions is truncated to the last 10 entries', () => {
    const service = new PlayerService(tempWorldsDir)
    const state = service.loadPlayerState(WORLD)
    if (!state) throw new Error('fixture world has no player.yaml')

    state.recentActions = Array.from({ length: 14 }, (_, i) => ({ action: `act-${i}` }))
    service.savePlayerState(WORLD, state)

    const saved = service.loadPlayerState(WORLD)
    expect(saved?.recentActions).toHaveLength(10)
    expect(saved?.recentActions[0]).toEqual({ action: 'act-4' })
  })

  test('a malformed player.yaml opens as a default state', () => {
    const service = new PlayerService(tempWorldsDir)
    writeFileSync(join(tempWorldsDir, WORLD, 'player.yaml'), '\tnot: [valid', 'utf-8')

    const state = service.loadPlayerState(WORLD)
    expect(state?.turnCount).toBe(0)
    expect(state?.gameTime).toEqual({ hour: 8, minute: 0, day: 1 })
  })
})

// ============================================================================
// LocationStorage
// ============================================================================

describe('LocationStorage', () => {
  beforeEach(() => {
    tempWorldsDir = makeTempWorlds()
  })
  afterEach(() => {
    rmSync(tempWorldsDir, { recursive: true, force: true })
  })

  function seedLocations(): void {
    const locationsDir = join(tempWorldsDir, WORLD, 'locations')
    mkdirSync(join(locationsDir, 'old_mill'), { recursive: true })
    writeFileSync(join(locationsDir, 'old_mill', 'description.md'), '# The Old Mill\n\nDust and gears.\n')
    writeFileSync(join(locationsDir, 'old_mill', 'events.md'), '# Events at The Old Mill\n\n')
    mkdirSync(join(locationsDir, 'creek'), { recursive: true })

    writeFileSync(
      join(locationsDir, '_index.yaml'),
      [
        'locations:',
        '  old_mill:',
        '    name: The Old Mill',
        '    label: null',
        '    position: [3, 4]',
        '    is_discovered: true',
        '    adjacent: [creek]',
        '    is_draft: false',
        '  creek:',
        '    name: Winding Creek',
        '    label: quiet',
        '    position: [4, 4]',
        '    is_discovered: false',
        '    adjacent: [old_mill]',
        '    is_draft: true',
        '  ghost_town:',
        '    name: Ghost Town',
        '    position: [9, 9]',
        '',
      ].join('\n'),
      'utf-8',
    )
  }

  test('an empty index yields no locations', () => {
    const storage = new LocationStorage(tempWorldsDir)
    expect(storage.loadAllLocations(WORLD)).toEqual({})
    expect(storage.loadLocation(WORLD, 'anywhere')).toBeNull()
  })

  test('loadLocation merges the index row with description.md', () => {
    seedLocations()
    const location = new LocationStorage(tempWorldsDir).loadLocation(WORLD, 'old_mill')

    expect(location).toEqual({
      name: 'old_mill',
      displayName: 'The Old Mill',
      label: null,
      position: [3, 4],
      isDiscovered: true,
      adjacent: ['creek'],
      description: '# The Old Mill\n\nDust and gears.\n',
      isDraft: false,
    })
  })

  test('a location without description.md still loads', () => {
    seedLocations()
    const location = new LocationStorage(tempWorldsDir).loadLocation(WORLD, 'creek')

    expect(location?.description).toBe('')
    expect(location?.isDraft).toBe(true)
    expect(location?.isDiscovered).toBe(false)
    expect(location?.label).toBe('quiet')
  })

  test('an index row with no directory is stale and skipped', () => {
    seedLocations()
    const storage = new LocationStorage(tempWorldsDir)

    expect(Object.keys(storage.loadAllLocations(WORLD))).toEqual(['old_mill', 'creek'])
    expect(storage.loadLocation(WORLD, 'ghost_town')).toBeNull()
  })

  test('loadLocationEvents trims, and is empty when the file is missing', () => {
    seedLocations()
    const storage = new LocationStorage(tempWorldsDir)

    expect(storage.loadLocationEvents(WORLD, 'old_mill')).toBe('# Events at The Old Mill')
    expect(storage.loadLocationEvents(WORLD, 'creek')).toBe('')
  })

  test('a missing world yields no locations rather than throwing', () => {
    expect(new LocationStorage(tempWorldsDir).loadAllLocations('no-such-world')).toEqual({})
  })
})

// ============================================================================
// RoomMappingService
// ============================================================================

describe('RoomMappingService reads', () => {
  const service = new RoomMappingService(REAL_WORLDS_DIR)

  test('loadState maps _state.json', () => {
    const state = service.loadState(WORLD)

    expect(state.currentRoom).toBe('onboarding')
    expect(state.suggestions).toEqual([])
    expect(state.ui).toEqual({})
    expect(state.lastUpdated).toBe('2026-08-06T13:14:54.939377')
    expect(state.rooms.onboarding).toEqual({
      dbRoomId: 1,
      agents: ['Onboarding_Manager'],
      createdAt: '2026-08-06T13:14:54.939049',
    })
  })

  test('a missing _state.json opens as empty state', () => {
    const state = service.loadState('no-such-world')

    expect(state.rooms).toEqual({})
    expect(state.currentRoom).toBeNull()
    expect(state.suggestions).toEqual([])
  })

  test('room key helpers round-trip', () => {
    expect(RoomMappingService.locationToRoomKey('old_mill')).toBe('location:old_mill')
    expect(RoomMappingService.roomKeyToLocation('location:old_mill')).toBe('old_mill')
    expect(RoomMappingService.roomKeyToLocation('onboarding')).toBeNull()
  })
})

describe('RoomMappingService writes', () => {
  beforeEach(() => {
    tempWorldsDir = makeTempWorlds()
  })
  afterEach(() => {
    rmSync(tempWorldsDir, { recursive: true, force: true })
  })

  function readStateFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(tempWorldsDir, WORLD, '_state.json'), 'utf-8')) as Record<
      string,
      unknown
    >
  }

  test('setRoomMapping adds a room without disturbing existing ones', () => {
    const service = new RoomMappingService(tempWorldsDir)

    service.setRoomMapping(WORLD, 'location:old_mill', 42, ['프리렌'])

    const mapping = service.getRoomMapping(WORLD, 'location:old_mill')
    expect(mapping?.dbRoomId).toBe(42)
    expect(mapping?.agents).toEqual(['프리렌'])
    expect(mapping?.createdAt).not.toBeNull()
    expect(service.getRoomId(WORLD, 'onboarding')).toBe(1)
    expect(service.getCurrentRoom(WORLD)).toBe('onboarding')
  })

  test('an unmapped room key reads as null', () => {
    expect(new RoomMappingService(tempWorldsDir).getRoomMapping(WORLD, 'chat:nobody')).toBeNull()
  })

  test('room mappings are persisted in snake_case', () => {
    new RoomMappingService(tempWorldsDir).setRoomMapping(WORLD, 'chat:크리스', 7)

    const rooms = readStateFile().rooms as Record<string, Record<string, unknown>>
    expect(rooms['chat:크리스']?.db_room_id).toBe(7)
    expect(rooms['chat:크리스']?.agents).toEqual([])
  })

  test('saveSuggestions replaces the list and stamps last_updated', () => {
    const service = new RoomMappingService(tempWorldsDir)

    service.saveSuggestions(WORLD, ['문을 연다', '뒤를 돌아본다'])

    expect(service.loadSuggestions(WORLD)).toEqual(['문을 연다', '뒤를 돌아본다'])
    expect(readStateFile().last_updated).not.toBe('2026-08-06T13:14:54.939377')
  })

  test('arrival context is one-shot: the second read is empty', () => {
    const service = new RoomMappingService(tempWorldsDir)

    service.saveArrivalContext(WORLD, {
      previousNarration: '문이 닫혔다.',
      triggeringAction: 'go north',
      fromLocation: 'old_mill',
    })

    expect(service.loadAndClearArrivalContext(WORLD)).toEqual({
      previousNarration: '문이 닫혔다.',
      triggeringAction: 'go north',
      fromLocation: 'old_mill',
    })
    expect(service.loadAndClearArrivalContext(WORLD)).toBeNull()
    expect(readStateFile().ui).toEqual({})
  })

  test('arrival context is stored under ui in snake_case', () => {
    new RoomMappingService(tempWorldsDir).saveArrivalContext(WORLD, {
      previousNarration: 'The door closed.',
      triggeringAction: 'go north',
      fromLocation: 'old_mill',
    })

    expect((readStateFile().ui as Record<string, unknown>).arrival_context).toEqual({
      previous_narration: 'The door closed.',
      triggering_action: 'go north',
      from_location: 'old_mill',
    })
  })

  test('a corrupt _state.json degrades to empty state instead of throwing', () => {
    writeFileSync(join(tempWorldsDir, WORLD, '_state.json'), '{ not json', 'utf-8')

    expect(new RoomMappingService(tempWorldsDir).loadState(WORLD).rooms).toEqual({})
  })
})

// ============================================================================
// Fixture safety
// ============================================================================

test('the checked-in fixture world is never written to', () => {
  // A regression here means a write path leaked out of its temp copy.
  expect(readFileSync(join(REAL_WORLDS_DIR, WORLD, 'lore.md'), 'utf-8')).toBe(
    '# World Lore\n\n*To be written...*\n',
  )
  expect(new WorldService(REAL_WORLDS_DIR).loadHistory(WORLD)).toBe('# World History\n\n')
})
