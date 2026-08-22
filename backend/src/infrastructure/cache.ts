/**
 * In-memory cache with TTL, LRU eviction and single-flight misses. Mutations are
 * synchronous and so already mutually exclusive; the only real race is the
 * single-flight window between two `await`s, where N concurrent misses on one
 * key must run the factory once. Distinct from the mtime caches in
 * `sdk/loaders/` and the filesystem services, which key on mtime instead.
 */

import { getLogger } from './logging/logger'

const logger = getLogger('Cache')

// Keys are per-room and per-agent, so without a cap the cache grows with world
// count and shrinks only when an expired key is read again.
export const DEFAULT_MAX_SIZE = 2000

// A cached `null`/`undefined` must stay distinguishable from "not cached", or
// the factory re-runs on every read of a legitimately-null value.
const MISSING = Symbol('cache.missing')

interface CacheEntry {
  value: unknown
  expiresAt: number
}

export interface CacheStats {
  hits: number
  misses: number
  invalidations: number
  evictions: number
  totalRequests: number
  hitRate: number
  size: number
}

export class CacheManager {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly maxSize: number
  private stats = { hits: 0, misses: 0, invalidations: 0, evictions: 0 }

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize
  }

  // Recency is maintained by delete-then-set: a re-inserted key moves to the
  // back, so the first key in iteration order is the least recently used.
  private lookup(key: string): unknown {
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.stats.misses += 1
      return MISSING
    }

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key)
      this.stats.misses += 1
      logger.debug(`Cache expired: ${key}`)
      return MISSING
    }

    this.entries.delete(key)
    this.entries.set(key, entry)
    this.stats.hits += 1
    return entry.value
  }

  private store(key: string, value: unknown, ttlSeconds: number): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })

    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
      this.stats.evictions += 1
      logger.debug(`Cache evicted (size cap ${this.maxSize}): ${oldest.value}`)
    }
  }

  /** Cached value, or `undefined` when absent or expired. */
  get<T = unknown>(key: string): T | undefined {
    const value = this.lookup(key)
    return value === MISSING ? undefined : (value as T)
  }

  set(key: string, value: unknown, ttlSeconds = 60): void {
    this.store(key, value, ttlSeconds)
    logger.debug(`Cache set: ${key} (TTL: ${ttlSeconds}s)`)
  }

  invalidate(key: string): boolean {
    if (!this.entries.delete(key)) return false
    this.stats.invalidations += 1
    logger.debug(`Cache invalidated: ${key}`)
    return true
  }

  invalidatePattern(prefix: string): void {
    const doomed = [...this.entries.keys()].filter((key) => key.startsWith(prefix))
    for (const key of doomed) {
      this.entries.delete(key)
      this.stats.invalidations += 1
    }
    if (doomed.length > 0) {
      logger.debug(`Cache invalidated pattern '${prefix}': ${doomed.length} keys`)
    }
  }

  clear(): void {
    const count = this.entries.size
    this.entries.clear()
    logger.info(`Cache cleared: ${count} entries removed`)
  }

  /**
   * Drop expired entries, on a five-minute cadence from the background
   * scheduler. The LRU cap bounds the cache regardless; this reclaims entries
   * that expired and were never read again, before they reach the cap.
   */
  cleanupExpired(): void {
    const now = Date.now()
    const doomed = [...this.entries.entries()]
      .filter(([, entry]) => entry.expiresAt < now)
      .map(([key]) => key)

    for (const key of doomed) this.entries.delete(key)
    if (doomed.length > 0) logger.debug(`Cache cleanup: ${doomed.length} expired entries removed`)
  }

  /** Cached value, or the result of `factory()` — computed and stored on a miss. */
  getOrSet<T = unknown>(key: string, factory: () => T, ttlSeconds = 60): T {
    const cached = this.lookup(key)
    if (cached !== MISSING) return cached as T

    const computed = factory()
    this.set(key, computed, ttlSeconds)
    return computed
  }

  /**
   * Async {@link getOrSet}, deduplicated per key: several callers missing at once
   * run the factory exactly once and the rest await its result. A rejecting
   * factory rejects every waiter and caches nothing.
   */
  async getOrSetAsync<T>(key: string, factory: () => Promise<T>, ttlSeconds = 60): Promise<T> {
    const cached = this.lookup(key)
    if (cached !== MISSING) return cached as T

    const existing = this.inflight.get(key)
    if (existing !== undefined) return existing as Promise<T>

    // Registered before it is awaited, so a second caller arriving in the same
    // tick joins it instead of starting its own factory.
    const pending = (async () => {
      const computed = await factory()
      this.store(key, computed, ttlSeconds)
      logger.debug(`Cache set: ${key} (TTL: ${ttlSeconds}s)`)
      return computed
    })()

    this.inflight.set(key, pending)
    try {
      return await pending
    } finally {
      // Only our own slot: a later caller may already have started a new one.
      if (this.inflight.get(key) === pending) this.inflight.delete(key)
    }
  }

  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses
    return {
      ...this.stats,
      totalRequests: total,
      hitRate: total > 0 ? Math.round((this.stats.hits / total) * 10000) / 100 : 0,
      size: this.entries.size,
    }
  }

  logStats(): void {
    const s = this.getStats()
    logger.info(
      `Cache stats: ${s.hits} hits, ${s.misses} misses, ${s.hitRate}% hit rate, ` +
        `${s.size} entries, ${s.invalidations} invalidations, ${s.evictions} evictions`,
    )
  }
}

const globalCache = new CacheManager()

export function getCache(): CacheManager {
  return globalCache
}

// Functions rather than inline template strings, so `invalidatePattern`'s
// prefixes and the keys themselves cannot drift apart.

export const agentConfigKey = (agentId: number): string => `agent_config:${agentId}`
export const agentObjectKey = (agentId: number): string => `agent_obj:${agentId}`
export const roomObjectKey = (roomId: number): string => `room_obj:${roomId}`
export const roomAgentsKey = (roomId: number): string => `room_agents:${roomId}`
export const roomMessagesKey = (roomId: number): string => `room_messages:${roomId}`
export const chattingAgentsKey = (roomId: number): string => `chatting_agents:${roomId}`
