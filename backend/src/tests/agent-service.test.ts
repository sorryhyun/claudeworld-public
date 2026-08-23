/**
 * Deletions with session cleanup.
 *
 * The database is real — these are `crud/` deletes and the rows have to actually
 * go — but the session pool is a stub recording what was evicted. Standing up a
 * real `SessionPool` would mean spawning CLI subprocesses, and what is under
 * test is *which* sessions each delete decides to evict and in what order
 * relative to the delete, not what closing one does.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgent, getAgent } from '@/crud/agents'
import { createMessage, getMessages } from '@/crud/messages'
import { addAgentToRoom, createRoom, getAgentsInRoom, getRoom } from '@/crud/rooms'
import { getRoomAgentSession, updateRoomAgentSession } from '@/crud/sessions'
import { openDb, type Db } from '@/db'
import { applyMigrations, loadMigrations } from '@/db/migrate'
import { roomAgentSessions } from '@/db/schema'
import { parseSessionKey } from '@/sdk/client/session'
import type { SessionPool } from '@/sdk/client/session-pool'
import { AgentService, type RoomInterrupter } from '@/services/agent-service'

const migrations = loadMigrations()

const OWNER = 'admin'

/**
 * A `SessionPool` with the four members `AgentService` touches.
 *
 * `keys` is settable so a test can describe a pool holding sessions for rooms
 * and agents that are not otherwise involved, which is the only way to show that
 * eviction is *targeted* rather than wholesale. `keysForAgent` delegates to the
 * real `parseSessionKey`, so the "room id that looks like the agent id" case is
 * testing the production rule rather than a stub's imitation of it.
 */
class FakePool {
  keys: string[] = []
  readonly evicted: string[] = []
  readonly evictedRooms: number[] = []
  /** Set to make the next eviction throw, standing in for a wedged subprocess. */
  failOn: string | null = null

  evict(key: string): Promise<void> {
    if (this.failOn === key) return Promise.reject(new Error(`stuck: ${key}`))
    this.evicted.push(key)
    this.keys = this.keys.filter((k) => k !== key)
    return Promise.resolve()
  }

  keysForAgent(agentId: number): string[] {
    return this.keys.filter((key) => parseSessionKey(key)?.agentId === agentId)
  }

  evictRoom(roomId: number): Promise<void> {
    this.evictedRooms.push(roomId)
    const prefix = `room_${roomId}_agent_`
    for (const key of this.keys.filter((k) => k.startsWith(prefix))) this.evicted.push(key)
    this.keys = this.keys.filter((k) => !k.startsWith(prefix))
    return Promise.resolve()
  }

  asPool(): SessionPool {
    return this as unknown as SessionPool
  }
}

/** Records interrupts, and optionally fails, so ordering can be asserted. */
class FakeOrchestrator implements RoomInterrupter {
  readonly interrupted: number[] = []
  shouldThrow = false

  interruptRoom(roomId: number): Promise<void> {
    this.interrupted.push(roomId)
    return this.shouldThrow ? Promise.reject(new Error('boom')) : Promise.resolve()
  }
}

let dir: string
let db: Db
let pool: FakePool
let orchestrator: FakeOrchestrator
let service: AgentService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-agentsvc-'))

  const raw = new Database(join(dir, 'test.db'), { create: true, strict: true })
  try {
    applyMigrations(raw, migrations)
  } finally {
    raw.close()
  }
  db = openDb({ path: join(dir, 'test.db') })

  pool = new FakePool()
  orchestrator = new FakeOrchestrator()
  service = new AgentService(pool.asPool(), orchestrator)
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeAgent(name: string): number {
  return createAgent(db, { name, systemPrompt: 'x' }).id
}

function makeRoom(name: string, agentIds: number[] = []): number {
  const room = createRoom(db, { name }, OWNER)
  for (const agentId of agentIds) addAgentToRoom(db, room.id, agentId)
  return room.id
}

// ============================================================================
// deleteAgentWithCleanup
// ============================================================================

describe('deleteAgentWithCleanup', () => {
  test('deletes the row and evicts the agent’s sessions in every room', async () => {
    const agentId = makeAgent('Elara')
    makeRoom('one', [agentId])
    makeRoom('two', [agentId])
    pool.keys = [`room_1_agent_${agentId}`, `room_2_agent_${agentId}`]

    expect(await service.deleteAgentWithCleanup(db, agentId)).toBe(true)

    expect(getAgent(db, agentId)).toBeNull()
    expect(pool.evicted.sort()).toEqual([`room_1_agent_${agentId}`, `room_2_agent_${agentId}`])
  })

  test('a room id that looks like the agent id is left alone', async () => {
    // `room_12_agent_3` belongs to agent 3; `room_3_agent_12` does not. A key
    // filter matching on the bare number would evict both.
    const three = makeAgent('Three')
    const twelve = makeAgent('Twelve')
    pool.keys = [`room_${twelve}_agent_${three}`, `room_${three}_agent_${twelve}`]

    await service.deleteAgentWithCleanup(db, three)

    expect(pool.evicted).toEqual([`room_${twelve}_agent_${three}`])
  })

  test('false for an agent that does not exist, and nothing is evicted', async () => {
    pool.keys = ['room_1_agent_9999']

    expect(await service.deleteAgentWithCleanup(db, 9999)).toBe(false)
    expect(pool.evicted).toEqual([])
  })

  test('a wedged session does not fail the delete', async () => {
    const agentId = makeAgent('Elara')
    pool.keys = [`room_1_agent_${agentId}`]
    pool.failOn = `room_1_agent_${agentId}`

    expect(await service.deleteAgentWithCleanup(db, agentId)).toBe(true)
    expect(getAgent(db, agentId)).toBeNull()
  })
})

// ============================================================================
// removeAgentFromRoomWithCleanup
// ============================================================================

describe('removeAgentFromRoomWithCleanup', () => {
  test('drops the membership and only that room’s session', async () => {
    const agentId = makeAgent('Elara')
    const roomA = makeRoom('one', [agentId])
    const roomB = makeRoom('two', [agentId])
    pool.keys = [`room_${roomA}_agent_${agentId}`, `room_${roomB}_agent_${agentId}`]

    expect(await service.removeAgentFromRoomWithCleanup(db, roomA, agentId)).toBe(true)

    expect(getAgentsInRoom(db, roomA)).toEqual([])
    expect(getAgentsInRoom(db, roomB).map((a) => a.id)).toEqual([agentId])
    expect(pool.evicted).toEqual([`room_${roomA}_agent_${agentId}`])
  })

  test('false when the membership was not there', async () => {
    const agentId = makeAgent('Elara')
    const roomId = makeRoom('one')

    expect(await service.removeAgentFromRoomWithCleanup(db, roomId, agentId)).toBe(false)
    expect(pool.evicted).toEqual([])
  })
})

// ============================================================================
// deleteRoomWithCleanup
// ============================================================================

describe('deleteRoomWithCleanup', () => {
  test('interrupts before deleting, then evicts the room', async () => {
    const agentId = makeAgent('Elara')
    const roomId = makeRoom('one', [agentId])
    pool.keys = [`room_${roomId}_agent_${agentId}`]

    expect(await service.deleteRoomWithCleanup(db, roomId)).toBe(true)

    expect(orchestrator.interrupted).toEqual([roomId])
    expect(getRoom(db, roomId)).toBeNull()
    expect(pool.evictedRooms).toEqual([roomId])
    expect(pool.evicted).toEqual([`room_${roomId}_agent_${agentId}`])
  })

  test('the interrupt happens even for a room that turns out not to exist', async () => {
    // Ordering matters more than the return value: an in-flight turn must be
    // stopped before the delete is attempted, not after it has been ruled out.
    expect(await service.deleteRoomWithCleanup(db, 4321)).toBe(false)
    expect(orchestrator.interrupted).toEqual([4321])
    expect(pool.evictedRooms).toEqual([])
  })

  test('a failing orchestrator does not block the delete', async () => {
    orchestrator.shouldThrow = true
    const roomId = makeRoom('one')

    expect(await service.deleteRoomWithCleanup(db, roomId)).toBe(true)
    expect(getRoom(db, roomId)).toBeNull()
  })

  test('works without an orchestrator at all', async () => {
    const bare = new AgentService(pool.asPool())
    const roomId = makeRoom('one')

    expect(await bare.deleteRoomWithCleanup(db, roomId)).toBe(true)
    expect(getRoom(db, roomId)).toBeNull()
  })
})

// ============================================================================
// clearRoomMessagesWithCleanup
// ============================================================================

describe('clearRoomMessagesWithCleanup', () => {
  test('clears messages, session ids and warm sessions together', async () => {
    const agentId = makeAgent('Elara')
    const roomId = makeRoom('one', [agentId])
    createMessage(db, roomId, { content: 'hello', role: 'user' })
    createMessage(db, roomId, { content: 'hi', role: 'assistant', agentId })
    updateRoomAgentSession(db, roomId, agentId, 'sess-abc')
    pool.keys = [`room_${roomId}_agent_${agentId}`]

    expect(await service.clearRoomMessagesWithCleanup(db, roomId)).toBe(true)

    expect(getMessages(db, roomId)).toEqual([])
    // The session row is the point: without dropping it the next turn would
    // `resume` a conversation still containing everything just deleted.
    expect(getRoomAgentSession(db, roomId, agentId)).toBeNull()
    expect(pool.evictedRooms).toEqual([roomId])
    expect(orchestrator.interrupted).toEqual([roomId])
  })

  test('only this room’s session rows are dropped', async () => {
    const agentId = makeAgent('Elara')
    const roomA = makeRoom('one', [agentId])
    const roomB = makeRoom('two', [agentId])
    createMessage(db, roomA, { content: 'hello', role: 'user' })
    updateRoomAgentSession(db, roomA, agentId, 'sess-a')
    updateRoomAgentSession(db, roomB, agentId, 'sess-b')

    await service.clearRoomMessagesWithCleanup(db, roomA)

    expect(getRoomAgentSession(db, roomB, agentId)).toBe('sess-b')
    expect(db.select().from(roomAgentSessions).where(eq(roomAgentSessions.roomId, roomA)).all())
      .toEqual([])
  })

  test('an empty room still clears — the boolean tracks existence, not content', async () => {
    const agentId = makeAgent('Elara')
    const roomId = makeRoom('one', [agentId])
    updateRoomAgentSession(db, roomId, agentId, 'sess-abc')

    expect(await service.clearRoomMessagesWithCleanup(db, roomId)).toBe(true)
    expect(getRoomAgentSession(db, roomId, agentId)).toBeNull()
  })

  test('false for a room that does not exist, and nothing is cleaned up', async () => {
    expect(await service.clearRoomMessagesWithCleanup(db, 4321)).toBe(false)

    // The interrupt still ran — it precedes the delete, as in `deleteRoom`.
    expect(orchestrator.interrupted).toEqual([4321])
    expect(pool.evictedRooms).toEqual([])
  })
})
