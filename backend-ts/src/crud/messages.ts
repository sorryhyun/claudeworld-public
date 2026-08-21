/**
 * CRUD operations for Message entities — port of `backend/crud/messages.py`.
 *
 * Synchronous throughout; see `src/crud/agents.ts` for why the Python locking
 * decorators have no counterpart here.
 */

import { and, desc, eq, gt, gte } from 'drizzle-orm'
import type { Db } from '../db'
import { agents, messages, roomAgents, rooms, type Message, type MessageRole } from '../db/schema'

/** Participant kinds the Python `ParticipantType` enum admits. */
export type ParticipantType = 'user' | 'character' | 'system' | 'agent'

/**
 * The in-game clock frozen onto a message.
 *
 * Written as a type alias rather than an interface on purpose: callers pass
 * their own `GameTime` interface here, and an interface only satisfies
 * `Record<string, number>` if it declares an index signature, which `GameTime`
 * does not.
 */
export type GameTimeSnapshot = { hour: number; minute: number; day: number }

/** One image attachment, stored inside the `images` JSON blob. */
export interface MessageImage {
  data: string
  mediaType: string
}

/** Mirror of `schemas.MessageCreate`. */
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
  /** Python's `update_room_activity`, default `True`. */
  updateRoomActivity?: boolean
}

/**
 * Serialize an optional JSON column the way Python does.
 *
 * The Python code guards each of these with a bare `if message.x:`, and in
 * Python an empty dict or list is falsy — so `[]` and `{}` are stored as NULL,
 * not as `"[]"`/`"{}"`. In JS both are truthy, so the emptiness test has to be
 * spelled out or rows written here would differ from Python-written rows.
 */
function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value) && value.length === 0) return null
  if (typeof value === 'object' && Object.keys(value as object).length === 0) return null
  return JSON.stringify(value)
}

/**
 * Create a message, optionally bumping the room's `last_activity_at`.
 *
 * Python performs both writes inside one commit so a poller can never observe a
 * message whose room still looks idle. A `bun:sqlite` transaction reproduces
 * that; without it the two statements auto-commit separately and the window
 * reopens.
 *
 * `id` is deliberately absent from the insert: the live DDL declares
 * `id INTEGER NOT NULL PRIMARY KEY`, which SQLite treats as a rowid alias and
 * fills in itself. The Drizzle column says `autoIncrement: false` only because
 * that flag controls emitting the `AUTOINCREMENT` keyword in generated DDL, not
 * whether the value is assigned.
 */
export function createMessage(
  db: Db,
  roomId: number,
  message: MessageCreate,
  { updateRoomActivity = true }: CreateMessageOptions = {},
): Message {
  return db.transaction((tx) => {
    const row = tx
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
        // Explicit rather than leaning on the column's CURRENT_TIMESTAMP
        // default: that default has second resolution and no microseconds, so
        // rows relying on it sort differently from the ones SQLAlchemy writes.
        timestamp: new Date(),
      })
      .returning()
      .get()

    if (updateRoomActivity) {
      // Python fetches the room first and skips the write when it is missing.
      // A bare UPDATE with a WHERE has the same effect and one fewer round trip.
      tx.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.id, roomId)).run()
    }

    return row
  })
}

/**
 * Create a system message ("X joined the chat" and friends).
 *
 * Note the inverted default: system messages do *not* touch the room's activity
 * timestamp, because they are bookkeeping rather than conversation and should
 * not reorder a room list.
 */
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

/** The id of the given agent's most recent message in a room, if any. */
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

/** When the agent was added to the room, or null for pre-`joined_at` rows. */
function getAgentJoinedAt(db: Db, roomId: number, agentId: number): Date | null {
  const row = db
    .select({ joinedAt: roomAgents.joinedAt })
    .from(roomAgents)
    .where(and(eq(roomAgents.roomId, roomId), eq(roomAgents.agentId, agentId)))
    .get()
  return row?.joinedAt ?? null
}

export interface MessageWithAgent extends Message {
  /** Python eager-loads `Message.agent`; prompt building reads the name off it. */
  agent: typeof agents.$inferSelect | null
}

/**
 * Messages posted since the agent last spoke — the agent's "what did I miss".
 *
 * Three cases, in Python's order of preference:
 *   1. the agent has spoken here → everything with a higher id;
 *   2. it has not, but has a `joined_at` → everything from the invite onwards,
 *      so a mid-conversation arrival does not inherit the whole backlog;
 *   3. neither (rows predating the `joined_at` column) → the recent window,
 *      unfiltered.
 *
 * Case 1 filters on id while case 2 filters on timestamp. That asymmetry is
 * deliberate in the original: ids are monotonic and unambiguous, but the invite
 * has no id to compare against, only a wall-clock instant.
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

  // Newest-first with a LIMIT keeps the *latest* N, then the result is reversed
  // so callers get chronological order. Ordering ascending and limiting would
  // silently hand back the oldest N instead.
  //
  // The `id` tiebreaker is an addition to Python's single-column sort, and it
  // is needed rather than cosmetic: JS clocks resolve to milliseconds where
  // Python's resolve to microseconds, so a burst of messages written in one
  // turn routinely lands on an identical timestamp. Without the tiebreaker
  // SQLite is free to return those in any order and the agent reads its context
  // scrambled. Ids are assigned in insert order, so this recovers exactly the
  // sequence the microsecond clock would have given.
  const rows = db
    .select({ message: messages, agent: agents })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .where(where)
    .orderBy(desc(messages.timestamp), desc(messages.id))
    .limit(limit)
    .all()

  return rows.reverse().map((r) => ({ ...r.message, agent: r.agent }))
}
