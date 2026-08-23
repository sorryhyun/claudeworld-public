/**
 * The cached CRUD reads.
 *
 * Every test here works the same way: read once to populate, change the
 * database *behind* the cache, then read again. If the second read sees the
 * change, the entry was not cached; if it never stops seeing the stale value,
 * invalidation or expiry is broken. Asserting on a call counter instead would
 * pass just as happily with a cache that returned the wrong row.
 *
 * The database is built from the committed migrations rather than from a schema
 * dump — these functions only delegate to `crud/` for the actual queries, which
 * `crud.test.ts` already pins against real SQLAlchemy-written DDL, so what is
 * under test here is purely the caching.
 *
 * `getCache()` is a module-level singleton, exactly as in Python, so each test
 * starts by clearing it. Without that the 30-second room entry outlives the
 * database it was read from and the next test asserts against a closed handle.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getAgentCached,
  getAgentsCached,
  getMessagesAfterAgentResponseCached,
  getMessagesCached,
  getMessagesSinceCached,
  getRecentMessagesCached,
  getRoomCached,
} from '@/crud/cached'
import {
  invalidateAgentCache,
  invalidateMessagesCache,
  invalidateRoomCache,
} from '@/crud/cache-invalidation'
import { createMessage, getMessagesSince } from '@/crud/messages'
import { openDb, type Db } from '@/db'
import { initDb } from '@/db/migrate'
import { agents, messages, roomAgents, rooms, worlds, type Agent } from '@/db/schema'
import {
  agentConfigKey,
  agentObjectKey,
  getCache,
  roomAgentsKey,
  roomMessagesKey,
  roomObjectKey,
} from '@/infrastructure/cache'

const WORLD_ID = 1
const ROOM_ID = 1
const OTHER_ROOM_ID = 2
const NARRATOR_ID = 1
const ACTION_MANAGER_ID = 2

let dir: string
let db: Db

/** The message-window key the module builds internally, mirrored for assertions. */
const afterKey = (roomId: number, agentId: number, limit = 200): string =>
  `${roomMessagesKey(roomId)}:after:${agentId}:${limit}`

function seed(database: Db): void {
  database
    .insert(worlds)
    .values({ id: WORLD_ID, name: 'cached', ownerId: 'admin', language: 'en', phase: 'active' })
    .run()

  database
    .insert(rooms)
    .values([
      { id: ROOM_ID, name: 'Location: Observatory', ownerId: 'admin', worldId: WORLD_ID },
      { id: OTHER_ROOM_ID, name: 'Location: Cellar', ownerId: 'admin', worldId: WORLD_ID },
    ])
    .run()

  database
    .insert(agents)
    .values([
      { id: NARRATOR_ID, name: 'Narrator', group: 'gameplay', systemPrompt: 'narrate' },
      { id: ACTION_MANAGER_ID, name: 'Action_Manager', group: 'gameplay', systemPrompt: 'act' },
    ])
    .run()

  // Only the Narrator is in room 1 to start; a later test adds the Action
  // Manager to prove the membership list is what got cached.
  database.insert(roomAgents).values({ roomId: ROOM_ID, agentId: NARRATOR_ID }).run()

  createMessage(database, ROOM_ID, { content: 'look around', role: 'user' })
}

beforeEach(() => {
  getCache().clear()

  dir = mkdtempSync(join(tmpdir(), 'cw-cached-'))
  const path = join(dir, 'test.db')

  const sqlite = new Database(path, { create: true, strict: true })
  initDb(sqlite)
  sqlite.close()

  db = openDb({ path })
  seed(db)
})

afterEach(() => {
  setSystemTime()
  getCache().clear()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Insert a message *without* going through `createMessage`.
 *
 * `createMessage` invalidates the room's message keys, which is correct and is
 * what the invalidation tests assert. But a TTL test needs a change the cache
 * has no idea happened — the real-world case being the Python backend, a
 * `sqlite3` shell or a second process writing to the same file. A raw insert is
 * that case, and it is the only kind of write a TTL can actually protect
 * against.
 */
function insertMessageBehindTheCache(db: Db, roomId: number, content: string): void {
  db.insert(messages).values({ roomId, content, role: 'assistant' }).run()
}

describe('getAgentCached', () => {
  test('a miss populates and a hit serves the stale row', () => {
    expect(getCache().get(agentObjectKey(NARRATOR_ID))).toBeUndefined()

    expect(getAgentCached(db, NARRATOR_ID)?.systemPrompt).toBe('narrate')

    db.update(agents)
      .set({ systemPrompt: 'narrate differently' })
      .where(eq(agents.id, NARRATOR_ID))
      .run()

    expect(getAgentCached(db, NARRATOR_ID)?.systemPrompt).toBe('narrate')
  })

  test('the five-minute TTL is why updateAgent must invalidate', () => {
    getAgentCached(db, NARRATOR_ID)
    db.update(agents).set({ systemPrompt: 'edited' }).where(eq(agents.id, NARRATOR_ID)).run()

    // Four minutes in, an edit made behind the cache is still invisible. Config
    // hot-reload only feels instant because `updateAgent` calls
    // `invalidateAgentCache`; this pins how long the fallback actually is.
    setSystemTime(new Date(Date.now() + 240 * 1000))
    expect(getAgentCached(db, NARRATOR_ID)?.systemPrompt).toBe('narrate')

    setSystemTime(new Date(Date.now() + 120 * 1000))
    expect(getAgentCached(db, NARRATOR_ID)?.systemPrompt).toBe('edited')
  })

  test('a missing agent caches the null', () => {
    expect(getAgentCached(db, 9999)).toBeNull()
    expect(getCache().getStats().size).toBe(1)
    expect(getAgentCached(db, 9999)).toBeNull()
    expect(getCache().getStats().hits).toBeGreaterThan(0)
  })

  test('invalidateAgentCache is what makes the next read fresh', () => {
    getAgentCached(db, NARRATOR_ID)
    db.update(agents).set({ systemPrompt: 'edited' }).where(eq(agents.id, NARRATOR_ID)).run()

    invalidateAgentCache(NARRATOR_ID)

    expect(getAgentCached(db, NARRATOR_ID)?.systemPrompt).toBe('edited')
  })
})

describe('getMessagesCached', () => {
  test('its key is the prefix every other message entry extends', () => {
    expect(getMessagesCached(db, ROOM_ID)).toHaveLength(1)

    // Not `room_messages:1:all` or similar: the bare key doubles as the prefix,
    // which is what lets one `invalidatePattern` clear the whole family.
    expect(getCache().get(roomMessagesKey(ROOM_ID))).toBeDefined()
  })

  test('a hit hides a write the cache never saw', () => {
    getMessagesCached(db, ROOM_ID)
    insertMessageBehindTheCache(db, ROOM_ID, 'you see stars')

    expect(getMessagesCached(db, ROOM_ID)).toHaveLength(1)
  })

  test('createMessage invalidates it along with the rest of the family', () => {
    getMessagesCached(db, ROOM_ID)
    createMessage(db, ROOM_ID, { content: 'you see stars', role: 'assistant' })

    expect(getMessagesCached(db, ROOM_ID)).toHaveLength(2)
  })
})

describe('getRecentMessagesCached', () => {
  test('a miss populates a per-limit key and a hit serves it', () => {
    expect(getRecentMessagesCached(db, ROOM_ID)).toHaveLength(1)
    expect(getCache().get(`${roomMessagesKey(ROOM_ID)}:recent:200`)).toBeDefined()

    insertMessageBehindTheCache(db, ROOM_ID, 'you see stars')

    expect(getRecentMessagesCached(db, ROOM_ID)).toHaveLength(1)
    // A different limit is a different entry, so it really re-queries rather
    // than slicing the wider window it already holds.
    expect(getRecentMessagesCached(db, ROOM_ID, 50)).toHaveLength(2)
  })
})

describe('getMessagesSinceCached', () => {
  /**
   * Fill the room past the 50-message floor of the buffered window.
   *
   * Timestamps are dictated rather than left to the column's
   * `CURRENT_TIMESTAMP` default: that default has *second* resolution and no
   * fractional part, so `2026-08-21 12:00:00` sorts before the seeded
   * `2026-08-21 12:00:00.931812` as text and the fixture's first message would
   * end up last.
   */
  function fill(count: number): void {
    const base = Date.now()
    for (let i = 0; i < count; i += 1) {
      db.insert(messages)
        .values({
          roomId: ROOM_ID,
          content: `line ${i}`,
          role: 'assistant',
          timestamp: new Date(base + (i + 1) * 1000),
        })
        .run()
    }
  }

  test('with no since id it returns the oldest `limit` of the buffered window', () => {
    fill(4)

    const since = getMessagesSinceCached(db, ROOM_ID, null, 2)

    expect(since.map((m) => m.content)).toEqual(['look around', 'line 0'])
  })

  test('filters the window by id', () => {
    fill(3)
    const all = getMessagesSinceCached(db, ROOM_ID)

    const since = getMessagesSinceCached(db, ROOM_ID, all[1]!.id)

    expect(since.map((m) => m.content)).toEqual(['line 1', 'line 2'])
  })

  test('shares its entry with getRecentMessagesCached at the buffered limit', () => {
    // `max(limit * 2, 50)`. The sharing is the whole point: `sinceId` advances
    // on every poll, so an entry keyed on it would miss every time, while a
    // wider window answers several consecutive polls from one query.
    getMessagesSinceCached(db, ROOM_ID, null, 100)

    expect(getCache().get(`${roomMessagesKey(ROOM_ID)}:recent:200`)).toBeDefined()
    expect(getCache().get(`${roomMessagesKey(ROOM_ID)}:recent:100`)).toBeUndefined()
  })

  test('a client further behind than the window silently skips messages', () => {
    // The parity landmine: this is *not* `getMessagesSince`. That one asks the
    // database for the oldest rows above `sinceId`, so a client catches up page
    // by page. This one filters the newest 50 and drops whatever fell out the
    // bottom. Both behaviours are Python's; only the caller's choice of
    // function decides which a poller gets.
    fill(60)

    expect(getMessagesSince(db, ROOM_ID, 0, 1).map((m) => m.content)).toEqual(['look around'])
    expect(getMessagesSinceCached(db, ROOM_ID, 0, 1).map((m) => m.content)).toEqual(['line 10'])
  })

  test('an empty room comes back empty rather than throwing', () => {
    expect(getMessagesSinceCached(db, OTHER_ROOM_ID)).toEqual([])
  })
})

describe('invalidateMessagesCache', () => {
  test('clears the message family and leaves the room and its agents cached', () => {
    getRoomCached(db, ROOM_ID)
    getAgentsCached(db, ROOM_ID)
    getMessagesCached(db, ROOM_ID)
    getRecentMessagesCached(db, ROOM_ID)
    getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)

    invalidateMessagesCache(ROOM_ID)

    expect(getCache().get(roomMessagesKey(ROOM_ID))).toBeUndefined()
    expect(getCache().get(`${roomMessagesKey(ROOM_ID)}:recent:200`)).toBeUndefined()
    expect(getCache().get(afterKey(ROOM_ID, NARRATOR_ID))).toBeUndefined()
    // The narrower sibling of invalidateRoomCache: these two survive.
    expect(getCache().get(roomObjectKey(ROOM_ID))).toBeDefined()
    expect(getCache().get(roomAgentsKey(ROOM_ID))).toBeDefined()
  })

  test('another room keeps its messages', () => {
    getMessagesCached(db, OTHER_ROOM_ID)

    invalidateMessagesCache(ROOM_ID)

    expect(getCache().get(roomMessagesKey(OTHER_ROOM_ID))).toBeDefined()
  })
})

describe('getRoomCached', () => {
  test('a miss populates the cache and a hit serves the stored row', () => {
    expect(getCache().get(roomObjectKey(ROOM_ID))).toBeUndefined()

    const first = getRoomCached(db, ROOM_ID)
    expect(first?.name).toBe('Location: Observatory')
    expect(getCache().get(roomObjectKey(ROOM_ID))).toBeDefined()

    db.update(rooms).set({ isPaused: true }).where(eq(rooms.id, ROOM_ID)).run()

    expect(getRoomCached(db, ROOM_ID)?.isPaused).toBe(false)
  })

  test('the eager-loaded relationships come back off the cached copy', () => {
    // This is what the port note about `make_transient` amounts to: Drizzle
    // hands back a plain object, so `agents`/`world`/`messages` are ordinary
    // properties of the cached value. Deleting the membership row afterwards
    // proves they were materialized at read time rather than resolved lazily
    // against the database on access.
    getRoomCached(db, ROOM_ID)
    db.delete(roomAgents).where(eq(roomAgents.roomId, ROOM_ID)).run()

    const cached = getRoomCached(db, ROOM_ID)
    expect(cached?.agents.map((a) => a.name)).toEqual(['Narrator'])
    expect(cached?.world?.name).toBe('cached')
    expect(cached?.messages).toHaveLength(1)
  })

  test('a missing room caches the null instead of re-querying', () => {
    expect(getRoomCached(db, 9999)).toBeNull()

    // A cached null that read as "absent" would make the cache a no-op for
    // exactly the case it is cheapest to serve.
    expect(getCache().getStats().size).toBe(1)
    expect(getRoomCached(db, 9999)).toBeNull()
    expect(getCache().getStats().hits).toBeGreaterThan(0)
  })

  test('rooms do not share an entry', () => {
    expect(getRoomCached(db, ROOM_ID)?.name).toBe('Location: Observatory')
    expect(getRoomCached(db, OTHER_ROOM_ID)?.name).toBe('Location: Cellar')
  })
})

describe('getAgentsCached', () => {
  test('a miss populates and a hit serves the stale membership', () => {
    expect(getAgentsCached(db, ROOM_ID).map((a) => a.name)).toEqual(['Narrator'])

    db.insert(roomAgents).values({ roomId: ROOM_ID, agentId: ACTION_MANAGER_ID }).run()

    expect(getAgentsCached(db, ROOM_ID)).toHaveLength(1)
    expect(getCache().get(roomAgentsKey(ROOM_ID))).toBeDefined()
  })

  test('an empty room caches an empty list', () => {
    expect(getAgentsCached(db, OTHER_ROOM_ID)).toEqual([])
    expect(getCache().get<Agent[]>(roomAgentsKey(OTHER_ROOM_ID))).toEqual([])
  })
})

describe('getMessagesAfterAgentResponseCached', () => {
  test('a miss populates and a hit hides a write the cache never saw', () => {
    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)).toHaveLength(1)

    insertMessageBehindTheCache(db, ROOM_ID, 'you see stars')

    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)).toHaveLength(1)
  })

  test('createMessage invalidates, so an in-process write is visible at once', () => {
    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)).toHaveLength(1)

    // `messages.py:79-83` invalidates the `room_messages:` family inline. On a
    // 2-second polling loop the alternative is a message the player cannot see
    // for 5 seconds after it was written.
    createMessage(db, ROOM_ID, { content: 'you see stars', role: 'assistant' })

    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)).toHaveLength(2)
  })

  test('the key is per agent and per limit', () => {
    getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)
    getMessagesAfterAgentResponseCached(db, ROOM_ID, ACTION_MANAGER_ID)
    getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID, 50)

    expect(getCache().get(afterKey(ROOM_ID, NARRATOR_ID))).toBeDefined()
    expect(getCache().get(afterKey(ROOM_ID, ACTION_MANAGER_ID))).toBeDefined()
    expect(getCache().get(afterKey(ROOM_ID, NARRATOR_ID, 50))).toBeDefined()
  })

  test('a different limit really re-queries rather than reusing the wider slice', () => {
    createMessage(db, ROOM_ID, { content: 'second', role: 'user' })
    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID, 200)).toHaveLength(2)

    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID, 1)).toHaveLength(1)
  })
})

describe('invalidateRoomCache', () => {
  test('drops all three room-scoped keys, message windows included', () => {
    getRoomCached(db, ROOM_ID)
    getAgentsCached(db, ROOM_ID)
    getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)
    getMessagesAfterAgentResponseCached(db, ROOM_ID, ACTION_MANAGER_ID, 50)

    invalidateRoomCache(ROOM_ID)

    expect(getCache().get(roomObjectKey(ROOM_ID))).toBeUndefined()
    expect(getCache().get(roomAgentsKey(ROOM_ID))).toBeUndefined()
    // The two derived message keys share the `room_messages:{id}` prefix, which
    // is the reason one prefix sweep clears an unbounded number of them.
    expect(getCache().get(afterKey(ROOM_ID, NARRATOR_ID))).toBeUndefined()
    expect(getCache().get(afterKey(ROOM_ID, ACTION_MANAGER_ID, 50))).toBeUndefined()
    expect(getCache().getStats().size).toBe(0)
  })

  test('the next read after invalidation sees the write', () => {
    expect(getRoomCached(db, ROOM_ID)?.isPaused).toBe(false)
    db.update(rooms).set({ isPaused: true }).where(eq(rooms.id, ROOM_ID)).run()

    invalidateRoomCache(ROOM_ID)

    expect(getRoomCached(db, ROOM_ID)?.isPaused).toBe(true)
  })

  test('another room is left alone', () => {
    getRoomCached(db, ROOM_ID)
    getRoomCached(db, OTHER_ROOM_ID)
    getAgentsCached(db, OTHER_ROOM_ID)

    invalidateRoomCache(ROOM_ID)

    expect(getCache().get(roomObjectKey(OTHER_ROOM_ID))).toBeDefined()
    expect(getCache().get(roomAgentsKey(OTHER_ROOM_ID))).toBeDefined()
  })
})

describe('invalidateAgentCache', () => {
  test('drops both the object and the config entry', () => {
    // Nothing writes `agentObjectKey` any more — `get_agent_cached` is one of
    // the four dead Python functions the port drops — so it is seeded by hand
    // to prove the helper still clears it for whoever adds that read back.
    getCache().set(agentObjectKey(NARRATOR_ID), { name: 'Narrator' })
    getCache().set(agentConfigKey(NARRATOR_ID), { systemPrompt: 'narrate' })

    invalidateAgentCache(NARRATOR_ID)

    expect(getCache().get(agentObjectKey(NARRATOR_ID))).toBeUndefined()
    expect(getCache().get(agentConfigKey(NARRATOR_ID))).toBeUndefined()
  })

  test('leaves another agent alone', () => {
    getCache().set(agentConfigKey(ACTION_MANAGER_ID), { systemPrompt: 'act' })

    invalidateAgentCache(NARRATOR_ID)

    expect(getCache().get(agentConfigKey(ACTION_MANAGER_ID))).toBeDefined()
  })
})

describe('expiry', () => {
  /** Advance the clock the cache reads, which is `Date.now()`. */
  function advance(seconds: number): void {
    setSystemTime(new Date(Date.now() + seconds * 1000))
  }

  test('the room entry survives 29 seconds and is gone by 31', () => {
    expect(getRoomCached(db, ROOM_ID)?.isPaused).toBe(false)
    db.update(rooms).set({ isPaused: true }).where(eq(rooms.id, ROOM_ID)).run()

    advance(29)
    expect(getRoomCached(db, ROOM_ID)?.isPaused).toBe(false)

    advance(2)
    expect(getRoomCached(db, ROOM_ID)?.isPaused).toBe(true)
  })

  test('the agents entry lives 60 seconds, twice as long as the room', () => {
    expect(getAgentsCached(db, ROOM_ID)).toHaveLength(1)
    db.insert(roomAgents).values({ roomId: ROOM_ID, agentId: ACTION_MANAGER_ID }).run()

    advance(45)
    expect(getAgentsCached(db, ROOM_ID)).toHaveLength(1)

    advance(20)
    expect(getAgentsCached(db, ROOM_ID)).toHaveLength(2)
  })

  test('the message window lives only 5 seconds', () => {
    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)).toHaveLength(1)
    insertMessageBehindTheCache(db, ROOM_ID, 'you see stars')

    advance(4)
    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)).toHaveLength(1)

    advance(2)
    expect(getMessagesAfterAgentResponseCached(db, ROOM_ID, NARRATOR_ID)).toHaveLength(2)
  })
})
