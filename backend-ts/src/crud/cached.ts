/**
 * Cached reads for the CRUD operations the polling endpoints hammer.
 *
 * Ported from `backend/crud/cached.py`.
 *
 * Three things about the Python module do not survive the port:
 *
 * 1. **No `make_transient`.** Python's whole detach dance (`cached.py:13-15`,
 *    `77-88`) exists because caching a session-bound ORM instance and reading
 *    it after the session closes raises `DetachedInstanceError`. Drizzle
 *    returns plain objects with the relationships already materialized, so
 *    there is nothing to detach and no lazy load left to trip over.
 * 2. **Synchronous, so no single-flight.** These use the cache's sync `getOrSet`,
 *    not `getOrSetAsync`. `bun:sqlite` runs a statement to completion before any
 *    other JS, so there is no await window between the miss and the store for a
 *    second caller to arrive in — the deduplication `getOrSetAsync` provides is
 *    unreachable here, and paying a promise for it would only add one.
 * 3. **Four functions are gone.** `get_agent_cached`, `get_messages_cached`,
 *    `get_recent_messages_cached` and `invalidate_messages_cache` have no
 *    caller anywhere in the Python tree outside `crud/__init__.py`'s re-export
 *    list. They are deliberately not ported; do not "restore" them without a
 *    consumer. `get_messages_since_cached` is a real function with real callers
 *    but belongs to the Phase 3 polling slice and lands with it.
 *
 * ## Writes still need invalidation, and do not have it yet
 *
 * Python invalidates from two places. The explicit helpers at the bottom of
 * this file are one; the other is inline invalidation buried in the write
 * functions themselves, which the TypeScript writes do **not** have, because
 * there was no cache layer to invalidate until this file existed. Whoever
 * ports or revisits those writes must add it, or a poll will serve a stale room
 * for up to 30 seconds after a pause and a stale message list for 5:
 *
 * | Python write                                  | Must invalidate                    |
 * | --------------------------------------------- | ---------------------------------- |
 * | `crud/rooms.py:101-104` `update_room`           | `roomObjectKey(roomId)`            |
 * | `crud/rooms.py:126-129` `mark_room_as_finished` | `roomObjectKey(roomId)`            |
 * | `crud/room_agents.py:59-62` `add_agent_to_room` | `roomAgentsKey(roomId)`            |
 * | `crud/room_agents.py:89-92` `remove_agent_from_room` | `roomAgentsKey(roomId)`       |
 * | `crud/messages.py:79-83` `create_message`       | pattern `roomMessagesKey(roomId)`  |
 * | `crud/messages.py:126-129` `create_system_message` | pattern `roomMessagesKey(roomId)` |
 * | `crud/agents.py:269-271` `update_agent`         | {@link invalidateAgentCache}       |
 *
 * `createMessage` and `addAgentToRoom` already exist in `crud/messages.ts` and
 * `crud/rooms.ts` without their invalidation call; that is the live gap.
 */

import type { Db } from '../db'
import type { Agent } from '../db/schema'
import {
  agentConfigKey,
  agentObjectKey,
  getCache,
  roomAgentsKey,
  roomMessagesKey,
  roomObjectKey,
} from '../infrastructure/cache'
import { getLogger } from '../infrastructure/logging/logger'
import { getMessagesAfterAgentResponse, type MessageWithAgent } from './messages'
import { getAgentsInRoom, getRoom, type RoomWithRelations } from './rooms'

const logger = getLogger('CachedCRUD')

/**
 * TTLs, in seconds, transcribed from `cached.py`'s docstring and call sites.
 *
 * Each is a bet about how stale a reader can stand to be. The room's is short
 * because `is_paused` and `is_finished` gate whether the scheduler keeps
 * talking; the message window's is very short because messages are written
 * constantly and a poller showing a turn late is the one thing a player
 * notices.
 */
const ROOM_TTL_SECONDS = 30
const ROOM_AGENTS_TTL_SECONDS = 60
const MESSAGES_TTL_SECONDS = 5

/** Get a room with its agents, messages and world, cached for 30 seconds. */
export function getRoomCached(db: Db, roomId: number): RoomWithRelations | null {
  return getCache().getOrSet<RoomWithRelations | null>(
    roomObjectKey(roomId),
    () => getRoom(db, roomId),
    ROOM_TTL_SECONDS,
  )
}

/** Get a room's agents, cached for 60 seconds. */
export function getAgentsCached(db: Db, roomId: number): Agent[] {
  return getCache().getOrSet<Agent[]>(
    roomAgentsKey(roomId),
    () => getAgentsInRoom(db, roomId),
    ROOM_AGENTS_TTL_SECONDS,
  )
}

/**
 * Messages posted since an agent last spoke, cached for 5 seconds.
 *
 * The key is derived from `roomMessagesKey` rather than built from scratch, and
 * that is load-bearing: sharing the `room_messages:{id}` prefix is what lets
 * {@link invalidateRoomCache} drop every message-derived entry for a room in one
 * prefix sweep, however many agent/limit combinations are live.
 */
export function getMessagesAfterAgentResponseCached(
  db: Db,
  roomId: number,
  agentId: number,
  limit = 200,
): MessageWithAgent[] {
  const key = `${roomMessagesKey(roomId)}:after:${agentId}:${limit}`
  return getCache().getOrSet<MessageWithAgent[]>(
    key,
    () => getMessagesAfterAgentResponse(db, roomId, agentId, limit),
    MESSAGES_TTL_SECONDS,
  )
}

// ============================================================================
// Invalidation
// ============================================================================

/**
 * Drop every cached entry derived from a room.
 *
 * Note the prefix sweep is on `room_messages:{id}` with no trailing separator,
 * exactly as in `cached.py:253`. That means invalidating room 1 also clears
 * rooms 10, 11 and 100. It is reproduced rather than fixed because the only
 * consequence is a few extra queries on the next poll, and diverging from
 * Python here would make the two caches behave differently for no gain.
 */
export function invalidateRoomCache(roomId: number): void {
  const cache = getCache()
  cache.invalidate(roomObjectKey(roomId))
  cache.invalidate(roomAgentsKey(roomId))
  cache.invalidatePattern(roomMessagesKey(roomId))
  logger.debug(`Invalidated cache for room ${roomId}`)
}

/**
 * Drop every cached entry derived from an agent.
 *
 * Both keys are cleared even though nothing writes `agentObjectKey` any more
 * (`get_agent_cached` is one of the four dead functions above): the config key
 * is live, and clearing a key that is never set is free.
 */
export function invalidateAgentCache(agentId: number): void {
  const cache = getCache()
  cache.invalidate(agentObjectKey(agentId))
  cache.invalidate(agentConfigKey(agentId))
  logger.debug(`Invalidated cache for agent ${agentId}`)
}
