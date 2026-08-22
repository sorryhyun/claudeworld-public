/** CRUD operations for Message entities. Synchronous throughout. */

import { and, asc, count, desc, eq, gt, gte, isNull, type SQL } from 'drizzle-orm'
import type { Db } from '../db'
import type { ParticipantType } from '../domain/enums'
import { agents, messages, roomAgents, rooms, type Message, type MessageRole } from '../db/schema'
import { getCache, roomMessagesKey } from '../infrastructure/cache'

export type { ParticipantType }

// A type alias, not an interface: callers' `GameTime` has no index signature,
// so an interface here would not be assignable.
export type GameTimeSnapshot = { hour: number; minute: number; day: number }

export interface MessageImage {
  data: string
  mediaType: string
}

export interface MessageCreate {
  content: string
  role: MessageRole
  agentId?: number | null
  participantType?: ParticipantType | null
  participantName?: string | null
  thinking?: string | null
  anthropicCalls?: string[] | null
  images?: MessageImage[] | null
  /** Deprecated single-image fields, kept because the column still exists. */
  imageData?: string | null
  imageMediaType?: string | null
  chatSessionId?: number | null
  gameTimeSnapshot?: GameTimeSnapshot | null
}

export interface CreateMessageOptions {
  /** Defaults to true. */
  updateRoomActivity?: boolean
}

// An empty array or object is stored as NULL, not as `"[]"`/`"{}"`.
function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value) && value.length === 0) return null
  if (typeof value === 'object' && Object.keys(value as object).length === 0) return null
  return JSON.stringify(value)
}

/** One transaction, so a poller cannot see a message whose room looks idle. */
export function createMessage(
  db: Db,
  roomId: number,
  message: MessageCreate,
  { updateRoomActivity = true }: CreateMessageOptions = {},
): Message {
  const row = db.transaction((tx) => {
    const inserted = tx
      .insert(messages)
      .values({
        roomId,
        agentId: message.agentId ?? null,
        content: message.content,
        role: message.role,
        participantType: message.participantType ?? null,
        participantName: message.participantName ?? null,
        thinking: message.thinking ?? null,
        anthropicCalls: jsonOrNull(message.anthropicCalls),
        images: jsonOrNull(
          message.images?.map((img) => ({ data: img.data, media_type: img.mediaType })),
        ),
        imageData: message.imageData ?? null,
        imageMediaType: message.imageMediaType ?? null,
        chatSessionId: message.chatSessionId ?? null,
        gameTimeSnapshot: jsonOrNull(message.gameTimeSnapshot),
        // Explicit rather than the column's CURRENT_TIMESTAMP default, which
        // has second resolution and would sort differently.
        timestamp: new Date(),
      })
      .returning()
      .get()

    if (updateRoomActivity) {
      tx.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.id, roomId)).run()
    }

    return inserted
  })

  // After the commit: the poll loop runs every 2s against a 5s cache, so
  // skipping this makes a turn's replies miss two or three polls.
  getCache().invalidatePattern(roomMessagesKey(roomId))

  return row
}

/** Note the inverted default: bookkeeping must not reorder a room list. */
export function createSystemMessage(
  db: Db,
  roomId: number,
  content: string,
  { updateRoomActivity = false }: CreateMessageOptions = {},
): Message {
  return createMessage(
    db,
    roomId,
    { content, role: 'assistant', agentId: null, participantType: 'system' },
    { updateRoomActivity },
  )
}

function getLastAgentMessageId(db: Db, roomId: number, agentId: number): number | null {
  const row = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.roomId, roomId), eq(messages.agentId, agentId)))
    .orderBy(desc(messages.id))
    .limit(1)
    .get()
  return row?.id ?? null
}

// Null for rows that predate the `joined_at` column.
function getAgentJoinedAt(db: Db, roomId: number, agentId: number): Date | null {
  const row = db
    .select({ joinedAt: roomAgents.joinedAt })
    .from(roomAgents)
    .where(and(eq(roomAgents.roomId, roomId), eq(roomAgents.agentId, agentId)))
    .get()
  return row?.joinedAt ?? null
}

export interface MessageWithAgent extends Message {
  /** Eager-loaded; prompt building reads the agent name off it. */
  agent: typeof agents.$inferSelect | null
}

/**
 * The room's messages with `agent` resolved. The `id` tiebreaker matters:
 * `Date` is millisecond-resolution, so a burst lands on identical timestamps
 * SQLite may return in any order. `newestFirst` sorts descending, limits, then
 * reverses in memory for the *latest* N.
 */
function selectWithAgent(
  db: Db,
  where: SQL,
  { newestFirst, limit }: { newestFirst: boolean; limit?: number },
): MessageWithAgent[] {
  const ordered = db
    .select({ message: messages, agent: agents })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .where(where)
    .orderBy(
      newestFirst ? desc(messages.timestamp) : asc(messages.timestamp),
      newestFirst ? desc(messages.id) : asc(messages.id),
    )

  const rows = limit === undefined ? ordered.all() : ordered.limit(limit).all()
  const mapped = rows.map((r) => ({ ...r.message, agent: r.agent }))
  return newestFirst ? mapped.reverse() : mapped
}

/**
 * How many agent lines a room holds. Counts on `role`, not "has an agent_id":
 * narration output has both, system messages neither. Zero is what "this room
 * has never produced a turn" means — see `routes/game/polling.ts`.
 */
export function countAssistantMessages(db: Db, roomId: number): number {
  return (
    db
      .select({ total: count() })
      .from(messages)
      .where(and(eq(messages.roomId, roomId), eq(messages.role, 'assistant')))
      .get()?.total ?? 0
  )
}

/** Unbounded, for full-history consumers; polling uses {@link getMessagesSince}. */
export function getMessages(db: Db, roomId: number): MessageWithAgent[] {
  return selectWithAgent(db, eq(messages.roomId, roomId), { newestFirst: false })
}

/**
 * The polling read, hit every 2s per open room, so `limit` is clamped rather
 * than rejected. Sorts *ascending* before limiting, unlike its neighbours: a
 * client that fell behind catches up from the oldest unseen.
 */
export function getMessagesSince(
  db: Db,
  roomId: number,
  sinceId: number | null = null,
  limit = 100,
): MessageWithAgent[] {
  const where =
    sinceId === null
      ? eq(messages.roomId, roomId)
      : and(eq(messages.roomId, roomId), gt(messages.id, sinceId))!

  return selectWithAgent(db, where, { newestFirst: false, limit: Math.min(limit, 1000) })
}

/** The newest `limit` messages in a room, returned oldest first. */
export function getRecentMessages(db: Db, roomId: number, limit = 200): MessageWithAgent[] {
  return selectWithAgent(db, eq(messages.roomId, roomId), { newestFirst: true, limit })
}

/**
 * Chat mode and gameplay share a room and a table, and `chat_session_id` is the
 * entire separation: widening this or {@link getMessagesExcludingChat} leaks one
 * mode's transcript into the other's prompt.
 */
export function getChatSessionMessages(
  db: Db,
  roomId: number,
  chatSessionId: number,
  limit = 100,
): MessageWithAgent[] {
  const where = and(eq(messages.roomId, roomId), eq(messages.chatSessionId, chatSessionId))!
  return selectWithAgent(db, where, { newestFirst: true, limit })
}

/** `IS NULL`, not `eq(col, null)` — that renders `= NULL` and matches nothing. */
export function getMessagesExcludingChat(db: Db, roomId: number, limit = 200): MessageWithAgent[] {
  const where = and(eq(messages.roomId, roomId), isNull(messages.chatSessionId))!
  return selectWithAgent(db, where, { newestFirst: true, limit })
}

/**
 * The agent's "what did I miss": everything above its last message id; else
 * everything since its `joined_at`, so a late arrival skips the backlog (an
 * invite has no id, hence the timestamp); else the recent window.
 */
export function getMessagesAfterAgentResponse(
  db: Db,
  roomId: number,
  agentId: number,
  limit = 200,
): MessageWithAgent[] {
  const lastAgentMessageId = getLastAgentMessageId(db, roomId, agentId)

  let where = eq(messages.roomId, roomId)
  if (lastAgentMessageId !== null) {
    where = and(where, gt(messages.id, lastAgentMessageId))!
  } else {
    const joinedAt = getAgentJoinedAt(db, roomId, agentId)
    if (joinedAt !== null) {
      where = and(where, gte(messages.timestamp, joinedAt))!
    }
  }

  return selectWithAgent(db, where, { newestFirst: true, limit })
}

/**
 * The boolean is "no such room" vs "the room now has no messages" — hence the
 * existence check rather than the delete's row count. **No cache invalidation,
 * deliberately:** the caller must sweep, since agent sessions and the client
 * pool have to go down in the same breath.
 */
export function deleteRoomMessages(db: Db, roomId: number): boolean {
  const room = db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).get()
  if (!room) return false

  db.delete(messages).where(eq(messages.roomId, roomId)).run()
  return true
}
