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

import { parseSessionKey, sessionKeyOf } from '../sdk/client/session'
import { SessionPool } from '../sdk/client/session-pool'

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
