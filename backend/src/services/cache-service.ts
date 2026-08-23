/**
 * Facade over the in-memory request cache, adding one thing to `CacheManager`:
 * named invalidation groups, so a caller that changed a room need not remember
 * which four keys a room contributes. `infrastructure/cache.ts` owns TTL, LRU
 * and single-flight.
 *
 * **This is not the only invalidator.** `crud/cached.ts` has its own, and the
 * CRUD write paths call *those*; the key sets match except as noted on
 * {@link CacheService.invalidateRoom}.
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
} from '@/infrastructure/cache'
import { getLogger } from '@/infrastructure/logging/logger'

const logger = getLogger('CacheService')

export class CacheService {
  private readonly cache: CacheManager

  /** Defaults to the process-wide cache; an explicit one keeps tests isolated. */
  constructor(cacheManager: CacheManager = getCache()) {
    this.cache = cacheManager
  }

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

  /** Prefix match, not a glob, despite the name. */
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
   * Cache counters. `/debug/cache/stats` is a frozen wire shape with snake_case
   * keys (`total_requests`, `hit_rate`) while {@link CacheStats} is camelCase,
   * so that route must map the fields rather than serialise this directly.
   */
  getStats(): CacheStats {
    return this.cache.getStats()
  }

  logStats(): void {
    this.cache.logStats()
  }

  invalidateAgent(agentId: number): void {
    this.cache.invalidate(agentObjectKey(agentId))
    this.cache.invalidate(agentConfigKey(agentId))
    logger.debug(`Invalidated cache for agent ${agentId}`)
  }

  /**
   * Clears one key more than `crud/cached.ts::invalidateRoomCache`:
   * `chatting_agents:{id}`. The two are called from different places and the
   * extra key costs only a few saved queries.
   *
   * The message sweep is a prefix match on `room_messages:{id}` with no trailing
   * separator, so invalidating room 1 also clears rooms 10 and 100 — the same
   * quirk `cached.ts` has, and it stays for the reason noted there.
   */
  invalidateRoom(roomId: number): void {
    this.cache.invalidate(roomObjectKey(roomId))
    this.cache.invalidate(roomAgentsKey(roomId))
    this.cache.invalidate(chattingAgentsKey(roomId))
    this.cache.invalidatePattern(roomMessagesKey(roomId))
    logger.debug(`Invalidated cache for room ${roomId}`)
  }

  invalidateRoomAgents(roomId: number): void {
    this.cache.invalidate(roomAgentsKey(roomId))
    logger.debug(`Invalidated room agents cache for room ${roomId}`)
  }

  invalidateRoomMessages(roomId: number): void {
    this.cache.invalidatePattern(roomMessagesKey(roomId))
    logger.debug(`Invalidated message cache for room ${roomId}`)
  }
}

let cachedService: CacheService | null = null

/** Lazy so {@link resetCacheService} can hand the next caller a service built
 * against a different manager. */
export function getCacheService(): CacheService {
  if (cachedService === null) cachedService = new CacheService()
  return cachedService
}

/** Drop the singleton. Test-only. */
export function resetCacheService(): void {
  cachedService = null
}
