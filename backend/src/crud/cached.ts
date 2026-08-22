/**
 * Cached reads for the CRUD the polling endpoints hammer. Sync `getOrSet`, not
 * `getOrSetAsync`: `bun:sqlite` runs a statement to completion before any other
 * JS, so there is no await window between miss and store. **Invalidation lives
 * at the writes** — the sweeps in `cache-invalidation.ts` plus inline sweeps in `rooms.ts`,
 * `messages.ts` and `agents.ts`; even the deletes sweep, since SQLite reuses
 * rowids. Only `deleteRoomMessages` skips it.
 */

import { getAgent } from './agents'
import type { Db } from '../db'
import type { Agent } from '../db/schema'
import {
  agentObjectKey,
  getCache,
  roomAgentsKey,
  roomMessagesKey,
  roomObjectKey,
} from '../infrastructure/cache'
import {
  getMessages,
  getMessagesAfterAgentResponse,
  getRecentMessages,
  type MessageWithAgent,
} from './messages'
import { getAgentsInRoom, getRoom, type RoomWithRelations } from './rooms'

// How stale a reader can stand to be: agent rows change only on a config edit,
// room flags gate the scheduler, a poller showing a turn late is user-visible.
const AGENT_TTL_SECONDS = 300
const ROOM_TTL_SECONDS = 30
const ROOM_AGENTS_TTL_SECONDS = 60
const MESSAGES_TTL_SECONDS = 5

/**
 * The long TTL is safe only because `invalidateAgentCache` (in `cache-invalidation.ts`) runs on every
 * `updateAgent`; without it a config hot-reload would take 5 minutes to land.
 */
export function getAgentCached(db: Db, agentId: number): Agent | null {
  return getCache().getOrSet<Agent | null>(
    agentObjectKey(agentId),
    () => getAgent(db, agentId),
    AGENT_TTL_SECONDS,
  )
}

export function getRoomCached(db: Db, roomId: number): RoomWithRelations | null {
  return getCache().getOrSet<RoomWithRelations | null>(
    roomObjectKey(roomId),
    () => getRoom(db, roomId),
    ROOM_TTL_SECONDS,
  )
}

export function getAgentsCached(db: Db, roomId: number): Agent[] {
  return getCache().getOrSet<Agent[]>(
    roomAgentsKey(roomId),
    () => getAgentsInRoom(db, roomId),
    ROOM_AGENTS_TTL_SECONDS,
  )
}

/**
 * The key is `roomMessagesKey(roomId)` itself — both an entry and the prefix
 * every other message entry extends, so one sweep clears the family. Unbounded.
 */
export function getMessagesCached(db: Db, roomId: number): MessageWithAgent[] {
  return getCache().getOrSet<MessageWithAgent[]>(
    roomMessagesKey(roomId),
    () => getMessages(db, roomId),
    MESSAGES_TTL_SECONDS,
  )
}

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
 * **Different semantics from the uncached `getMessagesSince`,** which returns
 * the *oldest* rows above `sinceId` so a client catches up page by page; this
 * filters the *newest* `bufferedLimit` rows, so a client further behind never
 * sees the rows in between. The buffer is why caching works — `sinceId` advances
 * every poll, so keying on it would miss.
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
 * The key derives from `roomMessagesKey`, which is load-bearing: sharing that
 * prefix lets one sweep drop every message-derived entry for a room.
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
