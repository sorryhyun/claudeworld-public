/**
 * Port of `backend/tests/unit/test_cache.py`.
 *
 * The single-flight cases are the ones worth having: the LRU and TTL bookkeeping
 * is mechanical, but "N concurrent misses run the factory once" is the property
 * the cache exists for and the one that silently regresses.
 */

import { describe, expect, test } from 'bun:test'

import { CacheManager, roomAgentsKey, roomMessagesKey } from '@/infrastructure/cache'

/** Resolve on the next macrotask, so concurrent callers really do overlap. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

describe('get / set', () => {
  test('stores and returns a value', () => {
    const cache = new CacheManager()
    cache.set('k', 'v')

    expect(cache.get<string>('k')).toBe('v')
  })

  test('a missing key returns undefined', () => {
    expect(new CacheManager().get('nope')).toBeUndefined()
  })

  test('an expired entry is a miss', async () => {
    const cache = new CacheManager()
    cache.set('k', 'v', 0.01)
    await Bun.sleep(20)

    expect(cache.get('k')).toBeUndefined()
    expect(cache.getStats().misses).toBe(1)
  })
})

describe('invalidation', () => {
  test('invalidate removes a key and reports whether it was there', () => {
    const cache = new CacheManager()
    cache.set('k', 'v')

    expect(cache.invalidate('k')).toBe(true)
    expect(cache.invalidate('k')).toBe(false)
    expect(cache.get('k')).toBeUndefined()
  })

  test('invalidatePattern is a prefix match, not a substring one', () => {
    const cache = new CacheManager()
    cache.set(roomAgentsKey(1), 'a')
    cache.set(roomMessagesKey(1), 'm')
    cache.set('other:room_agents:1', 'x')

    cache.invalidatePattern('room_agents:')

    expect(cache.get(roomAgentsKey(1))).toBeUndefined()
    expect(cache.get<string>(roomMessagesKey(1))).toBe('m')
    expect(cache.get<string>('other:room_agents:1')).toBe('x')
  })

  test('clear empties everything', () => {
    const cache = new CacheManager()
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()

    expect(cache.getStats().size).toBe(0)
  })

  test('cleanupExpired leaves live entries alone', async () => {
    const cache = new CacheManager()
    cache.set('short', 1, 0.01)
    cache.set('long', 2, 60)
    await Bun.sleep(20)

    cache.cleanupExpired()

    expect(cache.getStats().size).toBe(1)
    expect(cache.get<number>('long')).toBe(2)
  })
})

describe('statistics', () => {
  test('track hits and misses', () => {
    const cache = new CacheManager()
    cache.set('k', 'v')
    cache.get('k')
    cache.get('k')
    cache.get('absent')

    const stats = cache.getStats()
    expect(stats.hits).toBe(2)
    expect(stats.misses).toBe(1)
    expect(stats.totalRequests).toBe(3)
    expect(stats.hitRate).toBeCloseTo(66.67, 1)
  })
})

describe('LRU eviction', () => {
  test('evicts when over the size cap', () => {
    const cache = new CacheManager(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    expect(cache.getStats().size).toBe(2)
    expect(cache.getStats().evictions).toBe(1)
    expect(cache.get('a')).toBeUndefined()
  })

  test('evicts the least recently *used*, not the least recently written', () => {
    const cache = new CacheManager(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a') // 'a' is now the newer of the two
    cache.set('c', 3)

    expect(cache.get<number>('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
  })
})

describe('getOrSet', () => {
  test('computes once, then serves from cache', () => {
    const cache = new CacheManager()
    let calls = 0
    const factory = () => {
      calls += 1
      return 'value'
    }

    expect(cache.getOrSet('k', factory)).toBe('value')
    expect(cache.getOrSet('k', factory)).toBe('value')
    expect(calls).toBe(1)
  })

  test('a cached null is not recomputed', () => {
    const cache = new CacheManager()
    let calls = 0
    const factory = () => {
      calls += 1
      return null
    }

    cache.getOrSet('k', factory)
    cache.getOrSet('k', factory)

    // The whole reason for the MISSING sentinel: a null that reads as "absent"
    // makes the cache a no-op for every legitimately-null value.
    expect(calls).toBe(1)
  })
})

describe('getOrSetAsync', () => {
  test('concurrent misses run the factory once', async () => {
    const cache = new CacheManager()
    let calls = 0
    const factory = async () => {
      calls += 1
      await tick()
      return 'value'
    }

    const results = await Promise.all([
      cache.getOrSetAsync('k', factory),
      cache.getOrSetAsync('k', factory),
      cache.getOrSetAsync('k', factory),
    ])

    expect(results).toEqual(['value', 'value', 'value'])
    expect(calls).toBe(1)
  })

  test('a cached value skips the factory entirely', async () => {
    const cache = new CacheManager()
    cache.set('k', 'cached')
    let calls = 0

    const result = await cache.getOrSetAsync('k', async () => {
      calls += 1
      return 'fresh'
    })

    expect(result).toBe('cached')
    expect(calls).toBe(0)
  })

  test('a cached null is not recomputed', async () => {
    const cache = new CacheManager()
    let calls = 0
    const factory = async () => {
      calls += 1
      return null
    }

    await cache.getOrSetAsync('k', factory)
    await cache.getOrSetAsync('k', factory)

    expect(calls).toBe(1)
  })

  test('a failing factory rejects every waiter and caches nothing', async () => {
    const cache = new CacheManager()
    let calls = 0
    const factory = async () => {
      calls += 1
      await tick()
      throw new Error('boom')
    }

    const settled = await Promise.allSettled([
      cache.getOrSetAsync('k', factory),
      cache.getOrSetAsync('k', factory),
    ])

    expect(settled.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(calls).toBe(1)
    expect(cache.get('k')).toBeUndefined()
  })

  test('a key is usable again after a failure', async () => {
    const cache = new CacheManager()

    await expect(
      cache.getOrSetAsync('k', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')

    expect(await cache.getOrSetAsync('k', async () => 'recovered')).toBe('recovered')
  })

  test('different keys do not block each other', async () => {
    const cache = new CacheManager()
    let released = false

    const slow = cache.getOrSetAsync('slow', async () => {
      await Bun.sleep(30)
      released = true
      return 'slow'
    })
    const fast = await cache.getOrSetAsync('fast', async () => 'fast')

    expect(fast).toBe('fast')
    expect(released).toBe(false)
    expect(await slow).toBe('slow')
  })
})
