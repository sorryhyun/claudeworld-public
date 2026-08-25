/**
 * World lifecycle CRUD.
 *
 * The three interesting properties here are all structural rather than
 * behavioural, and all three are silent when broken:
 *
 * 1. **Creating a world creates three rows in three tables.** A world without a
 *    player state renders as a broken game panel, not an error.
 * 2. **Deleting one leaves nothing behind.** The FK cycle between `worlds` and
 *    `rooms` means the delete order is load-bearing; the wrong order orphans
 *    rooms, messages and world-scoped agents instead of failing.
 * 3. **The world picker's ordering depends on `NULLS FIRST`**, which SQLite and
 *    PostgreSQL disagree about under `DESC`.
 *
 * Schema comes from the Drizzle migrations (see the note at the top of
 * `crud-messages.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMessage } from '@/crud/messages'
import { createRoom } from '@/crud/rooms'
import {
  createWorld,
  deleteWorld,
  getWorld,
  getWorldByName,
  getWorldsByOwner,
  importWorldFromFilesystem,
  updateWorld,
} from '@/crud/worlds'
import { openDb, type Db } from '@/db'
import { agents, locations, worlds } from '@/db/schema'
import { applyMigrations, loadMigrations } from '@/db/migrate'
import { PlayerService } from '@/services/player-service'
import { RoomMappingService } from '@/services/room-mapping'
import type { WorldConfig } from '@/services/world-service'

const migrations = loadMigrations()

const OWNER = 'admin'
const OTHER_OWNER = 'guest-7'

let dir: string
let dbPath: string
let worldsDir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-worlds-'))
  dbPath = join(dir, 'test.db')
  worldsDir = join(dir, 'worlds')
  mkdirSync(worldsDir, { recursive: true })

  const raw = new Database(dbPath, { create: true, strict: true })
  try {
    applyMigrations(raw, migrations)
  } finally {
    raw.close()
  }

  db = openDb({ path: dbPath })
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Read a column back through raw SQL, bypassing the Drizzle decoders.
 *
 * Issued on the live handle rather than a second read-only connection: the
 * database is in WAL mode, and a read-only opener cannot create the `-shm`
 * file, so it fails outright against a database nothing has written yet.
 */
function rawValue<T>(sql: string): T {
  const row = db.$client.query<Record<string, T>, []>(sql).get()
  if (!row) throw new Error(`no row for: ${sql}`)
  return Object.values(row)[0] as T
}

function countRows(table: string): number {
  return rawValue<number>(`SELECT count(*) FROM ${table}`)
}

describe('createWorld', () => {
  test('creates the onboarding room, the world and an empty player state', () => {
    const world = createWorld(db, { name: 'asdf', userName: '손님', language: 'ko' }, OWNER)

    expect(world.name).toBe('asdf')
    expect(world.ownerId).toBe(OWNER)
    expect(world.phase).toBe('onboarding')
    expect(world.language).toBe('ko')

    // The room exists, is named for the world, and points back at it — the
    // back-link is what makes the world's rooms deletable later.
    expect(world.onboardingRoom?.name).toBe('Onboarding: asdf')
    expect(world.onboardingRoom?.ownerId).toBe(OWNER)
    expect(
      rawValue<number>(`SELECT world_id FROM rooms WHERE id = ${world.onboardingRoom!.id}`),
    ).toBe(world.id)

    // Empty *collections*, not NULLs: `worlds.py:108-115` hardcodes the JSON
    // literals, and a NULL here would read back as "column never initialised".
    expect(world.playerState?.turnCount).toBe(0)
    expect(rawValue<string>(`SELECT stats FROM player_states WHERE world_id = ${world.id}`)).toBe(
      '{}',
    )
    expect(
      rawValue<string>(`SELECT inventory FROM player_states WHERE world_id = ${world.id}`),
    ).toBe('[]')
    expect(rawValue<string>(`SELECT effects FROM player_states WHERE world_id = ${world.id}`)).toBe(
      '[]',
    )
    expect(
      rawValue<string>(`SELECT action_history FROM player_states WHERE world_id = ${world.id}`),
    ).toBe('[]')
  })

  test('stamps created_at and updated_at in SQLAlchemy text form', () => {
    const world = createWorld(db, { name: 'asdf' }, OWNER)
    const shape = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/

    // The ORM applies these defaults, so they emit no DDL default — leave them
    // out of the insert and Python reads NULLs where it expects timestamps.
    expect(rawValue<string>(`SELECT created_at FROM worlds WHERE id = ${world.id}`)).toMatch(shape)
    expect(rawValue<string>(`SELECT updated_at FROM worlds WHERE id = ${world.id}`)).toMatch(shape)
    expect(world.lastPlayedAt).toBeNull()
  })

  test('defaults language to English and user_name to NULL', () => {
    const world = createWorld(db, { name: 'asdf' }, OWNER)
    expect(world.language).toBe('en')
    expect(world.userName).toBeNull()
  })

  test('reuses an onboarding room left behind by a failed attempt', () => {
    const orphan = createRoom(db, { name: 'Onboarding: asdf' }, OWNER)
    const world = createWorld(db, { name: 'asdf' }, OWNER)

    expect(world.onboardingRoom?.id).toBe(orphan.id)
    expect(countRows('rooms')).toBe(1)
  })

  test('does not adopt another owner’s identically named room', () => {
    const theirs = createRoom(db, { name: 'Onboarding: asdf' }, OTHER_OWNER)
    const world = createWorld(db, { name: 'asdf' }, OWNER)

    expect(world.onboardingRoom?.id).not.toBe(theirs.id)
    expect(countRows('rooms')).toBe(2)
  })

  test('rolls the whole thing back when the world insert fails', () => {
    createWorld(db, { name: 'asdf' }, OWNER)
    const roomsBefore = countRows('rooms')

    // Same (owner, name) violates ux_worlds_owner_name. The onboarding room is
    // reused rather than created here, so what this really pins is that a
    // failed create leaves no *new* rows of any kind.
    expect(() => createWorld(db, { name: 'asdf' }, OWNER)).toThrow()
    expect(countRows('rooms')).toBe(roomsBefore)
    expect(countRows('worlds')).toBe(1)
    expect(countRows('player_states')).toBe(1)
  })
})

describe('getWorldByName', () => {
  test('is scoped to the owner', () => {
    const mine = createWorld(db, { name: 'asdf' }, OWNER)
    const theirs = createWorld(db, { name: 'asdf' }, OTHER_OWNER)

    expect(getWorldByName(db, 'asdf', OWNER)?.id).toBe(mine.id)
    expect(getWorldByName(db, 'asdf', OTHER_OWNER)?.id).toBe(theirs.id)
    expect(getWorldByName(db, 'nope', OWNER)).toBeNull()
  })

  test('null means the ownerless worlds, not "any owner"', () => {
    createWorld(db, { name: 'asdf' }, OWNER)
    // `owner_id` is nullable, and Python's `== None` renders IS NULL. A world
    // with an owner must not answer a null-owner lookup.
    expect(getWorldByName(db, 'asdf', null)).toBeNull()

    db.insert(worlds).values({ name: 'legacy', ownerId: null, phase: 'active' }).run()
    expect(getWorldByName(db, 'legacy', null)?.name).toBe('legacy')
    expect(getWorldByName(db, 'legacy', OWNER)).toBeNull()
  })
})

describe('getWorldsByOwner', () => {
  test('orders by last_played_at descending with NULLs first', () => {
    createWorld(db, { name: 'never-played' }, OWNER)
    const old = createWorld(db, { name: 'old' }, OWNER)
    const recent = createWorld(db, { name: 'recent' }, OWNER)

    db.update(worlds)
      .set({ lastPlayedAt: new Date(Date.UTC(2026, 0, 1)) })
      .where(eq(worlds.id, old.id))
      .run()
    db.update(worlds)
      .set({ lastPlayedAt: new Date(Date.UTC(2026, 5, 1)) })
      .where(eq(worlds.id, recent.id))
      .run()

    // SQLite sorts NULL below every value, so a bare DESC would put the
    // never-played world *last* — i.e. a world the user just created would
    // appear at the bottom of the picker.
    expect(getWorldsByOwner(db, OWNER).map((w) => w.name)).toEqual([
      'never-played',
      'recent',
      'old',
    ])
  })

  test('returns only that owner’s worlds', () => {
    createWorld(db, { name: 'mine' }, OWNER)
    createWorld(db, { name: 'theirs' }, OTHER_OWNER)

    expect(getWorldsByOwner(db, OWNER).map((w) => w.name)).toEqual(['mine'])
    expect(getWorldsByOwner(db, 'nobody')).toEqual([])
  })
})

describe('updateWorld', () => {
  test('patches only the fields provided and always stamps updated_at', () => {
    const world = createWorld(db, { name: 'asdf', userName: '손님' }, OWNER)
    const before = rawValue<string>(`SELECT updated_at FROM worlds WHERE id = ${world.id}`)

    const updated = updateWorld(db, world.id, { phase: 'active', genre: 'noir' })

    expect(updated?.phase).toBe('active')
    expect(updated?.genre).toBe('noir')
    expect(updated?.theme).toBeNull()
    // Untouched, not overwritten with null.
    expect(updated?.userName).toBe('손님')
    expect(
      rawValue<string>(`SELECT updated_at FROM worlds WHERE id = ${world.id}`) >= before,
    ).toBe(true)
  })

  test('treats null and undefined as "leave alone"', () => {
    const world = createWorld(db, { name: 'asdf', userName: '손님' }, OWNER)
    updateWorld(db, world.id, { phase: 'active' })

    const unchanged = updateWorld(db, world.id, { phase: null, userName: null, genre: undefined })
    expect(unchanged?.phase).toBe('active')
    expect(unchanged?.userName).toBe('손님')
  })

  test('carries a language change onto the row', () => {
    // `set_world_settings` writes `world.json`; the two `syncWorldFromFs` copies
    // are what bring the change to the column every prompt is built off.
    const world = createWorld(db, { name: 'asdf', language: 'en' }, OWNER)
    expect(updateWorld(db, world.id, { language: 'ko' })?.language).toBe('ko')
    expect(updateWorld(db, world.id, { language: null })?.language).toBe('ko')
  })

  test('writes an empty stat_definitions as "{}", not NULL', () => {
    const world = createWorld(db, { name: 'asdf' }, OWNER)
    updateWorld(db, world.id, { statDefinitions: {} })

    // This is the one place this file departs from the "empty collection
    // becomes NULL" convention, and it departs *towards* Python: the guard at
    // `worlds.py:184` is `is not None`, not a truthiness test, so `{}` is
    // json.dumps'd like any other dict. Writing NULL here would make "no stat
    // system configured" and "configured as empty" indistinguishable across
    // the two backends.
    expect(rawValue<string | null>(`SELECT stat_definitions FROM worlds WHERE id = ${world.id}`)).toBe(
      '{}',
    )
  })

  test('serializes a populated stat_definitions', () => {
    const world = createWorld(db, { name: 'asdf' }, OWNER)
    updateWorld(db, world.id, { statDefinitions: { stats: [{ name: 'hp', default: 10 }] } })

    const stored = rawValue<string>(`SELECT stat_definitions FROM worlds WHERE id = ${world.id}`)
    expect(JSON.parse(stored)).toEqual({ stats: [{ name: 'hp', default: 10 }] })
  })

  test('returns null for an unknown world', () => {
    expect(updateWorld(db, 9999, { phase: 'active' })).toBeNull()
  })
})

describe('deleteWorld', () => {
  /** A world with everything that hangs off one: rooms, messages, agents, locations. */
  function seedFullWorld(name: string, owner: string): number {
    const world = createWorld(db, { name }, owner)
    const roomId = world.onboardingRoom!.id

    db.insert(agents).values({ name: `${name}-npc`, worldName: name, systemPrompt: 'p' }).run()
    db.insert(locations).values({ worldId: world.id, name: 'village', roomId }).run()
    createMessage(db, roomId, { content: 'hello', role: 'user' })

    // A second room belonging to the world, as a location room would be.
    createRoom(db, { name: `${name}-village` }, owner, world.id)

    return world.id
  }

  test('leaves no orphan rooms, agents, locations, player state or messages', () => {
    const worldId = seedFullWorld('asdf', OWNER)
    expect(deleteWorld(db, worldId)).toBe(true)

    expect(countRows('worlds')).toBe(0)
    expect(countRows('rooms')).toBe(0)
    expect(countRows('messages')).toBe(0)
    expect(countRows('locations')).toBe(0)
    expect(countRows('player_states')).toBe(0)
    expect(countRows('agents')).toBe(0)
  })

  test('touches nothing belonging to another world', () => {
    const mine = seedFullWorld('mine', OWNER)
    seedFullWorld('theirs', OTHER_OWNER)

    expect(deleteWorld(db, mine)).toBe(true)

    expect(countRows('worlds')).toBe(1)
    expect(countRows('rooms')).toBe(2)
    expect(countRows('messages')).toBe(1)
    expect(countRows('locations')).toBe(1)
    expect(countRows('player_states')).toBe(1)
    // System agents have a NULL world_name and must survive every delete.
    expect(countRows('agents')).toBe(1)
  })

  test('keeps system agents, which are shared across worlds', () => {
    const worldId = seedFullWorld('asdf', OWNER)
    db.insert(agents).values({ name: 'Action_Manager', worldName: null, systemPrompt: 'p' }).run()

    deleteWorld(db, worldId)

    expect(db.select().from(agents).all().map((a) => a.name)).toEqual(['Action_Manager'])
  })

  test('returns false for an unknown world without touching anything', () => {
    const worldId = seedFullWorld('asdf', OWNER)
    expect(deleteWorld(db, 9999)).toBe(false)
    expect(getWorld(db, worldId)).not.toBeNull()
  })
})

describe('importWorldFromFilesystem', () => {
  function services(): { players: PlayerService; rooms: RoomMappingService } {
    return { players: new PlayerService(worldsDir), rooms: new RoomMappingService(worldsDir) }
  }

  function config(overrides: Partial<WorldConfig> = {}): WorldConfig {
    return {
      name: 'saved-world',
      ownerId: null,
      userName: '손님',
      language: 'ko',
      genre: 'noir',
      theme: 'rain',
      phase: 'active',
      createdAt: new Date(Date.UTC(2026, 0, 1)),
      updatedAt: new Date(Date.UTC(2026, 1, 2)),
      settings: {},
      pendingPhase: null,
      ...overrides,
    }
  }

  function writePlayerState(worldName: string, state: unknown): void {
    mkdirSync(join(worldsDir, worldName), { recursive: true })
    writeFileSync(join(worldsDir, worldName, 'player.json'), JSON.stringify(state), 'utf-8')
  }

  function readState(worldName: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(worldsDir, worldName, '_state.json'), 'utf-8'))
  }

  test('creates the room, the world and a player state seeded from player.json', () => {
    writePlayerState('saved-world', {
      turn_count: 12,
      stats: { hp: 7 },
      inventory: [{ item_id: 'lamp' }],
      effects: [],
    })

    const world = importWorldFromFilesystem(db, config(), OWNER, services())

    expect(world.name).toBe('saved-world')
    expect(world.ownerId).toBe(OWNER)
    expect(world.phase).toBe('active')
    expect(world.genre).toBe('noir')
    expect(world.theme).toBe('rain')
    expect(world.language).toBe('ko')
    // Filesystem metadata wins over "now" for both timestamps.
    expect(world.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(world.updatedAt?.toISOString()).toBe('2026-02-02T00:00:00.000Z')

    expect(world.onboardingRoom?.name).toBe('World: saved-world')
    expect(
      rawValue<number>(`SELECT world_id FROM rooms WHERE id = ${world.onboardingRoom!.id}`),
    ).toBe(world.id)

    expect(world.playerState?.turnCount).toBe(12)
    expect(JSON.parse(world.playerState!.stats!)).toEqual({ hp: 7 })
    expect(JSON.parse(world.playerState!.inventory!)).toEqual([{ item_id: 'lamp' }])
    expect(JSON.parse(world.playerState!.effects!)).toEqual([])
  })

  test('falls back to an empty player state when player.json is absent', () => {
    const world = importWorldFromFilesystem(db, config(), OWNER, services())

    expect(world.playerState?.turnCount).toBe(0)
    expect(world.playerState?.stats).toBe('{}')
    expect(world.playerState?.inventory).toBe('[]')
    expect(world.playerState?.actionHistory).toBe('[]')
  })

  test('maps an active world to the "main" room key with the gameplay cast', () => {
    const world = importWorldFromFilesystem(db, config(), OWNER, services())

    const state = readState('saved-world')
    // snake_case keys: `_state.json` is read by the Python backend too.
    expect(state.rooms).toEqual({
      main: {
        db_room_id: world.onboardingRoom!.id,
        agents: ['Action_Manager', 'Narrator'],
        created_at: expect.any(String),
      },
    })
  })

  test('maps an unfinished world to "onboarding" with the interviewer', () => {
    const world = importWorldFromFilesystem(
      db,
      config({ phase: 'onboarding' }),
      OWNER,
      services(),
    )

    const state = readState('saved-world')
    expect(state.rooms).toEqual({
      onboarding: {
        db_room_id: world.onboardingRoom!.id,
        agents: ['Onboarding_Manager'],
        created_at: expect.any(String),
      },
    })
  })

  test('rejects a phase world.json should never contain', () => {
    // `world.json` is user-editable. Defaulting an unreadable phase to
    // `onboarding` would restart a finished campaign from its intro.
    expect(() => importWorldFromFilesystem(db, config({ phase: 'halfway' }), OWNER, services())).toThrow(
      /Unknown world phase/,
    )
    expect(countRows('worlds')).toBe(0)
    expect(countRows('rooms')).toBe(0)
  })

  test('folds an unrecognised language to English', () => {
    const world = importWorldFromFilesystem(db, config({ language: 'martian' }), OWNER, services())
    expect(world.language).toBe('en')
  })
})
