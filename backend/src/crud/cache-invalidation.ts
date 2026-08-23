/**
 * Cache invalidation for the entries `cached.ts` populates. A separate module
 * from the cached readers on purpose: the raw CRUD writers (`rooms.ts`,
 * `agents.ts`, `worlds.ts`) import these sweeps, and `cached.ts` imports the
 * raw readers — one module holding both halves was a cycle.
 */

import {
  agentConfigKey,
  agentObjectKey,
  getCache,
  roomAgentsKey,
  roomMessagesKey,
  roomObjectKey,
} from '@/infrastructure/cache'
import { getLogger } from '@/infrastructure/logging/logger'

const logger = getLogger('CachedCRUD')

/** The sweep prefix has no separator, so room 1 also clears 10, 11 and 100. */
export function invalidateRoomCache(roomId: number): void {
  const cache = getCache()
  cache.invalidate(roomObjectKey(roomId))
  cache.invalidate(roomAgentsKey(roomId))
  cache.invalidatePattern(roomMessagesKey(roomId))
  logger.debug(`Invalidated cache for room ${roomId}`)
}

/**
 * Two keys: `agentObjectKey` here and `agentConfigKey` from the agent-config
 * service. Both have to go together, or a hot-reloaded prompt edit lands while
 * the row behind it still reads stale.
 */
export function invalidateAgentCache(agentId: number): void {
  const cache = getCache()
  cache.invalidate(agentObjectKey(agentId))
  cache.invalidate(agentConfigKey(agentId))
  logger.debug(`Invalidated cache for agent ${agentId}`)
}

/**
 * Message entries only — for callers that bulk-modify a transcript,
 * `deleteRoomMessages` in particular, which does not sweep on its own behalf.
 */
export function invalidateMessagesCache(roomId: number): void {
  getCache().invalidatePattern(roomMessagesKey(roomId))
  logger.debug(`Invalidated message cache for room ${roomId}`)
}
