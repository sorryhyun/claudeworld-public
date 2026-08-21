/**
 * CRUD operations for Message entities — port of `backend/crud/messages.py`.
 *
 * Synchronous throughout; see `src/crud/agents.ts` for why the Python locking
 * decorators have no counterpart here.
 */

import { and, asc, desc, eq, gt, gte, isNull, type SQL } from 'drizzle-orm'
import type { Db } from '../db'
import { agents, messages, roomAgents, rooms, type Message, type MessageRole } from '../db/schema'
import { getCache, roomMessagesKey } from '../infrastructure/cache'

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

    return inserted
  })

  // `messages.py:79-83`: every message-derived cache entry for the room is
  // dropped inline, after the commit. Missing this is directly user-visible —
  // the poll loop runs every 2s against a 5s message cache, so a player would
  // watch a turn's replies simply not arrive for two or three polls.
  //
  // Only the message pattern is swept, not `invalidateRoomCache`: Python drops
  // exactly this one key family here, and the `last_activity_at` bump above is
  // deliberately left to expire with the 30s room entry rather than being
  // invalidated on every single message.
  getCache().invalidatePattern(roomMessagesKey(roomId))

  return row
}

/**
 * Create a system message ("X joined the chat" and friends).
 *
 * Note the inverted default: system messages do *not* touch the room's activity
 * timestamp, because they are bookkeeping rather than conversation and should
 * not reorder a room list.
 *
 * Python invalidates the message cache separately here (`messages.py:126-129`)
 * because its `create_system_message` builds the row itself; delegating means
 * the sweep in {@link createMessage} already covers this path.
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
 * The shape every reader in `messages.py` shares: the room's messages with
 * `Message.agent` resolved, ordered by time.
 *
 * Two things are folded in here rather than repeated six times.
 *
 * **The `id` tiebreaker.** Python orders on `timestamp` alone, which is safe
 * *there* because `datetime.now()` has microsecond resolution and two rows
 * written in the same turn essentially never collide. `Date` resolves to
 * milliseconds and `sqlaDateTime` pads the microseconds with zeroes, so a burst
 * of messages — an NPC round, a narration split across tool calls — routinely
 * lands on byte-identical timestamps. SQLite may then return those in any
 * order, and for the polling readers that means a player watching a scene
 * assemble out of sequence. Ids are assigned in insert order, so adding them as
 * a secondary key recovers exactly the ordering Python's finer clock gave.
 *
 * **The newest-N-then-reverse dance.** Four of the five readers want the
 * *latest* `limit` rows in chronological order, which requires sorting
 * descending, limiting, and reversing in memory. Sorting ascending with a LIMIT
 * would quietly return the oldest N instead — the opposite window.
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
 * Every message in a room, oldest first — `messages.py:134`.
 *
 * Deliberately unbounded, as in Python: the callers are full-history consumers
 * (transcript export, history compression) rather than the polling path, which
 * uses {@link getMessagesSince}.
 */
export function getMessages(db: Db, roomId: number): MessageWithAgent[] {
  return selectWithAgent(db, eq(messages.roomId, roomId), { newestFirst: false })
}

/**
 * Messages newer than a given id — `messages.py:145`, the polling read.
 *
 * `limit` is clamped to 1000 rather than validated: a client asking for more is
 * silently given 1000, which is what Python's `min(limit, 1000)` does. The
 * clamp exists because this endpoint is hit every 2 seconds per open room, so
 * an unbounded page is a memory hazard rather than a correctness one.
 *
 * Note this one sorts *ascending* before limiting, unlike its neighbours: with
 * `sinceId` advancing on every poll the interesting window is the oldest
 * unseen messages, not the newest ones, or a client that fell behind would skip
 * whatever it missed and never come back for it.
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

/** The newest `limit` messages in a room, returned oldest first — `messages.py:175`. */
export function getRecentMessages(db: Db, roomId: number, limit = 200): MessageWithAgent[] {
  return selectWithAgent(db, eq(messages.roomId, roomId), { newestFirst: true, limit })
}

/**
 * One chat session's messages — `messages.py:262`.
 *
 * Chat mode and gameplay share a room and a table; `chat_session_id` is the
 * entire separation mechanism. Every message written while the player is in
 * chat mode carries the session id, gameplay messages carry NULL, and this
 * filter plus {@link getMessagesExcludingChat} partition the room between them.
 * Widening either filter leaks one mode's transcript into the other's prompt,
 * which reads to the player as an NPC suddenly knowing things it was never
 * told.
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

/**
 * The gameplay half of the same partition — `messages.py:293`.
 *
 * `IS NULL`, not `= NULL`: Drizzle's `eq(col, null)` would render `= NULL`,
 * which matches nothing in SQLite, so every gameplay message would vanish from
 * the Action Manager's context. Python spells it `.is_(None)` for the same
 * reason.
 */
export function getMessagesExcludingChat(db: Db, roomId: number, limit = 200): MessageWithAgent[] {
  const where = and(eq(messages.roomId, roomId), isNull(messages.chatSessionId))!
  return selectWithAgent(db, where, { newestFirst: true, limit })
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

  // Newest-first-then-reverse and the `id` tiebreaker both live in
  // {@link selectWithAgent}; see its doc comment for why each is load-bearing.
  return selectWithAgent(db, where, { newestFirst: true, limit })
}
