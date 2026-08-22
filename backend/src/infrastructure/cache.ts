/**
 * In-memory cache with TTL, LRU eviction and single-flight misses.
 *
 * Ported from `backend/infrastructure/cache.py`.
 *
 * The Python version carries a long comment about reconciling a `threading.Lock`
 * with an `asyncio.Lock` guarding the same dict. None of that survives the port:
 * every mutation here is synchronous, and synchronous code on this runtime is
 * already mutually exclusive. What *does* survive is the part the locks were
 * protecting against in the first place — the single-flight window, where N
 * concurrent misses on one key must run the factory once rather than N times.
 * That window is between two `await`s and is real in either language.
 *
 * Note this is a *request* cache, distinct from the mtime caches in
 * `sdk/loaders/` and the filesystem services: those exist to make agent files
 * hot-reloadable and key on mtime, this one keys on time-to-live.
 */

import { getLogger } from './logging/logger'

const logger = getLogger('Cache')

/**
 * Cap on live entries.
 *
 * Keys are per-room and per-agent, so the cache grows with world count. Without
 * a cap it only ever shrinks when an expired key happens to be read again, or
 * when the scheduler's five-minute sweep runs.
 */
export const DEFAULT_MAX_SIZE = 2000

/**
 * Miss sentinel.
 *
 * A cached `null`/`undefined` has to stay distinguishable from "not cached":
 * conflating them re-runs the factory on every read of a legitimately-null
 * value, which is exactly the case the cache is there to avoid.
 */
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

  // -- internals -----------------------------------------------------------

  /**
   * Read a live entry, dropping it when expired.
   *
   * `Map` preserves insertion order and has no `move_to_end`, so recency is
   * maintained by delete-then-set: a re-inserted key moves to the back, which
   * makes the first key in iteration order the least recently used.
   */
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

  // -- public API ----------------------------------------------------------

  /** Cached value, or `undefined` when absent or expired. */
  get<T = unknown>(key: string): T | undefined {
    const value = this.lookup(key)
    return value === MISSING ? undefined : (value as T)
  }

  set(key: string, value: unknown, ttlSeconds = 60): void {
    this.store(key, value, ttlSeconds)
    logger.debug(`Cache set: ${key} (TTL: ${ttlSeconds}s)`)
  }

  /** Remove one key. Returns whether it was present. */
  invalidate(key: string): boolean {
    if (!this.entries.delete(key)) return false
    this.stats.invalidations += 1
    logger.debug(`Cache invalidated: ${key}`)
    return true
  }

  /** Remove every key with this prefix. */
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
   * Drop expired entries.
   *
   * Called on a five-minute cadence by the background scheduler. The LRU cap
   * bounds the cache regardless; this reclaims entries that expired and were
   * never read again, before they reach the cap.
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
   * Async {@link getOrSet}, deduplicated per key.
   *
   * If several callers miss the same key at once, exactly one runs the factory
   * and the rest await its result — without this, N concurrent requests for an
   * uncached room each issued their own database query.
   *
   * A rejecting factory rejects every waiter and caches nothing, leaving the key
   * usable again immediately.
   */
  async getOrSetAsync<T>(key: string, factory: () => Promise<T>, ttlSeconds = 60): Promise<T> {
    const cached = this.lookup(key)
    if (cached !== MISSING) return cached as T

    const existing = this.inflight.get(key)
    if (existing !== undefined) return existing as Promise<T>

    // The promise is registered before it is awaited, so a second caller
    // arriving in the same tick joins it instead of starting its own factory.
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
      // Only clear our own slot: a later caller may already have started a new
      // computation for this key after ours settled.
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

// ============================================================================
// Key builders
// ============================================================================
// Kept as functions rather than inline template strings so that
// invalidatePattern's prefixes and the keys themselves cannot drift apart.

export const agentConfigKey = (agentId: number): string => `agent_config:${agentId}`
export const agentObjectKey = (agentId: number): string => `agent_obj:${agentId}`
export const roomObjectKey = (roomId: number): string => `room_obj:${roomId}`
export const roomAgentsKey = (roomId: number): string => `room_agents:${roomId}`
export const roomMessagesKey = (roomId: number): string => `room_messages:${roomId}`
export const chattingAgentsKey = (roomId: number): string => `chatting_agents:${roomId}`
