/**
 * Cached reads for the CRUD operations the polling endpoints hammer.
 *
 * Ported from `backend/crud/cached.py`.
 *
 * Two things about the Python module do not survive the port:
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
 *
 * ## Invalidation lives at the writes, not here
 *
 * Python invalidates from two places, and so does this port. The explicit
 * helpers at the bottom of this file are one; the other is inline invalidation
 * inside the write functions themselves. Every one of those is now wired:
 *
 * | Write                                     | Invalidates                        |
 * | ----------------------------------------- | ---------------------------------- |
 * | `rooms.ts` `updateRoom`                   | `roomObjectKey(roomId)`            |
 * | `rooms.ts` `markRoomAsFinished`           | `roomObjectKey(roomId)`            |
 * | `rooms.ts` `addAgentToRoom`               | `roomAgentsKey(roomId)`            |
 * | `rooms.ts` `removeAgentFromRoom`          | `roomAgentsKey(roomId)`            |
 * | `messages.ts` `createMessage`             | pattern `roomMessagesKey(roomId)`  |
 * | `agents.ts` `updateAgent`                 | {@link invalidateAgentCache}       |
 *
 * Three writes invalidate where Python does *not* — `rooms.ts::deleteRoom`,
 * `agents.ts::deleteAgent` and `worlds.ts::deleteWorld` — because SQLite reuses
 * rowids and a cached entry outliving its row can be served to whatever row
 * inherits the id. Each says so at its definition.
 *
 * The one write that deliberately does **not** invalidate is
 * `messages.ts::deleteRoomMessages`, matching Python: its caller
 * (`services/agent_service.py:188`) owns the sweep because clearing a room is
 * only half of an operation that also tears down agent sessions.
 */

import { getAgent } from './agents'
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
import {
  getMessages,
  getMessagesAfterAgentResponse,
  getRecentMessages,
  type MessageWithAgent,
} from './messages'
import { getAgentsInRoom, getRoom, type RoomWithRelations } from './rooms'

const logger = getLogger('CachedCRUD')

/**
 * TTLs, in seconds, transcribed from `cached.py`'s docstring and call sites.
 *
 * Each is a bet about how stale a reader can stand to be. The agent's is long
 * because a row only changes when someone edits a config file; the room's is
 * short because `is_paused` and `is_finished` gate whether the scheduler keeps
 * talking; the message window's is very short because messages are written
 * constantly and a poller showing a turn late is the one thing a player
 * notices.
 */
const AGENT_TTL_SECONDS = 300
const ROOM_TTL_SECONDS = 30
const ROOM_AGENTS_TTL_SECONDS = 60
const MESSAGES_TTL_SECONDS = 5

/**
 * Get an agent by id, cached for 5 minutes.
 *
 * The long TTL is safe only because {@link invalidateAgentCache} runs on every
 * `updateAgent`. Without that, a config hot-reload — the whole point of the
 * filesystem-primary architecture — would take up to five minutes to reach the
 * next turn's prompt.
 */
export function getAgentCached(db: Db, agentId: number): Agent | null {
  return getCache().getOrSet<Agent | null>(
    agentObjectKey(agentId),
    () => getAgent(db, agentId),
    AGENT_TTL_SECONDS,
  )
}

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
 * A room's entire transcript, cached for 5 seconds.
 *
 * The key is `roomMessagesKey(roomId)` itself, with no suffix — it is both an
 * entry and the prefix every other message entry for the room extends, which is
 * what makes one `invalidatePattern` sweep clear the family.
 *
 * Unbounded, like the reader it wraps. Caching an unbounded list is a poor
 * trade for a long-running room and is why the polling path uses
 * {@link getMessagesSinceCached} instead; this exists for the full-history
 * consumers.
 */
export function getMessagesCached(db: Db, roomId: number): MessageWithAgent[] {
  return getCache().getOrSet<MessageWithAgent[]>(
    roomMessagesKey(roomId),
    () => getMessages(db, roomId),
    MESSAGES_TTL_SECONDS,
  )
}

/** The newest `limit` messages, oldest first, cached for 5 seconds. */
export function getRecentMessagesCached(
  db: Db,
  roomId: number,
  limit = 200,
): MessageWithAgent[] {
  const key = `${roomMessagesKey(roomId)}:recent:${limit}`
  return getCache().getOrSet<MessageWithAgent[]>(
    key,
    () => getRecentMessages(db, roomId, limit),
    MESSAGES_TTL_SECONDS,
  )
}

/**
 * The polling read: new messages since an id, served out of a cached window.
 *
 * Note this has **different semantics** from the uncached
 * `getMessagesSince` in `crud/messages.ts`, and the difference is Python's, not
 * an artefact of the port. The uncached version asks the database for the
 * *oldest* `limit` rows above `sinceId`, so a client that fell behind catches up
 * page by page. This one filters a window of the *newest* `bufferedLimit` rows,
 * so a client more than `bufferedLimit` messages behind never sees the rows in
 * between — they fall out of the bottom of the window. Only the two callers'
 * choice of function decides which behaviour a poller gets.
 *
 * The buffer (`max(limit * 2, 50)`) is the reason this is worth caching at all:
 * `sinceId` advances on every poll, so keying the cache on it would miss every
 * time. Keying on a wider window that several consecutive polls can be answered
 * from is what turns a query-per-poll into a query per 5 seconds.
 */
export function getMessagesSinceCached(
  db: Db,
  roomId: number,
  sinceId: number | null = null,
  limit = 100,
): MessageWithAgent[] {
  const bufferedLimit = Math.max(limit * 2, 50)
  const recent = getRecentMessagesCached(db, roomId, bufferedLimit)

  if (sinceId === null) return recent.slice(0, limit)

  return recent.filter((m) => m.id > sinceId).slice(0, limit)
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
 * Two keys, written by two different layers: `agentObjectKey` by
 * {@link getAgentCached} here, and `agentConfigKey` by the agent-config service,
 * which is what actually carries a hot-reloaded system prompt into the next
 * turn. Both have to go together or an edit lands in the prompt while the row
 * behind it still reads stale, or the reverse.
 */
export function invalidateAgentCache(agentId: number): void {
  const cache = getCache()
  cache.invalidate(agentObjectKey(agentId))
  cache.invalidate(agentConfigKey(agentId))
  logger.debug(`Invalidated cache for agent ${agentId}`)
}

/**
 * Drop only a room's message entries, leaving the room object and its
 * membership list cached.
 *
 * The narrower sibling of {@link invalidateRoomCache}, for callers that wrote
 * messages and nothing else. It is the same prefix sweep
 * `crud/messages.ts::createMessage` performs inline, exposed for the service-layer callers that bulk-modify a
 * transcript — `deleteRoomMessages` in particular, which deliberately does not
 * sweep on its own behalf.
 *
 * Same prefix caveat as {@link invalidateRoomCache}: clearing room 1 also
 * clears rooms 10, 11 and 100.
 */
export function invalidateMessagesCache(roomId: number): void {
  getCache().invalidatePattern(roomMessagesKey(roomId))
  logger.debug(`Invalidated message cache for room ${roomId}`)
}
