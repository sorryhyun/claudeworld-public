/**
 * Room and agent write paths — `crud/rooms.ts`, the membership half of
 * `crud/room_agents.py`, and `crud/agents.ts`.
 *
 * Unlike `crud.test.ts`, which pins its schema to a verbatim `.schema` dump of
 * a Python-written database, this suite builds the schema through the committed
 * Drizzle baseline. The two are equivalent by construction — `migrate.test.ts`
 * is the test that proves it, and `bun run migration-check` is the gate — and
 * going through the baseline here keeps a second 150-line DDL copy from having
 * to be kept in step by hand.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, type Db } from '../db'
import { openAndInitDb } from '../db/migrate'
import { agents, rooms, worlds } from '../db/schema'
import {
  addAgentToRoom,
  addGameplayAgentsToRoom,
  createAgent,
  createMessage,
  createRoom,
  getAgent,
  getAgentsByWorld,
  getAgentsInRoom,
  getRoom,
  markRoomAsFinished,
  removeAgentFromRoom,
  syncAgentsWithFilesystem,
  updateAgent,
} from '../crud'
import { getAgentsCached } from '../crud/cached'
import { getCache, roomAgentsKey, roomObjectKey } from '../infrastructure/cache'

const WORLD_ID = 1
const WORLD_NAME = 'testworld'
const OWNER = 'admin'

let dir: string
let dbPath: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-rooms-'))
  dbPath = join(dir, 'test.db')

  const created = openAndInitDb({ path: dbPath })
  created.close()

  db = openDb({ path: dbPath })
  seed()

  // The cache is a module-level singleton, so an entry left by one test would
  // be a hit in the next. Reset rather than reach for per-test isolation the
  // production code does not have.
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

  // Both gameplay agents exist here, so addGameplayAgentsToRoom returns 2.
  db.insert(agents)
    .values([
      { id: 1, name: 'Action_Manager', group: 'gameplay', systemPrompt: 'prompt' },
      { id: 2, name: 'Narrator', group: 'gameplay', systemPrompt: 'prompt' },
      { id: 3, name: 'Elric', group: null, worldName: WORLD_NAME, systemPrompt: 'prompt' },
    ])
    .run()
}

/** Read a column through raw SQL, bypassing the Drizzle decoders. */
function rawValue<T>(sql: string): T {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const row = raw.query<Record<string, T>, []>(sql).get()
    if (!row) throw new Error(`no row for: ${sql}`)
    return Object.values(row)[0] as T
  } finally {
    raw.close()
  }
}

const SQLA_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/

describe('createRoom', () => {
  test('writes the row and returns it with empty relations', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)

    expect(room.name).toBe('Location: Village')
    expect(room.ownerId).toBe(OWNER)
    expect(room.worldId).toBe(WORLD_ID)
    expect(room.maxInteractions).toBeNull()
    expect(room.agents).toEqual([])
    expect(room.messages).toEqual([])
    expect(room.world?.name).toBe(WORLD_NAME)

    // The DDL default covers these two; the point is that they decode as
    // booleans rather than 0/1.
    expect(room.isPaused).toBe(false)
    expect(room.isFinished).toBe(false)
  })

  test('stamps created_at and last_activity_at in SQLAlchemy text format', () => {
    const room = createRoom(db, { name: 'Location: Mill' }, OWNER, WORLD_ID)

    // Neither column has a DDL default: SQLAlchemy fills them ORM-side, so
    // leaving them out would store NULL and sort the room to the end of every
    // recency-ordered listing.
    expect(rawValue<string>(`SELECT created_at FROM rooms WHERE id = ${room.id}`)).toMatch(
      SQLA_DATETIME,
    )
    expect(rawValue<string>(`SELECT last_activity_at FROM rooms WHERE id = ${room.id}`)).toMatch(
      SQLA_DATETIME,
    )
  })

  test('a world-less room carries a null world and max_interactions passes through', () => {
    const room = createRoom(db, { name: 'Direct: Elric', maxInteractions: 5 }, OWNER)

    expect(room.worldId).toBeNull()
    expect(room.world).toBeNull()
    expect(room.maxInteractions).toBe(5)
  })

  test('rejects a duplicate owner+name+world', () => {
    createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)
    expect(() => createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)).toThrow()
  })
})

describe('markRoomAsFinished', () => {
  test('flips the flag and drops the cached room object', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)
    getCache().set(roomObjectKey(room.id), getRoom(db, room.id), 30)

    const finished = markRoomAsFinished(db, room.id)

    expect(finished?.isFinished).toBe(true)
    expect(rawValue<number>(`SELECT is_finished FROM rooms WHERE id = ${room.id}`)).toBe(1)
    // Without the invalidation the scheduler reads the stale room for 30s and
    // keeps the conversation running after it ended.
    expect(getCache().get(roomObjectKey(room.id))).toBeUndefined()
  })

  test('returns null for an unknown room', () => {
    expect(markRoomAsFinished(db, 9999)).toBeNull()
  })
})

describe('addAgentToRoom', () => {
  test('returns the eager-loaded room including the new member', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)

    const result = addAgentToRoom(db, room.id, 3)

    // The widened return is what a Phase 3 router serializes, so agents,
    // messages and world all have to be materialized.
    expect(result?.agents.map((a) => a.name)).toEqual(['Elric'])
    expect(result?.messages).toEqual([])
    expect(result?.world?.id).toBe(WORLD_ID)
  })

  test('announces a mid-conversation arrival but not the first member', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)

    // Empty room: no notice, because there is nobody to notice.
    expect(addAgentToRoom(db, room.id, 1)?.messages).toEqual([])

    createMessage(db, room.id, { content: 'hello', role: 'user' })
    const after = addAgentToRoom(db, room.id, 3)

    const notice = after!.messages.at(-1)!
    expect(notice.content).toBe('Elric joined the chat')
    expect(notice.participantType).toBe('system')
  })

  test('is idempotent and still returns the room', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)
    addAgentToRoom(db, room.id, 3)

    const again = addAgentToRoom(db, room.id, 3)

    expect(again?.id).toBe(room.id)
    expect(getAgentsInRoom(db, room.id)).toHaveLength(1)
  })

  test('returns null when the room or the agent is missing', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)
    expect(addAgentToRoom(db, 9999, 3)).toBeNull()
    expect(addAgentToRoom(db, room.id, 9999)).toBeNull()
  })

  test('invalidates the room-agents cache, so the next read sees the arrival', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)

    // Warm the 60-second membership cache the orchestrator reads.
    expect(getAgentsCached(db, room.id)).toEqual([])

    addAgentToRoom(db, room.id, 3)

    expect(getCache().get(roomAgentsKey(room.id))).toBeUndefined()
    expect(getAgentsCached(db, room.id).map((a) => a.name)).toEqual(['Elric'])
  })

  test('addGameplayAgentsToRoom adds both tape participants', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)

    expect(addGameplayAgentsToRoom(db, room.id)).toBe(2)
    expect(getAgentsInRoom(db, room.id).map((a) => a.id).sort()).toEqual([1, 2])
    // Python counts "agent resolvable", not "newly inserted", so a second pass
    // still reports 2 without duplicating a row.
    expect(addGameplayAgentsToRoom(db, room.id)).toBe(2)
    expect(getAgentsInRoom(db, room.id)).toHaveLength(2)
  })
})

describe('removeAgentFromRoom', () => {
  test('removes the membership row and invalidates the cache', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)
    addAgentToRoom(db, room.id, 3)
    getCache().set(roomAgentsKey(room.id), getAgentsInRoom(db, room.id), 60)

    expect(removeAgentFromRoom(db, room.id, 3)).toBe(true)

    expect(getAgentsInRoom(db, room.id)).toEqual([])
    expect(getCache().get(roomAgentsKey(room.id))).toBeUndefined()
    // The agent itself survives — membership is not existence.
    expect(getAgent(db, 3)?.name).toBe('Elric')
  })

  test('false for a non-member and for an unknown room', () => {
    const room = createRoom(db, { name: 'Location: Village' }, OWNER, WORLD_ID)
    expect(removeAgentFromRoom(db, room.id, 3)).toBe(false)
    expect(removeAgentFromRoom(db, 9999, 3)).toBe(false)
  })
})

describe('createAgent', () => {
  test('round-trips, applying the ORM-side defaults', () => {
    const agent = createAgent(db, {
      name: 'Frieren',
      systemPrompt: 'a long prompt',
      inANutshell: 'an elf mage',
      configFile: `worlds/${WORLD_NAME}/agents/Frieren`,
      worldName: WORLD_NAME,
    })

    const reread = getAgent(db, agent.id)!
    expect(reread.name).toBe('Frieren')
    expect(reread.worldName).toBe(WORLD_NAME)
    expect(reread.inANutshell).toBe('an elf mage')
    expect(reread.characteristics).toBeNull()

    // None of these columns has a DDL default; storing NULL instead of the
    // ORM default would make `priority` sort differently from a Python-written
    // row in the agent-ordering comparison.
    expect(reread.priority).toBe(0)
    expect(reread.interruptEveryTurn).toBe(false)
    expect(reread.transparent).toBe(false)
    expect(rawValue<string>(`SELECT created_at FROM agents WHERE id = ${agent.id}`)).toMatch(
      SQLA_DATETIME,
    )
  })

  test('honours explicit non-default flags', () => {
    const agent = createAgent(db, {
      name: 'Chorus',
      systemPrompt: 'p',
      interruptEveryTurn: true,
      transparent: true,
      priority: 7,
    })

    expect(agent.interruptEveryTurn).toBe(true)
    expect(agent.transparent).toBe(true)
    expect(agent.priority).toBe(7)
  })
})

describe('updateAgent', () => {
  test('writes only the fields given, leaving null and absent alone', () => {
    const agent = createAgent(db, {
      name: 'Frieren',
      systemPrompt: 'old prompt',
      inANutshell: 'an elf mage',
      priority: 3,
    })

    const updated = updateAgent(db, agent.id, {
      systemPrompt: 'new prompt',
      // Python's `if x is not None` means a null here is "leave it alone",
      // not "clear it" — the opposite of updateLocation's convention.
      inANutshell: null,
    })!

    expect(updated.systemPrompt).toBe('new prompt')
    expect(updated.inANutshell).toBe('an elf mage')
    expect(updated.priority).toBe(3)
  })

  test('an empty patch returns the untouched agent rather than failing', () => {
    const agent = createAgent(db, { name: 'Frieren', systemPrompt: 'p' })
    expect(updateAgent(db, agent.id, {})?.systemPrompt).toBe('p')
  })

  test('a base64 profile picture clears the column', () => {
    const agent = createAgent(db, { name: 'Frieren', systemPrompt: 'p', profilePic: '/old.png' })

    const updated = updateAgent(db, agent.id, {
      profilePic: 'data:image/png;base64,iVBORw0KGgo=',
    })!

    // Python nulls the column because the bytes are then served from
    // `agents/<name>/profile.png`. The filesystem half is a Phase 3 TODO, which
    // is why the port logs an error rather than passing quietly.
    expect(updated.profilePic).toBeNull()
  })

  test('a plain profile picture path is stored verbatim', () => {
    const agent = createAgent(db, { name: 'Frieren', systemPrompt: 'p' })
    expect(updateAgent(db, agent.id, { profilePic: '/static/frieren.png' })?.profilePic).toBe(
      '/static/frieren.png',
    )
  })

  test('returns null for an unknown agent', () => {
    expect(updateAgent(db, 9999, { systemPrompt: 'x' })).toBeNull()
  })
})

describe('getAgentsByWorld', () => {
  test('returns the world cast and never the system agents', () => {
    createAgent(db, { name: 'Frieren', systemPrompt: 'p', worldName: WORLD_NAME })
    createAgent(db, { name: 'Fern', systemPrompt: 'p', worldName: 'other' })

    // Action_Manager and Narrator have a NULL world_name, which SQL equality
    // never matches.
    expect(getAgentsByWorld(db, WORLD_NAME).map((a) => a.name).sort()).toEqual(['Elric', 'Frieren'])
    expect(getAgentsByWorld(db, 'nobody')).toEqual([])
  })
})

describe('syncAgentsWithFilesystem', () => {
  test('deletes exactly the rows whose config path is gone', () => {
    const root = join(dir, 'project')
    mkdirSync(join(root, 'worlds', WORLD_NAME, 'agents', 'HasFolder'), { recursive: true })
    writeFileSync(join(root, 'worlds', WORLD_NAME, 'agents', 'HasFile.md'), '# single file config')

    const hasFolder = createAgent(db, {
      name: 'HasFolder',
      systemPrompt: 'p',
      worldName: WORLD_NAME,
      configFile: `worlds/${WORLD_NAME}/agents/HasFolder`,
    })
    // Stored without the extension; `Path.with_suffix('.md')` is what finds it.
    const hasFile = createAgent(db, {
      name: 'HasFile',
      systemPrompt: 'p',
      worldName: WORLD_NAME,
      configFile: `worlds/${WORLD_NAME}/agents/HasFile`,
    })
    const gone = createAgent(db, {
      name: 'Gone',
      systemPrompt: 'p',
      worldName: WORLD_NAME,
      configFile: `worlds/${WORLD_NAME}/agents/Gone`,
    })
    // Elric (seeded) has no config_file at all and must be left alone: nothing
    // on disk claims ownership of it.

    expect(syncAgentsWithFilesystem(db, WORLD_NAME, { projectRoot: root })).toBe(1)

    expect(getAgentsByWorld(db, WORLD_NAME).map((a) => a.name).sort()).toEqual([
      'Elric',
      'HasFile',
      'HasFolder',
    ])
    expect(getAgent(db, hasFolder.id)).not.toBeNull()
    expect(getAgent(db, hasFile.id)).not.toBeNull()
    expect(getAgent(db, gone.id)).toBeNull()
  })

  test('is a no-op, and reports 0, when everything is present', () => {
    const root = join(dir, 'project2')
    mkdirSync(join(root, 'worlds', WORLD_NAME, 'agents', 'HasFolder'), { recursive: true })
    createAgent(db, {
      name: 'HasFolder',
      systemPrompt: 'p',
      worldName: WORLD_NAME,
      configFile: `worlds/${WORLD_NAME}/agents/HasFolder`,
    })

    expect(syncAgentsWithFilesystem(db, WORLD_NAME, { projectRoot: root })).toBe(0)
    expect(getAgentsByWorld(db, WORLD_NAME)).toHaveLength(2)
  })

  test('never touches another world, or the system agents', () => {
    const root = join(dir, 'project3')
    mkdirSync(root, { recursive: true })
    createAgent(db, {
      name: 'Fern',
      systemPrompt: 'p',
      worldName: 'other',
      configFile: 'worlds/other/agents/Fern',
    })

    // Elric has no config_file, so nothing at all is stale for this world.
    expect(syncAgentsWithFilesystem(db, WORLD_NAME, { projectRoot: root })).toBe(0)
    expect(getAgentsByWorld(db, 'other')).toHaveLength(1)
    expect(db.select().from(rooms).all()).toEqual([])
    expect(getAgent(db, 1)?.name).toBe('Action_Manager')
  })
})
