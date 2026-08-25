/**
 * Session key parsing, and the pool lookups built on it.
 *
 * These are the pieces that decide *which* warm sessions an operation touches —
 * which agents a room reports, which sessions a deleted agent takes with it —
 * and every one of them used to be an ad-hoc `startsWith` or `endsWith` on a
 * key string. Python replaced the same ad-hoc parsing with `TaskIdentifier` for
 * the reason this file exists: `room_3_agent_12` and `room_12_agent_3` are one
 * careless substring apart.
 *
 * The pool itself is not exercised — opening a session spawns a CLI subprocess.
 * Its `sessions` map is populated directly, which is enough for lookups that
 * only read keys.
 */

import { describe, expect, test } from 'bun:test'

import { parseSessionKey, sessionKeyOf } from '@/sdk/client/session'
import { SessionPool } from '@/sdk/client/session-pool'

/** A pool holding the given keys, with a placeholder for each session. */
function poolWithKeys(keys: string[]): SessionPool {
  const pool = new SessionPool()
  const sessions = (pool as unknown as { sessions: Map<string, unknown> }).sessions
  for (const key of keys) sessions.set(key, { key })
  return pool
}

describe('session keys', () => {
  test('round-trip', () => {
    expect(sessionKeyOf({ roomId: 3, agentId: 12 })).toBe('room_3_agent_12')
    expect(parseSessionKey('room_3_agent_12')).toEqual({ roomId: 3, agentId: 12 })
  })

  test('anything that is not a key parses as null rather than throwing', () => {
    // Python's `TaskIdentifier.parse` raises. Every caller here is walking the
    // pool's own keys, where a malformed one would be this module's bug and not
    // the caller's input, so degrading is the useful behaviour.
    for (const bad of ['', 'room_3_agent', 'room_x_agent_1', 'room_3_agent_12_extra', 'agent_3']) {
      expect(parseSessionKey(bad)).toBeNull()
    }
  })
})

describe('SessionPool lookups', () => {
  const keys = [
    'room_3_agent_12',
    'room_12_agent_3',
    'room_3_agent_7',
    'room_31_agent_4',
    'not-a-session-key',
  ]

  test('agentsInRoom returns only that room, not a room whose id is a prefix', () => {
    // `room_31_...` starts with `room_3` — the trap a prefix match falls into.
    expect(poolWithKeys(keys).agentsInRoom(3).sort((a, b) => a - b)).toEqual([7, 12])
    expect(poolWithKeys(keys).agentsInRoom(31)).toEqual([4])
    expect(poolWithKeys(keys).agentsInRoom(99)).toEqual([])
  })

  test('keysForAgent returns only that agent, not a room whose id matches it', () => {
    expect(poolWithKeys(keys).keysForAgent(3)).toEqual(['room_12_agent_3'])
    expect(poolWithKeys(keys).keysForAgent(12)).toEqual(['room_3_agent_12'])
  })

  test('an unparseable key is skipped by both, not counted as NaN', () => {
    const pool = poolWithKeys(['garbage'])
    expect(pool.agentsInRoom(3)).toEqual([])
    expect(pool.keysForAgent(3)).toEqual([])
  })
})

/**
 * `acquire`'s reopen path against the MCP turn registry.
 *
 * `McpTools.bindTurn` binds a (room, agent) *before* the session is acquired,
 * on purpose: the CLI connects its MCP servers at startup, so a binding that
 * arrives later hands the agent an empty namespace for the session's whole
 * life. That put the pool's own reopen — evicting a session under a key whose
 * fingerprint changed — directly on top of a binding that had just been
 * installed for the turn about to run. The symptom was a warm agent losing
 * every tool at once: `No turn binding for room N, agent M`, then the CLI
 * retrying the handshake on the 2025-era leg and getting `Refused legacy
 * protocol era` from the endpoint.
 */
describe('SessionPool reopen vs. the turn binding', () => {
  interface FakeSession {
    key: string
    fingerprint: string
    isDead: boolean
    busy: boolean
    turnsProcessed: number
    sessionId: string | null
    openedWithResume: string | undefined
    close: () => Promise<void>
  }

  /** A pool whose opens are stubbed — a real one spawns a CLI subprocess. */
  function stubbedPool(onEvict: (id: string) => void): {
    pool: SessionPool
    seed: (id: string, fingerprint: string) => FakeSession
    opened: string[]
  } {
    const pool = new SessionPool(10, onEvict)
    const internals = pool as unknown as {
      sessions: Map<string, FakeSession>
      openSession: (id: string, options: unknown, fingerprint: string) => Promise<FakeSession>
    }
    const opened: string[] = []
    const make = (id: string, fingerprint: string): FakeSession => ({
      key: id,
      fingerprint,
      isDead: false,
      busy: false,
      turnsProcessed: 0,
      sessionId: null,
      openedWithResume: undefined,
      close: () => Promise.resolve(),
    })
    internals.openSession = async (id, _options, fingerprint) => {
      opened.push(id)
      const session = make(id, fingerprint)
      internals.sessions.set(id, session)
      return session
    }
    return {
      pool,
      seed: (id, fingerprint) => {
        const session = make(id, fingerprint)
        internals.sessions.set(id, session)
        return session
      },
      opened,
    }
  }

  test('a reopen under the same key does not release the binding just made for it', async () => {
    const released: string[] = []
    const { pool, seed, opened } = stubbedPool((id) => released.push(id))
    seed('room_15_agent_2', 'old-fingerprint')

    // What a turn does: bind, then acquire with options whose fingerprint moved
    // — the Action Manager's prompt carries the current location, and a
    // character's config is re-read every turn.
    await pool.acquire({ roomId: 15, agentId: 2 }, {}, 'new-fingerprint')

    expect(released).toEqual([])
    expect(opened).toEqual(['room_15_agent_2'])
    expect(pool.keys).toEqual(['room_15_agent_2'])
  })

  test('a real eviction still releases the binding', async () => {
    const released: string[] = []
    const { pool, seed } = stubbedPool((id) => released.push(id))
    seed('room_15_agent_2', 'fingerprint')

    await pool.evict('room_15_agent_2')

    expect(released).toEqual(['room_15_agent_2'])
    expect(pool.keys).toEqual([])
  })

  test('evictRoom and shutdown release, and pass no stray map index as options', async () => {
    const released: string[] = []
    const { pool, seed } = stubbedPool((id) => released.push(id))
    seed('room_15_agent_2', 'fingerprint')
    seed('room_15_agent_9', 'fingerprint')
    seed('room_16_agent_2', 'fingerprint')

    await pool.evictRoom(15)
    expect(released.sort()).toEqual(['room_15_agent_2', 'room_15_agent_9'])

    await pool.shutdown()
    expect(released.sort()).toEqual(['room_15_agent_2', 'room_15_agent_9', 'room_16_agent_2'])
  })
})
