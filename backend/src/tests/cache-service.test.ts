/**
 * The cache facade.
 *
 * The interesting surface is the invalidation groups, and specifically which
 * keys each one covers — `crud/cached.ts` invalidates the same cache from the
 * write paths, so the two must agree on key names or a write clears nothing.
 * Every test runs against its own {@link CacheManager}; only the singleton tests
 * touch the process-wide one, and they do not write to it.
 */

import { describe, expect, test } from 'bun:test'

import {
  CacheManager,
  agentConfigKey,
  agentObjectKey,
  chattingAgentsKey,
  getCache,
  roomAgentsKey,
  roomMessagesKey,
  roomObjectKey,
} from '@/infrastructure/cache'
import { CacheService, getCacheService, resetCacheService } from '@/services/cache-service'

function makeService(): { service: CacheService; cache: CacheManager } {
  const cache = new CacheManager()
  return { service: new CacheService(cache), cache }
}

/** Populate every key a room and an agent can contribute. */
function fillRoomAndAgent(service: CacheService, roomId: number, agentId: number): void {
  service.set(roomObjectKey(roomId), 'room')
  service.set(roomAgentsKey(roomId), 'agents')
  service.set(chattingAgentsKey(roomId), 'chatting')
  service.set(roomMessagesKey(roomId), 'messages')
  // The shape `crud/cached.ts::getMessagesAfterAgentResponseCached` writes:
  // derived from the room's message key so a prefix sweep reaches it.
  service.set(`${roomMessagesKey(roomId)}:after:${agentId}:200`, 'window')
  service.set(agentObjectKey(agentId), 'agent')
  service.set(agentConfigKey(agentId), 'config')
}

// ============================================================================
// Pass-through
// ============================================================================

describe('pass-through', () => {
  test('reads and writes land on the wrapped manager, not a second store', () => {
    const { service, cache } = makeService()

    service.set('k', 'v')

    expect(cache.get<string>('k')).toBe('v')
    expect(service.get<string>('k')).toBe('v')
  })

  test('a miss is undefined', () => {
    const { service } = makeService()
    expect(service.get<string>('absent')).toBeUndefined()
  })

  test('getOrSet computes once and caches', () => {
    const { service } = makeService()
    let calls = 0

    const factory = (): string => {
      calls += 1
      return 'computed'
    }

    expect(service.getOrSet('k', factory)).toBe('computed')
    expect(service.getOrSet('k', factory)).toBe('computed')
    expect(calls).toBe(1)
  })

  test('getOrSetAsync deduplicates concurrent misses', async () => {
    const { service } = makeService()
    let calls = 0

    const factory = async (): Promise<number> => {
      calls += 1
      await Promise.resolve()
      return 42
    }

    const [a, b] = await Promise.all([
      service.getOrSetAsync('k', factory),
      service.getOrSetAsync('k', factory),
    ])

    expect([a, b]).toEqual([42, 42])
    expect(calls).toBe(1)
  })

  test('an elapsed TTL expires the entry, and the entry is gone on the next read', () => {
    const { service } = makeService()

    service.set('k', 'v', -1)

    expect(service.get<string>('k')).toBeUndefined()
  })

  test('cleanupExpired and clear both empty the store', () => {
    const { service } = makeService()

    service.set('live', 'v', 60)
    service.set('dead', 'v', -1)
    service.cleanupExpired()
    expect(service.getStats().size).toBe(1)

    service.clear()
    expect(service.getStats().size).toBe(0)
  })

  test('invalidate reports whether the key was there', () => {
    const { service } = makeService()

    service.set('k', 'v')

    expect(service.invalidate('k')).toBe(true)
    expect(service.invalidate('k')).toBe(false)
  })

  test('getStats counts hits and misses through the facade', () => {
    const { service } = makeService()

    service.set('k', 'v')
    service.get<string>('k')
    service.get<string>('absent')

    const stats = service.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.totalRequests).toBe(2)
    expect(stats.hitRate).toBe(50)
  })
})

// ============================================================================
// Invalidation groups
// ============================================================================

describe('invalidation groups', () => {
  test('invalidateAgent clears both agent keys and nothing else', () => {
    const { service } = makeService()
    fillRoomAndAgent(service, 1, 7)

    service.invalidateAgent(7)

    expect(service.get<string>(agentObjectKey(7))).toBeUndefined()
    expect(service.get<string>(agentConfigKey(7))).toBeUndefined()
    expect(service.get<string>(roomObjectKey(1))).toBe('room')
  })

  test('invalidateRoom clears the room, its agents, its chat roster and every message entry', () => {
    const { service } = makeService()
    fillRoomAndAgent(service, 1, 7)

    service.invalidateRoom(1)

    expect(service.get<string>(roomObjectKey(1))).toBeUndefined()
    expect(service.get<string>(roomAgentsKey(1))).toBeUndefined()
    expect(service.get<string>(roomMessagesKey(1))).toBeUndefined()
    expect(service.get<string>(`${roomMessagesKey(1)}:after:7:200`)).toBeUndefined()
    // Agent keys are not room-derived and survive.
    expect(service.get<string>(agentConfigKey(7))).toBe('config')
  })

  test('invalidateRoom clears chatting_agents — the one key crud/cached.ts leaves alone', () => {
    // Inherited divergence: `cache_service.py:89` lists this key,
    // `cached.py:252` does not. Pinned so nobody "harmonises" it by accident.
    const { service } = makeService()
    service.set(chattingAgentsKey(1), 'chatting')

    service.invalidateRoom(1)

    expect(service.get<string>(chattingAgentsKey(1))).toBeUndefined()
  })

  test("the message sweep has no separator, so room 1 also clears rooms 10 and 100", () => {
    const { service } = makeService()
    service.set(roomMessagesKey(1), 'one')
    service.set(roomMessagesKey(10), 'ten')
    service.set(roomMessagesKey(100), 'hundred')
    service.set(roomMessagesKey(2), 'two')

    service.invalidateRoom(1)

    expect(service.get<string>(roomMessagesKey(10))).toBeUndefined()
    expect(service.get<string>(roomMessagesKey(100))).toBeUndefined()
    expect(service.get<string>(roomMessagesKey(2))).toBe('two')
  })

  test('invalidateRoomAgents touches only the roster', () => {
    const { service } = makeService()
    fillRoomAndAgent(service, 1, 7)

    service.invalidateRoomAgents(1)

    expect(service.get<string>(roomAgentsKey(1))).toBeUndefined()
    expect(service.get<string>(roomObjectKey(1))).toBe('room')
    expect(service.get<string>(roomMessagesKey(1))).toBe('messages')
  })

  test('invalidateRoomMessages sweeps the message prefix only', () => {
    const { service } = makeService()
    fillRoomAndAgent(service, 1, 7)

    service.invalidateRoomMessages(1)

    expect(service.get<string>(roomMessagesKey(1))).toBeUndefined()
    expect(service.get<string>(`${roomMessagesKey(1)}:after:7:200`)).toBeUndefined()
    expect(service.get<string>(roomObjectKey(1))).toBe('room')
  })
})

// ============================================================================
// Singleton
// ============================================================================

describe('getCacheService', () => {
  test('is a singleton bound to the process-wide cache manager', () => {
    resetCacheService()
    const first = getCacheService()

    expect(getCacheService()).toBe(first)

    // Bound to the global manager, not to a private one: a key written through
    // the manager is readable through the facade.
    const key = 'cache-service-test:binding'
    getCache().set(key, 'v', 60)
    expect(first.get<string>(key)).toBe('v')
    getCache().invalidate(key)
  })

  test('resetCacheService drops the instance', () => {
    resetCacheService()
    const first = getCacheService()
    resetCacheService()

    expect(getCacheService()).not.toBe(first)
  })
})
