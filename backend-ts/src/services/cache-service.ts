/**
 * Service-level facade over the in-memory request cache.
 *
 * Ported from `backend/services/cache_service.py`.
 *
 * The facade adds exactly one thing to `CacheManager`: named invalidation
 * groups, so a caller that changed a room does not have to remember which four
 * keys a room contributes. Everything else is pass-through and stays that way —
 * `infrastructure/cache.ts` owns TTL, LRU and single-flight, and a second copy
 * of any of that here would be a second thing to keep in sync.
 *
 * **This is not the only invalidator.** `crud/cached.ts` carries its own
 * `invalidateRoomCache` / `invalidateAgentCache`, ported from `crud/cached.py`,
 * and the CRUD write paths call *those*. The key sets are deliberately the same
 * where they overlap; the one difference is inherited from Python and called out
 * on {@link CacheService.invalidateRoom}.
 */

import {
  agentConfigKey,
  agentObjectKey,
  chattingAgentsKey,
  getCache,
  roomAgentsKey,
  roomMessagesKey,
  roomObjectKey,
  type CacheManager,
  type CacheStats,
} from '../infrastructure/cache'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('CacheService')

export class CacheService {
  private readonly cache: CacheManager

  /** Defaults to the process-wide cache; an explicit one keeps tests isolated. */
  constructor(cacheManager: CacheManager = getCache()) {
    this.cache = cacheManager
  }

  // --------------------------------------------------------------------
  // Pass-through
  // --------------------------------------------------------------------

  get<T = unknown>(key: string): T | undefined {
    return this.cache.get<T>(key)
  }

  set(key: string, value: unknown, ttlSeconds = 60): void {
    this.cache.set(key, value, ttlSeconds)
  }

  getOrSet<T = unknown>(key: string, factory: () => T, ttlSeconds = 60): T {
    return this.cache.getOrSet<T>(key, factory, ttlSeconds)
  }

  getOrSetAsync<T>(key: string, factory: () => Promise<T>, ttlSeconds = 60): Promise<T> {
    return this.cache.getOrSetAsync<T>(key, factory, ttlSeconds)
  }

  invalidate(key: string): boolean {
    return this.cache.invalidate(key)
  }

  /** Prefix match, not a glob — the name is Python's and is kept for grep parity. */
  invalidatePattern(pattern: string): void {
    this.cache.invalidatePattern(pattern)
  }

  cleanupExpired(): void {
    this.cache.cleanupExpired()
  }

  clear(): void {
    this.cache.clear()
  }

  /**
   * Cache counters.
   *
   * **Landmine for the debug router.** `routers/debug.py::get_cache_stats`
   * returns this dict straight onto the wire, so `/debug/cache/stats` is a
   * frozen API shape with the snake_case keys Python's dict has:
   * `total_requests` and `hit_rate`. {@link CacheStats} is camelCase like the
   * rest of the port, so whoever ports that route in Phase 3 must map the two
   * renamed fields rather than serialising this object directly.
   */
  getStats(): CacheStats {
    return this.cache.getStats()
  }

  logStats(): void {
    this.cache.logStats()
  }

  // --------------------------------------------------------------------
  // Invalidation groups
  // --------------------------------------------------------------------

  /** Call after an agent row changes or its filesystem config is reloaded. */
  invalidateAgent(agentId: number): void {
    this.cache.invalidate(agentObjectKey(agentId))
    this.cache.invalidate(agentConfigKey(agentId))
    logger.debug(`Invalidated cache for agent ${agentId}`)
  }

  /**
   * Call after a room is created, updated or deleted, or its settings change.
   *
   * This clears one key more than `crud/cached.ts::invalidateRoomCache` does:
   * `chatting_agents:{id}`. The divergence is Python's — `cache_service.py:89`
   * lists it, `cached.py:252` does not — and is reproduced rather than
   * reconciled, because the two are called from different places and the extra
   * key is only ever a few saved queries either way.
   *
   * The message sweep is a prefix match on `room_messages:{id}` with no
   * trailing separator, so invalidating room 1 also clears rooms 10 and 100.
   * Same inherited quirk as `cached.ts`; see its note for why it stays.
   */
  invalidateRoom(roomId: number): void {
    this.cache.invalidate(roomObjectKey(roomId))
    this.cache.invalidate(roomAgentsKey(roomId))
    this.cache.invalidate(chattingAgentsKey(roomId))
    this.cache.invalidatePattern(roomMessagesKey(roomId))
    logger.debug(`Invalidated cache for room ${roomId}`)
  }

  /** Call after an agent is added to or removed from a room. */
  invalidateRoomAgents(roomId: number): void {
    this.cache.invalidate(roomAgentsKey(roomId))
    logger.debug(`Invalidated room agents cache for room ${roomId}`)
  }

  /** Call after a message is written to a room. */
  invalidateRoomMessages(roomId: number): void {
    this.cache.invalidatePattern(roomMessagesKey(roomId))
    logger.debug(`Invalidated message cache for room ${roomId}`)
  }
}

let cachedService: CacheService | null = null

/**
 * The process-wide service, bound to the process-wide `CacheManager`.
 *
 * Lazy rather than eager so {@link resetCacheService} can hand the next caller
 * a service built against a different manager.
 */
export function getCacheService(): CacheService {
  if (cachedService === null) cachedService = new CacheService()
  return cachedService
}

/** Drop the singleton. Test-only, matching `reset_cache_service()`. */
export function resetCacheService(): void {
  cachedService = null
}
