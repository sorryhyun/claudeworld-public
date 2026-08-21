/**
 * `RoomMappingService` write paths — room occupancy, current room, mapping
 * repair, and the six-tier fuzzy room-key match.
 *
 * `_state.json` is disposable runtime bookkeeping, so these tests build a bare
 * world directory rather than a full world: `saveState` creates what it needs.
 * The fuzzy match's last tier is the exception — it reads the location
 * filesystem, so those tests seed `locations/` too.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocationStorage } from '../services/location-storage'
import { RoomMappingService } from '../services/room-mapping'

const WORLD = 'w'

let worldsDir: string

beforeEach(() => {
  worldsDir = mkdtempSync(join(tmpdir(), 'cw-room-writes-'))
  mkdirSync(join(worldsDir, WORLD, 'locations'), { recursive: true })
  writeFileSync(join(worldsDir, WORLD, 'locations', '_index.yaml'), 'locations: {}\n', 'utf-8')
})
afterEach(() => {
  rmSync(worldsDir, { recursive: true, force: true })
})

function service(): RoomMappingService {
  return new RoomMappingService(worldsDir)
}

function rawState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(worldsDir, WORLD, '_state.json'), 'utf-8')) as Record<
    string,
    unknown
  >
}

/** A location that exists on the filesystem but has no room mapping. */
function seedFilesystemLocation(name: string): void {
  new LocationStorage(worldsDir).createLocation(WORLD, name, name, 'Somewhere.', [0, 0])
}

// ============================================================================
// Current room
// ============================================================================

describe('setCurrentRoom / getCurrentRoomId', () => {
  test('points the world at a mapped room and resolves its id', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42)

    rooms.setCurrentRoom(WORLD, 'location:old_mill')

    expect(rooms.getCurrentRoom(WORLD)).toBe('location:old_mill')
    expect(rooms.getCurrentRoomId(WORLD)).toBe(42)
    expect(rawState().current_room).toBe('location:old_mill')
  })

  test('no current room means no current room id', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'onboarding', 1)

    expect(rooms.getCurrentRoomId(WORLD)).toBeNull()
  })

  test('an unmapped key is accepted and reads back with a null id', () => {
    const rooms = service()
    rooms.setCurrentRoom(WORLD, 'location:nowhere')

    expect(rooms.getCurrentRoom(WORLD)).toBe('location:nowhere')
    expect(rooms.getCurrentRoomId(WORLD)).toBeNull()
  })

  test('switching rooms leaves the mappings alone', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'onboarding', 1, ['Onboarding_Manager'])
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42)

    rooms.setCurrentRoom(WORLD, 'onboarding')
    rooms.setCurrentRoom(WORLD, 'location:old_mill')

    expect(rooms.getRoomMapping(WORLD, 'onboarding')?.agents).toEqual(['Onboarding_Manager'])
    expect(rooms.getCurrentRoomId(WORLD)).toBe(42)
  })
})

// ============================================================================
// findLocationRoomKeyFuzzy — one test per tier, in isolation
// ============================================================================

describe('findLocationRoomKeyFuzzy', () => {
  /** Map exactly one location room, so only one tier can possibly match. */
  function onlyRoom(key: string): RoomMappingService {
    const rooms = service()
    rooms.setRoomMapping(WORLD, key, 7)
    return rooms
  }

  test('tier 1: exact', () => {
    expect(onlyRoom('location:old_mill').findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBe(
      'location:old_mill',
    )
  })

  test('tier 2: case-insensitive exact', () => {
    expect(onlyRoom('location:Old_Mill').findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBe(
      'location:Old_Mill',
    )
  })

  test('tier 3: prefix', () => {
    expect(onlyRoom('location:old_mill_ruins').findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBe(
      'location:old_mill_ruins',
    )
  })

  test('tier 4: contains', () => {
    expect(onlyRoom('location:the_old_mill').findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBe(
      'location:the_old_mill',
    )
  })

  test('tier 5: reverse contains — the model padded the folder name with prose', () => {
    expect(onlyRoom('location:mill').findLocationRoomKeyFuzzy(WORLD, 'The Old Mill')).toBe(
      'location:mill',
    )
  })

  test('tier 6: filesystem fallback for a location that has no room yet', () => {
    seedFilesystemLocation('old_mill')

    // No room mappings at all, so tiers 1-5 have nothing to iterate.
    expect(service().findLocationRoomKeyFuzzy(WORLD, 'OLD_MILL')).toBe('location:old_mill')
  })

  test('tier 6 matches on containment as well as equality', () => {
    seedFilesystemLocation('the_old_mill')
    expect(service().findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBe('location:the_old_mill')
  })

  test('tier order decides: a case-insensitive hit beats an earlier-listed prefix hit', () => {
    const rooms = service()
    // Inserted first, so a single-pass implementation would return it.
    rooms.setRoomMapping(WORLD, 'location:old_mill_ruins', 1)
    rooms.setRoomMapping(WORLD, 'location:OLD_MILL', 2)

    expect(rooms.findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBe('location:OLD_MILL')
  })

  test('a mapped room always beats the filesystem fallback', () => {
    seedFilesystemLocation('old_mill')
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:the_old_mill', 7)

    expect(rooms.findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBe('location:the_old_mill')
  })

  test('non-location room keys are never considered', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'onboarding', 1)
    rooms.setRoomMapping(WORLD, 'chat:old_mill', 2)

    expect(rooms.findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBeNull()
  })

  test('nothing anywhere resolves to null', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:creek', 1)

    expect(rooms.findLocationRoomKeyFuzzy(WORLD, 'old_mill')).toBeNull()
  })
})

// ============================================================================
// Room occupancy
// ============================================================================

describe('addAgentToRoom', () => {
  test('adds an agent to a mapped room', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42)

    expect(rooms.addAgentToRoom(WORLD, 'location:old_mill', '프리렌')).toBe(true)
    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')?.agents).toEqual(['프리렌'])
  })

  test('an agent already in the room reports false and writes nothing', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42, ['프리렌'])
    const before = readFileSync(join(worldsDir, WORLD, '_state.json'), 'utf-8')

    expect(rooms.addAgentToRoom(WORLD, 'location:old_mill', '프리렌')).toBe(false)
    expect(readFileSync(join(worldsDir, WORLD, '_state.json'), 'utf-8')).toBe(before)
  })

  test('a misspelled location key is resolved by fuzzy match', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:Old_Mill', 42)

    expect(rooms.addAgentToRoom(WORLD, 'location:old_mill', '프리렌')).toBe(true)

    expect(rooms.getRoomMapping(WORLD, 'location:Old_Mill')?.agents).toEqual(['프리렌'])
    // The misspelling itself must not become a second room.
    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')).toBeNull()
  })

  test('an unmapped location room is auto-created with a placeholder id', () => {
    const rooms = service()

    expect(rooms.addAgentToRoom(WORLD, 'location:old_mill', '프리렌')).toBe(true)

    const mapping = rooms.getRoomMapping(WORLD, 'location:old_mill')
    // Zero is the placeholder `ensureRoomMappingExists` later repairs; the
    // agent list is what had to survive until the DB row exists.
    expect(mapping?.dbRoomId).toBe(0)
    expect(mapping?.agents).toEqual(['프리렌'])
    expect(mapping?.createdAt).toBeNull()
  })

  test('a non-location room key is not auto-created', () => {
    const rooms = service()

    expect(rooms.addAgentToRoom(WORLD, 'chat:크리스', '크리스')).toBe(false)
    expect(rooms.getRoomMapping(WORLD, 'chat:크리스')).toBeNull()
  })

  test('agents accumulate rather than replace', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42)

    rooms.addAgentToRoom(WORLD, 'location:old_mill', '프리렌')
    rooms.addAgentToRoom(WORLD, 'location:old_mill', '슈타르크')

    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')?.agents).toEqual(['프리렌', '슈타르크'])
  })
})

describe('removeAgentFromRoom', () => {
  test('removes an agent and leaves the rest', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42, ['프리렌', '슈타르크'])

    expect(rooms.removeAgentFromRoom(WORLD, 'location:old_mill', '프리렌')).toBe(true)
    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')?.agents).toEqual(['슈타르크'])
  })

  test('an agent who is not there reports false', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42, ['슈타르크'])

    expect(rooms.removeAgentFromRoom(WORLD, 'location:old_mill', '프리렌')).toBe(false)
    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')?.agents).toEqual(['슈타르크'])
  })

  test('a misspelled location key is resolved by fuzzy match', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:Old_Mill', 42, ['프리렌'])

    expect(rooms.removeAgentFromRoom(WORLD, 'location:old_mill', '프리렌')).toBe(true)
    expect(rooms.getRoomMapping(WORLD, 'location:Old_Mill')?.agents).toEqual([])
  })

  test('an unmapped room reports false and is never auto-created', () => {
    const rooms = service()

    expect(rooms.removeAgentFromRoom(WORLD, 'location:old_mill', '프리렌')).toBe(false)
    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')).toBeNull()
  })
})

// ============================================================================
// deleteRoomMapping
// ============================================================================

describe('deleteRoomMapping', () => {
  test('forgets the room and clears current_room when it pointed there', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42)
    rooms.setCurrentRoom(WORLD, 'location:old_mill')

    expect(rooms.deleteRoomMapping(WORLD, 'location:old_mill')).toBe(true)

    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')).toBeNull()
    expect(rooms.getCurrentRoom(WORLD)).toBeNull()
    expect(rawState().current_room).toBeNull()
  })

  test('a current room elsewhere is left pointing where it was', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'onboarding', 1)
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42)
    rooms.setCurrentRoom(WORLD, 'onboarding')

    rooms.deleteRoomMapping(WORLD, 'location:old_mill')

    expect(rooms.getCurrentRoom(WORLD)).toBe('onboarding')
    expect(rooms.getRoomId(WORLD, 'onboarding')).toBe(1)
  })

  test('deleting a room that is not mapped reports false', () => {
    expect(service().deleteRoomMapping(WORLD, 'location:nowhere')).toBe(false)
  })

  test('the delete is exact — a fuzzy near-match is not deleted', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:Old_Mill', 42)

    expect(rooms.deleteRoomMapping(WORLD, 'location:old_mill')).toBe(false)
    expect(rooms.getRoomMapping(WORLD, 'location:Old_Mill')?.dbRoomId).toBe(42)
  })
})

// ============================================================================
// ensureRoomMappingExists
// ============================================================================

describe('ensureRoomMappingExists', () => {
  test('creates a missing mapping and reports that it did', () => {
    const rooms = service()

    expect(rooms.ensureRoomMappingExists(WORLD, 'onboarding', 1, ['Onboarding_Manager'])).toBe(true)

    const mapping = rooms.getRoomMapping(WORLD, 'onboarding')
    expect(mapping?.dbRoomId).toBe(1)
    expect(mapping?.agents).toEqual(['Onboarding_Manager'])
    expect(mapping?.createdAt).not.toBeNull()
  })

  test('repairs a mapping whose db_room_id disagrees with the database', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42, ['프리렌'])

    // The caller holds the id the database just gave it; the file is wrong.
    expect(rooms.ensureRoomMappingExists(WORLD, 'location:old_mill', 99)).toBe(false)

    const mapping = rooms.getRoomMapping(WORLD, 'location:old_mill')
    expect(mapping?.dbRoomId).toBe(99)
    // The repair replaces the id only — occupancy is not the caller's to know.
    expect(mapping?.agents).toEqual(['프리렌'])
  })

  test('repairs the placeholder id left by addAgentToRoom auto-creation', () => {
    const rooms = service()
    rooms.addAgentToRoom(WORLD, 'location:old_mill', '프리렌')
    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')?.dbRoomId).toBe(0)

    rooms.ensureRoomMappingExists(WORLD, 'location:old_mill', 42)

    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')?.dbRoomId).toBe(42)
    expect(rooms.getRoomMapping(WORLD, 'location:old_mill')?.agents).toEqual(['프리렌'])
  })

  test('a correct mapping is left byte-identical — no restamp, no churn', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:old_mill', 42, ['프리렌'])
    const before = readFileSync(join(worldsDir, WORLD, '_state.json'), 'utf-8')

    expect(rooms.ensureRoomMappingExists(WORLD, 'location:old_mill', 42, ['someone else'])).toBe(false)

    expect(readFileSync(join(worldsDir, WORLD, '_state.json'), 'utf-8')).toBe(before)
  })

  test('is exact — a fuzzy near-match is a separate room', () => {
    const rooms = service()
    rooms.setRoomMapping(WORLD, 'location:Old_Mill', 42)

    expect(rooms.ensureRoomMappingExists(WORLD, 'location:old_mill', 99)).toBe(true)

    expect(rooms.getRoomId(WORLD, 'location:Old_Mill')).toBe(42)
    expect(rooms.getRoomId(WORLD, 'location:old_mill')).toBe(99)
  })
})
