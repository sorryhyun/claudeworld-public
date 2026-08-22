/**
 * Location writes and the character↔location relationship — `crud/locations.ts`.
 *
 * The schema comes from the committed Drizzle baseline rather than from an
 * inlined `.schema` dump; see the header of `crud-rooms-agents.test.ts` for why
 * that is equivalent and which test guards the equivalence.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, type Db } from '../db'
import { openAndInitDb } from '../db/migrate'
import { agents, locations, messages, rooms, worlds } from '../db/schema'
import {
  addAdjacentLocation,
  addCharacterToLocation,
  createLocation,
  createNewRoomForLocation,
  createRoom,
  deleteLocation,
  getAgentLocationsInWorld,
  getAgentsInRoom,
  getAllCharactersInWorld,
  getCharactersAtLocation,
  getLocation,
  getLocationByName,
  getLocations,
  moveCharacterToLocation,
  removeCharacterFromLocation,
  syncLocationsWithFilesystem,
  updateLocation,
  updateLocationLabel,
  type LocationFilesystemSync,
} from '../crud'
import { getCache } from '../infrastructure/cache'

const WORLD_ID = 1
const WORLD_NAME = 'testworld'
const OWNER = 'admin'
const ACTION_MANAGER_ID = 1
const NARRATOR_ID = 2
const ELRIC_ID = 3
const SEER_ID = 4

let dir: string
let dbPath: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-locations-'))
  dbPath = join(dir, 'test.db')

  const created = openAndInitDb({ path: dbPath })
  created.close()

  db = openDb({ path: dbPath })
  seed()
  getCache().clear()
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function seed(): void {
  db.insert(worlds)
    .values({ id: WORLD_ID, name: WORLD_NAME, ownerId: OWNER, phase: 'active', language: 'en' })
    .run()

  db.insert(agents)
    .values([
      { id: ACTION_MANAGER_ID, name: 'Action_Manager', group: 'gameplay', systemPrompt: 'p' },
      { id: NARRATOR_ID, name: 'Narrator', group: 'gameplay', systemPrompt: 'p' },
      // Ungrouped: a hand-made character, which the system-agent filter must keep.
      { id: ELRIC_ID, name: 'Elric', group: null, worldName: WORLD_NAME, systemPrompt: 'p' },
      { id: SEER_ID, name: 'Seer', group: WORLD_NAME, worldName: WORLD_NAME, systemPrompt: 'p' },
    ])
    .run()
}

/** `rooms.id = ?`, spelled once so the room lookups below stay readable. */
function roomIs(id: number) {
  return eq(rooms.id, id)
}

function rawValue<T>(sql: string): T | null {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const row = raw.query<Record<string, T>, []>(sql).get()
    return row ? (Object.values(row)[0] as T) : null
  } finally {
    raw.close()
  }
}

// ============================================================================
// createLocation
// ============================================================================

describe('createLocation', () => {
  test('creates the location, its room, and staffs the room with gameplay agents', () => {
    const location = createLocation(db, WORLD_ID, {
      name: 'old_mill',
      displayName: 'Old Mill',
      description: 'A creaking wheel.',
    })

    expect(location.worldId).toBe(WORLD_ID)
    expect(location.roomId).not.toBeNull()

    const room = db.select().from(rooms).where(roomIs(location.roomId!)).get()!
    // The room is named from display_name when there is one, and scoped to the
    // world's owner rather than a global "system" account.
    expect(room.name).toBe('Location: Old Mill')
    expect(room.ownerId).toBe(OWNER)
    expect(room.worldId).toBe(WORLD_ID)

    expect(getAgentsInRoom(db, location.roomId!).map((a) => a.id).sort()).toEqual([
      ACTION_MANAGER_ID,
      NARRATOR_ID,
    ])

    // Defaults from schemas.LocationCreate.
    expect(location.positionX).toBe(0)
    expect(location.positionY).toBe(0)
    expect(location.isDiscovered).toBe(true)
    expect(location.isDraft).toBe(false)
  })

  test('falls back to the folder name when there is no display name', () => {
    const location = createLocation(db, WORLD_ID, { name: 'old_mill' })
    expect(db.select().from(rooms).where(roomIs(location.roomId!)).get()!.name).toBe(
      'Location: old_mill',
    )
  })

  test('reuses an orphaned room left by a failed earlier attempt', () => {
    // Python commits the room before the location, so a crash in between leaves
    // exactly this: a correctly named, correctly scoped room with no location.
    const orphan = createRoom(db, { name: 'Location: Old Mill' }, OWNER, WORLD_ID)

    const location = createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })

    expect(location.roomId).toBe(orphan.id)
    // Not a second room with the same name — that would violate
    // ux_rooms_owner_name_world anyway.
    expect(db.select().from(rooms).all()).toHaveLength(1)
    // The reused room still gets staffed.
    expect(getAgentsInRoom(db, orphan.id)).toHaveLength(2)
  })

  test('a same-named room in another world is not mistaken for the orphan', () => {
    db.insert(worlds).values({ id: 2, name: 'elsewhere', ownerId: OWNER, phase: 'active' }).run()
    const other = createRoom(db, { name: 'Location: Old Mill' }, OWNER, 2)

    const location = createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })

    expect(location.roomId).not.toBe(other.id)
  })

  test('an empty adjacency list is stored as NULL, not "[]"', () => {
    const empty = createLocation(db, WORLD_ID, { name: 'a', adjacentTo: [] })
    const populated = createLocation(db, WORLD_ID, { name: 'b', adjacentTo: [empty.id] })

    // Python's `json.dumps(x) if x else None` — an empty list is falsy there.
    expect(rawValue<string>(`SELECT adjacent_locations FROM locations WHERE id = ${empty.id}`)).toBeNull()
    expect(populated.adjacentLocations).toBe(`[${empty.id}]`)
  })

  test('throws for an unknown world instead of writing a stray room', () => {
    expect(() => createLocation(db, 9999, { name: 'nowhere' })).toThrow('World 9999 not found')
    expect(db.select().from(rooms).all()).toEqual([])
  })
})

// ============================================================================
// createNewRoomForLocation
// ============================================================================

describe('createNewRoomForLocation', () => {
  test('repoints the location and keeps the previous room for history', () => {
    const location = createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })
    const firstRoomId = location.roomId!
    db.insert(messages)
      .values({ roomId: firstRoomId, content: 'the first visit', role: 'user', timestamp: new Date() })
      .run()

    const fresh = createNewRoomForLocation(db, location)

    expect(fresh.id).not.toBe(firstRoomId)
    expect(getLocation(db, location.id)!.roomId).toBe(fresh.id)
    // The old room is deliberately left behind: it holds the transcript of the
    // previous visit, which is the whole reason a new room is made.
    expect(db.select().from(rooms).where(roomIs(firstRoomId)).get()).toBeDefined()
    expect(rawValue<number>(`SELECT count(*) FROM messages WHERE room_id = ${firstRoomId}`)).toBe(1)

    // Uniqueness across visits comes from the timestamp suffix.
    expect(fresh.name).toMatch(/^Location: Old Mill \[\d{8}_\d{6}\]$/)
    expect(getAgentsInRoom(db, fresh.id)).toHaveLength(2)
  })
})

// ============================================================================
// getLocationByName
// ============================================================================

describe('getLocationByName', () => {
  beforeEach(() => {
    // Deliberately adversarial: `old_mill` and `Old Mill` are two different
    // locations, which is what makes the stage ordering observable.
    createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })
    createLocation(db, WORLD_ID, { name: 'Old Mill', displayName: 'The Wheelhouse' })
    createLocation(db, WORLD_ID, { name: 'deep_cave' })
    createLocation(db, WORLD_ID, { name: 'ruins', displayName: 'Sunken_Halls' })
  })

  test('stage 1: exact name, case-insensitively', () => {
    expect(getLocationByName(db, WORLD_ID, 'OLD_MILL')?.name).toBe('old_mill')
    expect(getLocationByName(db, WORLD_ID, 'old_mill')?.name).toBe('old_mill')
  })

  test('stage 1 beats stage 2 — an exact name match wins over a display name', () => {
    // 'old mill' matches the *name* of the second location exactly, and the
    // *display name* of the first. Collapsing the stages into one OR would let
    // either win; the contract is that the name does.
    expect(getLocationByName(db, WORLD_ID, 'old mill')?.name).toBe('Old Mill')
  })

  test('stage 2: exact display name', () => {
    expect(getLocationByName(db, WORLD_ID, 'the wheelhouse')?.name).toBe('Old Mill')
  })

  test('stage 3: normalized name, when no display name can match', () => {
    // `deep_cave` has no display_name, so stages 1 and 2 both miss and the
    // space→underscore normalization is what finds it.
    expect(getLocationByName(db, WORLD_ID, 'deep cave')?.name).toBe('deep_cave')
    expect(getLocationByName(db, WORLD_ID, 'Deep Cave')?.name).toBe('deep_cave')
  })

  test('stage 4: normalized display name', () => {
    expect(getLocationByName(db, WORLD_ID, 'sunken halls')?.name).toBe('ruins')
  })

  test('carries the room along, and returns null for a miss', () => {
    const found = getLocationByName(db, WORLD_ID, 'deep_cave')!
    expect(found.room?.name).toBe('Location: deep_cave')

    expect(getLocationByName(db, WORLD_ID, 'atlantis')).toBeNull()
    // World-scoped: the right name in the wrong world is still a miss.
    expect(getLocationByName(db, 9999, 'deep_cave')).toBeNull()
  })
})

// ============================================================================
// deleteLocation / syncLocationsWithFilesystem
// ============================================================================

describe('deleteLocation', () => {
  test('removes the location, its room, and the room transcript', () => {
    const location = createLocation(db, WORLD_ID, { name: 'old_mill' })
    const roomId = location.roomId!
    db.insert(messages)
      .values({ roomId, content: 'hi', role: 'user', timestamp: new Date() })
      .run()

    expect(deleteLocation(db, location.id)).toBe(true)

    expect(getLocation(db, location.id)).toBeNull()
    expect(db.select().from(rooms).where(roomIs(roomId)).get()).toBeUndefined()
    // messages.room_id is ON DELETE CASCADE, which is what actually reclaims
    // the transcript — so the pragma had better be on.
    expect(rawValue<number>(`SELECT count(*) FROM messages WHERE room_id = ${roomId}`)).toBe(0)
  })

  test('false for an unknown location', () => {
    expect(deleteLocation(db, 9999)).toBe(false)
  })
})

describe('syncLocationsWithFilesystem', () => {
  test('deletes the rows with no directory on disk and clears their room mapping', () => {
    const village = createLocation(db, WORLD_ID, { name: 'village' })
    const mill = createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })

    const cleared: string[] = []
    const filesystem: LocationFilesystemSync = {
      loadAllLocations: () => ({ village: {} }),
      deleteRoomMapping: (_world, roomKey) => void cleared.push(roomKey),
    }

    expect(syncLocationsWithFilesystem(db, WORLD_ID, WORLD_NAME, filesystem)).toBe(1)

    expect(getLocations(db, WORLD_ID).map((l) => l.name)).toEqual(['village'])
    expect(getLocation(db, village.id)).not.toBeNull()
    // The key is built from `name`, never `display_name`.
    expect(cleared).toEqual(['location:old_mill'])
    expect(db.select().from(rooms).where(roomIs(mill.roomId!)).get()).toBeUndefined()
  })

  test('renaming only the display name does not delete anything', () => {
    createLocation(db, WORLD_ID, { name: 'village', displayName: 'Hamlet of Nowhere' })

    const deleted = syncLocationsWithFilesystem(db, WORLD_ID, WORLD_NAME, {
      loadAllLocations: () => ({ village: {} }),
      deleteRoomMapping: () => {},
    })

    expect(deleted).toBe(0)
    expect(getLocations(db, WORLD_ID)).toHaveLength(1)
  })
})

// ============================================================================
// updateLocation / updateLocationLabel / addAdjacentLocation
// ============================================================================

describe('updateLocation', () => {
  test('a null clears a nullable column; an absent key leaves it alone', () => {
    const location = createLocation(db, WORLD_ID, {
      name: 'old_mill',
      displayName: 'Old Mill',
      description: 'A creaking wheel.',
    })
    updateLocationLabel(db, location.id, 'home')

    // `null` means "write NULL" — Python's model_dump(exclude_unset=True) puts
    // an explicitly-set None into the patch.
    const cleared = updateLocation(db, location.id, { label: null })!
    expect(cleared.label).toBeNull()
    expect(cleared.description).toBe('A creaking wheel.')
    expect(cleared.displayName).toBe('Old Mill')

    updateLocationLabel(db, location.id, 'home')

    // An absent key is not in the patch at all, so the column survives — this
    // is the case that a naive "skip the nulls" implementation gets right and a
    // naive "write everything" implementation destroys.
    const untouched = updateLocation(db, location.id, { description: 'Rebuilt.' })!
    expect(untouched.label).toBe('home')
    expect(untouched.description).toBe('Rebuilt.')

    // `undefined` is spelled-out absence and must behave identically.
    const alsoUntouched = updateLocation(db, location.id, { label: undefined })!
    expect(alsoUntouched.label).toBe('home')
  })

  test('applies positions and flags, and tolerates an empty patch', () => {
    const location = createLocation(db, WORLD_ID, { name: 'old_mill' })

    const moved = updateLocation(db, location.id, {
      positionX: 4,
      positionY: -2,
      isDiscovered: false,
      isDraft: true,
    })!
    expect([moved.positionX, moved.positionY]).toEqual([4, -2])
    expect(moved.isDiscovered).toBe(false)
    expect(moved.isDraft).toBe(true)

    // Drizzle rejects an empty SET clause; the port returns the row instead.
    expect(updateLocation(db, location.id, {})?.positionX).toBe(4)
  })

  test('returns null for an unknown location', () => {
    expect(updateLocation(db, 9999, { label: 'x' })).toBeNull()
    expect(updateLocationLabel(db, 9999, 'x')).toBeNull()
  })
})

describe('addAdjacentLocation', () => {
  test('appends once, and leaves the row alone on a repeat', () => {
    const from = createLocation(db, WORLD_ID, { name: 'village' })
    const to = createLocation(db, WORLD_ID, { name: 'old_mill' })

    expect(addAdjacentLocation(db, from.id, to.id)?.adjacentLocations).toBe(`[${to.id}]`)
    expect(addAdjacentLocation(db, from.id, to.id)?.adjacentLocations).toBe(`[${to.id}]`)

    const third = createLocation(db, WORLD_ID, { name: 'ruins' })
    expect(addAdjacentLocation(db, from.id, third.id)?.adjacentLocations).toBe(
      `[${to.id},${third.id}]`,
    )

    // One-way by design: Python does not add the reverse edge either.
    expect(getLocation(db, to.id)!.adjacentLocations).toBeNull()
    expect(addAdjacentLocation(db, 9999, to.id)).toBeNull()
  })
})

// ============================================================================
// Characters
// ============================================================================

describe('character placement', () => {
  test('add, remove and move a character between locations', () => {
    const village = createLocation(db, WORLD_ID, { name: 'village' })
    const mill = createLocation(db, WORLD_ID, { name: 'old_mill' })

    expect(addCharacterToLocation(db, ELRIC_ID, village.id)).toBe(true)
    expect(getCharactersAtLocation(db, village.id).map((a) => a.name)).toEqual(['Elric'])
    // The gameplay agents share the room but are machinery, not cast.
    expect(getCharactersAtLocation(db, village.id, { excludeSystemAgents: false })).toHaveLength(3)

    expect(moveCharacterToLocation(db, ELRIC_ID, village.id, mill.id)).toBe(true)
    expect(getCharactersAtLocation(db, village.id)).toEqual([])
    expect(getCharactersAtLocation(db, mill.id).map((a) => a.name)).toEqual(['Elric'])

    expect(removeCharacterFromLocation(db, ELRIC_ID, mill.id)).toBe(true)
    expect(getCharactersAtLocation(db, mill.id)).toEqual([])
  })

  test('a first placement passes a null origin', () => {
    const village = createLocation(db, WORLD_ID, { name: 'village' })
    expect(moveCharacterToLocation(db, ELRIC_ID, null, village.id)).toBe(true)
    expect(getCharactersAtLocation(db, village.id).map((a) => a.name)).toEqual(['Elric'])
  })

  test('false when the location has no room at all', () => {
    // A location can exist without a room — room_id is nullable and ON DELETE
    // SET NULL — and then it simply cannot hold characters.
    const roomless = db
      .insert(locations)
      .values({ worldId: WORLD_ID, name: 'limbo', roomId: null })
      .returning()
      .get()

    expect(addCharacterToLocation(db, ELRIC_ID, roomless.id)).toBe(false)
    expect(removeCharacterFromLocation(db, ELRIC_ID, roomless.id)).toBe(false)
    expect(addCharacterToLocation(db, ELRIC_ID, 9999)).toBe(false)
  })
})

describe('getAgentLocationsInWorld', () => {
  test('returns every location the agent stands in, by id', () => {
    const village = createLocation(db, WORLD_ID, { name: 'village' })
    const mill = createLocation(db, WORLD_ID, { name: 'old_mill' })
    createLocation(db, WORLD_ID, { name: 'ruins' })

    addCharacterToLocation(db, ELRIC_ID, village.id)
    addCharacterToLocation(db, ELRIC_ID, mill.id)

    expect(getAgentLocationsInWorld(db, ELRIC_ID, WORLD_ID).map((l) => l.id)).toEqual([
      village.id,
      mill.id,
    ])
    expect(getAgentLocationsInWorld(db, SEER_ID, WORLD_ID)).toEqual([])
    expect(getAgentLocationsInWorld(db, ELRIC_ID, 9999)).toEqual([])
  })
})

describe('getAllCharactersInWorld', () => {
  test('one entry per character, at the first location holding them', () => {
    const village = createLocation(db, WORLD_ID, { name: 'village', displayName: 'The Village' })
    const mill = createLocation(db, WORLD_ID, { name: 'old_mill' })

    // Elric is in both rooms; the listing must not report him twice.
    addCharacterToLocation(db, ELRIC_ID, village.id)
    addCharacterToLocation(db, ELRIC_ID, mill.id)
    addCharacterToLocation(db, SEER_ID, mill.id)

    const characters = getAllCharactersInWorld(db, WORLD_ID)

    // snake_case keys: this object is the /worlds/{id}/characters body verbatim.
    expect(characters).toEqual([
      {
        id: ELRIC_ID,
        name: 'Elric',
        profile_pic: null,
        in_a_nutshell: null,
        location_id: village.id,
        location_name: 'The Village',
      },
      {
        id: SEER_ID,
        name: 'Seer',
        profile_pic: null,
        in_a_nutshell: null,
        location_id: mill.id,
        // No display_name, so the folder name is the label.
        location_name: 'old_mill',
      },
    ])
  })

  test('keeps ungrouped agents and drops the gameplay ones', () => {
    const village = createLocation(db, WORLD_ID, { name: 'village' })
    addCharacterToLocation(db, ELRIC_ID, village.id)

    // Elric's `group` is NULL. In SQL, `group NOT IN (...)` is NULL for a NULL
    // group and would exclude him; Python's `None in {...}` is False and keeps
    // him. Hand-made characters are exactly the ones with no group.
    expect(getAllCharactersInWorld(db, WORLD_ID).map((c) => c.name)).toEqual(['Elric'])

    expect(getAllCharactersInWorld(db, WORLD_ID, { excludeSystemAgents: false }).map((c) => c.name).sort()).toEqual(
      ['Action_Manager', 'Elric', 'Narrator'],
    )
  })

  test('empty for a world with no locations', () => {
    expect(getAllCharactersInWorld(db, WORLD_ID)).toEqual([])
    expect(getAllCharactersInWorld(db, 9999)).toEqual([])
  })
})
