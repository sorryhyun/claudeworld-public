/**
 * The message readers — the polling contract.
 *
 * These five queries are the highest-traffic path in the application: a client
 * polls every 2 seconds per open room, and every agent turn rebuilds its
 * context from them. Two properties are worth testing over and above "the SQL
 * runs":
 *
 * 1. **Ordering is stable when timestamps tie.** Python's clock has microsecond
 *    resolution, `Date` has milliseconds, so ties that never occurred there
 *    happen here whenever a turn writes a burst of rows. Several tests below
 *    write byte-identical timestamps on purpose.
 * 2. **The chat/gameplay partition is exact.** `chat_session_id` is the entire
 *    mechanism separating a free-form NPC conversation from the game
 *    transcript; a leak in either direction shows up as an NPC that knows
 *    something it was never told.
 *
 * The schema comes from the Drizzle migrations rather than an inlined dump of
 * SQLAlchemy's DDL (which is what `crud.test.ts` uses). The two are held
 * equal by the drift gate in `migrate.test.ts`, so this stays honest while
 * keeping the fixture to a few lines.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMessage,
  deleteRoomMessages,
  getChatSessionMessages,
  getMessages,
  getMessagesExcludingChat,
  getMessagesSince,
  getRecentMessages,
} from '@/crud/messages'
import { openDb, type Db } from '@/db'
import { formatSqlaDateTime } from '@/db/columns'
import { agents, messages, rooms } from '@/db/schema'
import { applyMigrations, loadMigrations } from '@/db/migrate'
import { getCache, roomMessagesKey } from '@/infrastructure/cache'

const migrations = loadMigrations()

const ROOM_ID = 1
const OTHER_ROOM_ID = 2
const AGENT_ID = 1
const CHAT_SESSION = 1755740000
const OTHER_CHAT_SESSION = 1755749999

let dir: string
let dbPath: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-messages-'))
  dbPath = join(dir, 'test.db')

  const raw = new Database(dbPath, { create: true, strict: true })
  try {
    applyMigrations(raw, migrations)
  } finally {
    raw.close()
  }

  db = openDb({ path: dbPath })
  db.insert(agents).values({ id: AGENT_ID, name: 'Narrator', systemPrompt: 'prompt' }).run()
  db.insert(rooms)
    .values([
      { id: ROOM_ID, name: 'Onboarding: asdf', ownerId: 'admin' },
      // A second room every filter must ignore: `room_id` is the first
      // predicate in all five readers and a missing one is invisible until two
      // worlds are open at once.
      { id: OTHER_ROOM_ID, name: 'Onboarding: other', ownerId: 'admin' },
    ])
    .run()

  // The cache is a module singleton; a leftover entry from another suite would
  // make the invalidation test pass for the wrong reason.
  getCache().clear()
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Insert a message bypassing `createMessage`, so the timestamp can be dictated.
 * Returns the new row's id.
 */
function seedMessage(options: {
  roomId?: number
  content: string
  timestamp: Date
  chatSessionId?: number | null
  agentId?: number | null
}): number {
  return db
    .insert(messages)
    .values({
      roomId: options.roomId ?? ROOM_ID,
      content: options.content,
      role: 'assistant',
      agentId: options.agentId ?? null,
      chatSessionId: options.chatSessionId ?? null,
      timestamp: options.timestamp,
    })
    .returning({ id: messages.id })
    .get().id
}

function at(secondsFromEpoch: number): Date {
  return new Date(Date.UTC(2026, 7, 21, 0, 0, secondsFromEpoch))
}

/** Read a column back through raw SQL, bypassing the Drizzle decoders. */
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

describe('createMessage', () => {
  test('persists chat_session_id, which is what makes chat mode separable', () => {
    const created = createMessage(db, ROOM_ID, {
      content: 'hello',
      role: 'user',
      participantType: 'user',
      chatSessionId: CHAT_SESSION,
    })

    // Asserted through raw SQL as well as the returned row: the whole
    // chat/gameplay partition is a WHERE clause on this column, so it has to
    // reach the database, not just the object.
    expect(created.chatSessionId).toBe(CHAT_SESSION)
    expect(rawValue<number>(`SELECT chat_session_id FROM messages WHERE id = ${created.id}`)).toBe(
      CHAT_SESSION,
    )
  })

  test('leaves chat_session_id NULL for gameplay messages', () => {
    const created = createMessage(db, ROOM_ID, { content: 'hello', role: 'user' })
    expect(
      rawValue<number | null>(`SELECT chat_session_id FROM messages WHERE id = ${created.id}`),
    ).toBeNull()
  })

  test('invalidates the room message cache', () => {
    const cache = getCache()
    cache.set(`${roomMessagesKey(ROOM_ID)}:after:1:200`, ['stale'])
    cache.set(`${roomMessagesKey(OTHER_ROOM_ID)}:after:1:200`, ['other room'])

    createMessage(db, ROOM_ID, { content: 'new', role: 'user' })

    // Without this a poller keeps serving the pre-write window for up to 5s —
    // two or three whole polls on a 2s loop.
    expect(cache.get(`${roomMessagesKey(ROOM_ID)}:after:1:200`)).toBeUndefined()
    expect(cache.get<string[]>(`${roomMessagesKey(OTHER_ROOM_ID)}:after:1:200`)).toEqual([
      'other room',
    ])
  })
})

describe('getMessages', () => {
  test('returns the whole room in chronological order with the agent resolved', () => {
    const second = seedMessage({ content: 'b', timestamp: at(20), agentId: AGENT_ID })
    const first = seedMessage({ content: 'a', timestamp: at(10) })
    seedMessage({ roomId: OTHER_ROOM_ID, content: 'elsewhere', timestamp: at(15) })

    const result = getMessages(db, ROOM_ID)
    expect(result.map((m) => m.id)).toEqual([first, second])
    expect(result[0]!.agent).toBeNull()
    expect(result[1]!.agent?.name).toBe('Narrator')
  })

  test('is unbounded — no implicit page size', () => {
    for (let i = 0; i < 250; i += 1) seedMessage({ content: `m${i}`, timestamp: at(i) })
    expect(getMessages(db, ROOM_ID)).toHaveLength(250)
  })
})

describe('getMessagesSince', () => {
  test('returns everything when no since_id is given', () => {
    const a = seedMessage({ content: 'a', timestamp: at(10) })
    const b = seedMessage({ content: 'b', timestamp: at(20) })
    expect(getMessagesSince(db, ROOM_ID).map((m) => m.id)).toEqual([a, b])
  })

  test('returns only rows newer than since_id', () => {
    const a = seedMessage({ content: 'a', timestamp: at(10) })
    const b = seedMessage({ content: 'b', timestamp: at(20) })
    const c = seedMessage({ content: 'c', timestamp: at(30) })

    expect(getMessagesSince(db, ROOM_ID, a).map((m) => m.id)).toEqual([b, c])
    expect(getMessagesSince(db, ROOM_ID, c)).toEqual([])
  })

  test('takes the oldest unseen window, not the newest', () => {
    const ids = [10, 20, 30, 40].map((s) => seedMessage({ content: `m${s}`, timestamp: at(s) }))
    // A client that fell behind must be fed forward from where it stopped;
    // handing it the newest 2 instead would skip rows it can never ask for
    // again, since since_id only moves forward.
    expect(getMessagesSince(db, ROOM_ID, ids[0]!, 2).map((m) => m.id)).toEqual([ids[1]!, ids[2]!])
  })

  test('caps the limit at 1000 rather than rejecting it', () => {
    // 1005 rows, so the cap is observable: an uncapped query returns all of
    // them and an off-by-one cap returns 1001.
    const rows = Array.from({ length: 1005 }, (_, i) => ({
      roomId: ROOM_ID,
      content: `m${i}`,
      role: 'assistant' as const,
      timestamp: at(i),
    }))
    for (let i = 0; i < rows.length; i += 100) {
      db.insert(messages)
        .values(rows.slice(i, i + 100))
        .run()
    }

    expect(getMessagesSince(db, ROOM_ID, null, 100_000)).toHaveLength(1000)
    expect(getMessagesSince(db, ROOM_ID, null, 5)).toHaveLength(5)
  })
})

describe('getRecentMessages', () => {
  test('returns the newest N, ordered oldest first', () => {
    const ids = [10, 20, 30, 40].map((s) => seedMessage({ content: `m${s}`, timestamp: at(s) }))
    // The failure this guards against is the easy one: ORDER BY ASC + LIMIT,
    // which returns the *oldest* three and reads as an agent stuck in the past.
    expect(getRecentMessages(db, ROOM_ID, 3).map((m) => m.id)).toEqual([ids[1]!, ids[2]!, ids[3]!])
  })

  test('ignores other rooms', () => {
    seedMessage({ roomId: OTHER_ROOM_ID, content: 'elsewhere', timestamp: at(10) })
    const mine = seedMessage({ content: 'mine', timestamp: at(20) })
    expect(getRecentMessages(db, ROOM_ID).map((m) => m.id)).toEqual([mine])
  })
})

describe('chat session partition', () => {
  test('the two filters return disjoint sets that cover the room', () => {
    const gameplay = [
      seedMessage({ content: 'g1', timestamp: at(10) }),
      seedMessage({ content: 'g2', timestamp: at(30) }),
    ]
    const chat = [
      seedMessage({ content: 'c1', timestamp: at(20), chatSessionId: CHAT_SESSION }),
      seedMessage({ content: 'c2', timestamp: at(40), chatSessionId: CHAT_SESSION }),
    ]

    const chatIds = getChatSessionMessages(db, ROOM_ID, CHAT_SESSION).map((m) => m.id)
    const gameplayIds = getMessagesExcludingChat(db, ROOM_ID).map((m) => m.id)

    expect(chatIds).toEqual(chat)
    expect(gameplayIds).toEqual(gameplay)
    expect(chatIds.filter((id) => gameplayIds.includes(id))).toEqual([])
    const ascending = (a: number, b: number): number => a - b
    expect([...chatIds, ...gameplayIds].sort(ascending)).toEqual(
      getMessages(db, ROOM_ID)
        .map((m) => m.id)
        .sort(ascending),
    )
  })

  test('one session does not see another session in the same room', () => {
    const mine = seedMessage({ content: 'mine', timestamp: at(10), chatSessionId: CHAT_SESSION })
    seedMessage({ content: 'theirs', timestamp: at(20), chatSessionId: OTHER_CHAT_SESSION })

    expect(getChatSessionMessages(db, ROOM_ID, CHAT_SESSION).map((m) => m.id)).toEqual([mine])
  })

  test('getMessagesExcludingChat matches IS NULL, not = NULL', () => {
    const gameplay = seedMessage({ content: 'g', timestamp: at(10) })
    seedMessage({ content: 'c', timestamp: at(20), chatSessionId: CHAT_SESSION })

    // `eq(col, null)` renders `= NULL` and matches nothing in SQLite, which
    // would empty the Action Manager's entire context rather than fail loudly.
    expect(getMessagesExcludingChat(db, ROOM_ID).map((m) => m.id)).toEqual([gameplay])
  })

  test('both honour their limit as a newest-N window', () => {
    const chat = [10, 20, 30].map((s) =>
      seedMessage({ content: `c${s}`, timestamp: at(s), chatSessionId: CHAT_SESSION }),
    )
    const gameplay = [15, 25, 35].map((s) => seedMessage({ content: `g${s}`, timestamp: at(s) }))

    expect(getChatSessionMessages(db, ROOM_ID, CHAT_SESSION, 2).map((m) => m.id)).toEqual([
      chat[1]!,
      chat[2]!,
    ])
    expect(getMessagesExcludingChat(db, ROOM_ID, 2).map((m) => m.id)).toEqual([
      gameplay[1]!,
      gameplay[2]!,
    ])
  })
})

describe('timestamp ties', () => {
  // One instant, four rows — what a single turn's NPC round actually produces
  // once the clock only resolves to milliseconds.
  const tie = at(10)

  function seedTie(): number[] {
    return ['a', 'b', 'c', 'd'].map((content) => seedMessage({ content, timestamp: tie }))
  }

  test('the fixture really does write identical timestamps', () => {
    seedTie()
    const distinct = rawValue<number>(
      `SELECT count(DISTINCT timestamp) FROM messages WHERE room_id = ${ROOM_ID}`,
    )
    expect(distinct).toBe(1)
    expect(rawValue<string>(`SELECT timestamp FROM messages WHERE id = 1`)).toBe(
      formatSqlaDateTime(tie),
    )
  })

  test('every reader breaks the tie by id', () => {
    const ids = seedTie()

    expect(getMessages(db, ROOM_ID).map((m) => m.id)).toEqual(ids)
    expect(getMessagesSince(db, ROOM_ID).map((m) => m.id)).toEqual(ids)
    expect(getRecentMessages(db, ROOM_ID).map((m) => m.id)).toEqual(ids)
    expect(getMessagesExcludingChat(db, ROOM_ID).map((m) => m.id)).toEqual(ids)
  })

  test('a limited newest-first read keeps the last ids, in order', () => {
    const ids = seedTie()

    // The interesting case: with all four timestamps equal, only the id
    // tiebreaker decides *which* two rows "the newest two" means. Without it
    // SQLite may return any two, and the player sees a scene assemble out of
    // order or lose a line entirely.
    expect(getRecentMessages(db, ROOM_ID, 2).map((m) => m.id)).toEqual([ids[2]!, ids[3]!])
    expect(getMessagesExcludingChat(db, ROOM_ID, 2).map((m) => m.id)).toEqual([ids[2]!, ids[3]!])
  })

  test('ties inside one chat session resolve the same way', () => {
    const ids = ['a', 'b', 'c'].map((content) =>
      seedMessage({ content, timestamp: tie, chatSessionId: CHAT_SESSION }),
    )
    expect(getChatSessionMessages(db, ROOM_ID, CHAT_SESSION).map((m) => m.id)).toEqual(ids)
    expect(getChatSessionMessages(db, ROOM_ID, CHAT_SESSION, 2).map((m) => m.id)).toEqual([
      ids[1]!,
      ids[2]!,
    ])
  })
})

describe('deleteRoomMessages', () => {
  test('clears the room and leaves every other room alone', () => {
    seedMessage({ content: 'kept', timestamp: at(1), roomId: OTHER_ROOM_ID })
    seedMessage({ content: 'gone', timestamp: at(2) })
    seedMessage({ content: 'also gone', timestamp: at(3) })

    expect(deleteRoomMessages(db, ROOM_ID)).toBe(true)

    expect(getMessages(db, ROOM_ID)).toEqual([])
    expect(getMessages(db, OTHER_ROOM_ID).map((m) => m.content)).toEqual(['kept'])
  })

  test('true for a room that had nothing to delete', () => {
    // The boolean answers "does the room exist", not "was anything removed" —
    // the caller uses it to decide whether to 404, and an empty room is not a
    // missing one.
    expect(deleteRoomMessages(db, ROOM_ID)).toBe(true)
  })

  test('false for a room that does not exist', () => {
    expect(deleteRoomMessages(db, 9999)).toBe(false)
  })

  test('the room row itself survives', () => {
    seedMessage({ content: 'gone', timestamp: at(1) })
    deleteRoomMessages(db, ROOM_ID)

    expect(rawValue<string>(`SELECT name FROM rooms WHERE id = ${ROOM_ID}`)).toBe(
      'Onboarding: asdf',
    )
  })

  test('deliberately leaves the message cache alone', () => {
    seedMessage({ content: 'gone', timestamp: at(1) })
    getCache().set(`${roomMessagesKey(ROOM_ID)}:recent:200`, [{ id: 1 }], 5)

    deleteRoomMessages(db, ROOM_ID)

    // Python does not sweep here either: its caller
    // (`services/agent_service.py:188`) owns the invalidation, because clearing
    // a room is only half an operation that also tears down agent sessions and
    // the SDK client pool. Pinning the gap means the service port cannot
    // silently inherit it.
    expect(getCache().get(`${roomMessagesKey(ROOM_ID)}:recent:200`)).toBeDefined()
  })
})
