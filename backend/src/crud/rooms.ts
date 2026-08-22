/**
 * CRUD operations for Room entities and room membership — port of
 * `backend/crud/rooms.py`, the membership half of `backend/crud/room_agents.py`,
 * and all of `backend/crud/helpers.py`.
 *
 * `helpers.py` gets no file of its own here. It contains exactly one function,
 * `get_room_with_relationships`, and `crud/rooms.py::get_room` is a one-line
 * delegation to it — so {@link getRoom} *is* that helper, and giving the same
 * query two exported names would only invite the two to drift.
 *
 * Synchronous throughout; see `src/crud/agents.ts` for why the Python locking
 * decorators have no counterpart here.
 */

import { and, asc, desc, eq } from 'drizzle-orm'
import type { Db } from '../db'
import {
  agents,
  messages,
  roomAgents,
  rooms,
  worlds,
  type Agent,
  type Room,
  type World,
} from '../db/schema'
import type { UserRole } from '../auth/roles'
import { getCache, roomAgentsKey, roomObjectKey } from '../infrastructure/cache'
import { getLogger } from '../infrastructure/logging/logger'
import { invalidateRoomCache } from './cached'
import { createSystemMessage, type MessageWithAgent } from './messages'

const logger = getLogger('CRUD')

/**
 * A room with the three relationships `crud/helpers.py::get_room_with_relationships`
 * eager-loads. They are bundled here rather than fetched lazily because the
 * Python callers all touch at least two of them, and SQLAlchemy would raise on
 * a detached lazy load anyway.
 *
 * `messages` carries each message's agent because `helpers.py:28` chains
 * `selectinload(Room.messages).selectinload(Message.agent)`. That second hop is
 * not decoration: `schemas.Message` fills `agent_name` and `agent_profile_pic`
 * off it, so a room response built from messages without their agent renders
 * every line as coming from nobody.
 */
export interface RoomWithRelations extends Room {
  agents: Agent[]
  messages: MessageWithAgent[]
  world: World | null
}

/** Mirror of `schemas.RoomCreate` (`schemas/rooms.py:18`). */
export interface RoomCreate {
  name: string
  /** Agent-interaction cap; `null`/absent means unlimited. */
  maxInteractions?: number | null
}

/**
 * Create a room scoped to an owner, optionally linked to a world.
 *
 * Port of `crud/rooms.py:21`. `owner_id` is what scopes the unique index
 * `ux_rooms_owner_name_world`, so two worlds owned by different users can both
 * hold a "Location: Village" room; a collision inside one owner+world surfaces
 * here as a SQLite constraint error, exactly as it does in Python.
 *
 * `created_at` and `last_activity_at` are written explicitly. SQLAlchemy fills
 * both from `default=lambda: datetime.now(timezone.utc)` (`models.py:33-36`),
 * which is an ORM-side default that emits no DDL — the columns have no
 * `DEFAULT` clause in a real database, so omitting them here would store NULL
 * and every room list ordered by `last_activity_at` would sort this room last.
 *
 * Returns the eager-loaded shape rather than the bare row because Python
 * refreshes `agents`/`messages` before returning (`rooms.py:37`) and the room
 * response schema serializes them. Both are empty by construction, so only the
 * world is actually queried, and only when the room belongs to one.
 */
export function createRoom(
  db: Db,
  room: RoomCreate,
  ownerId: string | null,
  worldId: number | null = null,
): RoomWithRelations {
  const now = new Date()
  const created = db
    .insert(rooms)
    .values({
      name: room.name,
      maxInteractions: room.maxInteractions ?? null,
      ownerId,
      worldId,
      createdAt: now,
      lastActivityAt: now,
    })
    .returning()
    .get()

  return {
    ...created,
    agents: [],
    messages: [],
    world:
      worldId === null ? null : (db.select().from(worlds).where(eq(worlds.id, worldId)).get() ?? null),
  }
}

/** Get a room with its agents, messages and world. */
export function getRoom(db: Db, roomId: number): RoomWithRelations | null {
  const row = db
    .select({ room: rooms, world: worlds })
    .from(rooms)
    .leftJoin(worlds, eq(rooms.worldId, worlds.id))
    .where(eq(rooms.id, roomId))
    .get()

  if (!row) return null

  return {
    ...row.room,
    world: row.world,
    agents: getAgentsInRoom(db, roomId),
    messages: getRoomMessagesWithAgent(db, roomId),
  }
}

/**
 * `Room.messages` with each message's `agent` resolved.
 *
 * SQLAlchemy's `Room.messages` relationship declares no `order_by`, so it comes
 * back in primary key order; ordering by id here reproduces that rather than
 * inventing one. Note this is *not* the same ordering as the readers in
 * `crud/messages.ts`, which sort on `timestamp` — for rows written by these
 * backends the two agree, since ids are assigned in insert order.
 */
function getRoomMessagesWithAgent(db: Db, roomId: number): MessageWithAgent[] {
  return db
    .select({ message: messages, agent: agents })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .where(eq(messages.roomId, roomId))
    .orderBy(asc(messages.id))
    .all()
    .map((r) => ({ ...r.message, agent: r.agent }))
}

/**
 * The subset of a room `schemas.RoomSummary` exposes — the room list payload.
 *
 * Building this in the CRUD layer is a layering smell inherited verbatim from
 * `rooms.py:57`, where `get_rooms` returns Pydantic models rather than ORM rows
 * while every other reader in the module returns rows. It is kept because the
 * shape *is* the contract: the room list deliberately omits `agents` and
 * `messages`, and folding it into a response model later would mean this
 * function loading a transcript per room only to throw it away.
 */
export interface RoomSummary {
  id: number
  name: string
  ownerId: string | null
  maxInteractions: number | null
  isPaused: boolean
  isFinished: boolean
  createdAt: Date | null
  lastActivityAt: Date | null
}

/**
 * Who is asking, for the guest scoping in {@link getRooms}.
 *
 * Mirror of `core/dependencies.py::RequestIdentity`. `userId` is non-nullable
 * there — `get_request_identity` falls back to the role string when the request
 * state carries none — so the `IS NULL` branch Python's `getattr(..., None)`
 * defends against is unreachable and is not reproduced.
 */
export interface RoomListIdentity {
  role: UserRole
  /** Stable per-session id; `admin` for the admin, `guest-<hex>` for guests. */
  userId: string
}

/**
 * Every room the caller may see, most recently active first — `rooms.py:41`.
 *
 * Guests see only rooms they own; an admin, and an absent identity, see all of
 * them. Passing no identity is therefore the *unscoped* read and is what the
 * Python default (`identity=None`) does — the HTTP layer always supplies one,
 * so the bare call is for internal callers and tests.
 *
 * `NULLS` are left to the engine here, unlike `getWorldsByOwner`. SQLite sorts
 * NULL smallest, so under `DESC` a room that has never seen a message sorts
 * last — which is what Python gets too, since it asks for a plain `.desc()`.
 *
 * `is_paused` / `is_finished` are coerced rather than passed through:
 * `RoomSummary` declares them `bool` with a default of `False`, and the columns
 * are nullable, so a row written before the server defaults existed reads as
 * NULL and must surface as `false` rather than as `null`.
 */
export function getRooms(db: Db, identity?: RoomListIdentity | null): RoomSummary[] {
  const listed =
    identity != null && identity.role !== 'admin'
      ? db
          .select()
          .from(rooms)
          .where(eq(rooms.ownerId, identity.userId))
          .orderBy(desc(rooms.lastActivityAt))
          .all()
      : db.select().from(rooms).orderBy(desc(rooms.lastActivityAt)).all()

  return listed.map((room) => ({
    id: room.id,
    name: room.name,
    ownerId: room.ownerId,
    maxInteractions: room.maxInteractions,
    isPaused: Boolean(room.isPaused),
    isFinished: Boolean(room.isFinished),
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
  }))
}

/**
 * Get all agents in a room.
 *
 * Joined through `room_agents` rather than read off a relationship, matching
 * the comment in Python: the ORM path could hand back stale objects out of the
 * identity map, and the join always reflects the table.
 */
export function getAgentsInRoom(db: Db, roomId: number): Agent[] {
  return db
    .select({ agent: agents })
    .from(agents)
    .innerJoin(roomAgents, eq(agents.id, roomAgents.agentId))
    .where(eq(roomAgents.roomId, roomId))
    .all()
    .map((r) => r.agent)
}

/** Mirror of `schemas.RoomUpdate` (`schemas/rooms.py:22`). */
export interface RoomUpdate {
  maxInteractions?: number | null
  isPaused?: boolean | null
  isFinished?: boolean | null
}

/**
 * Patch a room's configuration — `rooms.py:78`. `null` for an unknown room.
 *
 * `null`/`undefined` means "leave alone" for every field, matching Python's
 * `if x is not None`. There is therefore no way to clear `max_interactions`
 * back to NULL (unlimited) through this function; Python has the same hole.
 *
 * A negative `maxInteractions` throws rather than being clamped or ignored.
 * Nothing catches Python's `ValueError` on the way out — the PATCH handler lets
 * it reach the generic 500 envelope — so the message is kept verbatim to keep
 * the two backends' error bodies identical.
 *
 * Returns the eager-loaded shape because Python refreshes `agents`/`messages`
 * before returning and the router serializes the result as a full `Room`.
 */
export function updateRoom(db: Db, roomId: number, update: RoomUpdate): RoomWithRelations | null {
  const room = getRoom(db, roomId)
  if (!room) return null

  const patch: Partial<typeof rooms.$inferInsert> = {}

  if (update.maxInteractions != null) {
    if (update.maxInteractions < 0) throw new RangeError('max_interactions must be non-negative')
    patch.maxInteractions = update.maxInteractions
  }
  if (update.isPaused != null) patch.isPaused = update.isPaused
  if (update.isFinished != null) patch.isFinished = update.isFinished

  // Drizzle rejects an empty SET clause where SQLAlchemy would commit nothing;
  // Python still returns the (unchanged) room, so skipping the statement is the
  // faithful branch rather than an optimisation.
  if (Object.keys(patch).length > 0) {
    db.update(rooms).set(patch).where(eq(rooms.id, roomId)).run()
  }

  // `rooms.py:100-104`. `is_paused` is exactly what the scheduler polls off the
  // 30-second cached room object, so without this a pause takes effect up to
  // half a minute after the player asked for it.
  getCache().invalidate(roomObjectKey(roomId))

  return getRoom(db, roomId)
}

/**
 * Delete a room permanently. False when it did not exist.
 *
 * Everything hanging off the room goes with it through `ON DELETE CASCADE`:
 * `messages`, `room_agents` and `room_agent_sessions`. `locations.room_id` and
 * `worlds.onboarding_room_id` are `ON DELETE SET NULL` instead, so a location
 * whose room is deleted survives without one — which is what
 * `createNewRoomForLocation` exists to repair.
 *
 * The cache sweep is not in Python and is a deliberate one-directional
 * divergence, the same one `crud/worlds.ts::deleteWorld` makes and for the same
 * reason:
 * SQLite reuses rowids, so a cached `room_obj:{id}` outliving its row can be
 * served to a *different* room that later inherits the id, handing the
 * scheduler someone else's `is_paused` / `is_finished`. Dropping cache entries
 * is always safe, so the divergence cannot cost correctness in the other
 * direction.
 */
export function deleteRoom(db: Db, roomId: number): boolean {
  const deleted = db.delete(rooms).where(eq(rooms.id, roomId)).returning({ id: rooms.id }).get()
  if (!deleted) return false

  invalidateRoomCache(roomId)
  return true
}

/**
 * Get, or create, the 1-on-1 room the caller shares with an agent —
 * `rooms.py:149`. `null` when the agent does not exist.
 *
 * The room is identified by naming convention (`Direct: {agent name}`) scoped
 * to the owner, not by a column. That is fragile — renaming an agent orphans
 * its direct room and the next call silently starts a fresh one — but it is the
 * live convention and rooms in existing databases are named this way.
 *
 * Two things here differ from {@link addAgentToRoom}, both faithful to Python:
 *
 * - **No join notice.** Python appends to `Room.agents` directly rather than
 *   calling `add_agent_to_room`, so no "X joined the chat" message is written.
 *   The room is empty at that point anyway, so the notice would be suppressed
 *   regardless — but the difference matters if this ever adopts a room that
 *   already has traffic.
 * - **`joined_at` is left NULL.** A SQLAlchemy secondary-relationship append
 *   writes only the two foreign keys. `getMessagesAfterAgentResponse` reads
 *   `joined_at` as the fallback "what did I miss" boundary, and NULL there means
 *   *show the whole recent window* — which is the behaviour a direct room wants
 *   and is why this is reproduced rather than quietly filled in.
 *
 * **Divergence, unavoidable.** Python's `scalar_one_or_none()` raises
 * `MultipleResultsFound` if two rooms match, which is reachable: the unique
 * index is on (owner, name, **world_id**), so the same owner can hold a
 * `Direct: Elric` room inside a world *and* one outside it. Drizzle's `.get()`
 * takes the first row instead. Raising would be worse behaviour, not better, so
 * the first match wins.
 */
export function getOrCreateDirectRoom(
  db: Db,
  agentId: number,
  ownerId: string,
): RoomWithRelations | null {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return null

  const roomName = `Direct: ${agent.name}`

  const existing = db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.name, roomName), eq(rooms.ownerId, ownerId)))
    .get()

  if (existing) return getRoom(db, existing.id)

  const roomId = db.transaction(() => {
    // `createRoom` takes a `Db` rather than a transaction handle; `bun:sqlite`
    // has a single connection, so statements issued through `db` inside this
    // callback are already inside the transaction. See `crud/worlds.ts`.
    const created = createRoom(db, { name: roomName }, ownerId)
    db.insert(roomAgents).values({ roomId: created.id, agentId }).run()
    return created.id
  })

  logger.info(`Created direct room '${roomName}' for owner '${ownerId}'`)
  return getRoom(db, roomId)
}

/**
 * Mark a room finished, so the background scheduler stops driving it.
 *
 * Port of `crud/rooms.py:110`. Returns the bare row, not the eager-loaded
 * shape: Python's `db.refresh(room)` here (unlike `update_room`'s
 * `refresh(..., attribute_names=["agents", "messages"])`) reloads only the
 * columns, and the callers read `is_finished` and nothing else.
 */
export function markRoomAsFinished(db: Db, roomId: number): Room | null {
  const updated = db
    .update(rooms)
    .set({ isFinished: true })
    .where(eq(rooms.id, roomId))
    .returning()
    .get()

  if (!updated) return null

  // `rooms.py:126-129`. The room object is cached for 30s and `is_finished` is
  // what the scheduler polls, so without this the conversation keeps going for
  // up to half a minute after it ended.
  getCache().invalidate(roomObjectKey(roomId))

  return updated
}

/**
 * Add an existing agent to a room. Idempotent.
 *
 * Returns the room when both room and agent exist — *including* when the agent
 * was already a member — and null otherwise. That is Python's return contract
 * (`room_agents.py:28`), and `addGameplayAgentsToRoom` counts on it, so the
 * "already present" case must not become a null.
 *
 * The return is the eager-loaded shape because Python's is: it opens with
 * `get_room_with_relationships` and refreshes `agents`/`messages` after the
 * insert, and the room-agents router serializes the result straight into a
 * `Room` response. Loading the transcript on a membership write is not cheap
 * for a busy location room, but it is exactly what Python pays and the shape is
 * part of the contract.
 */
export function addAgentToRoom(db: Db, roomId: number, agentId: number): RoomWithRelations | null {
  const room = getRoom(db, roomId)
  if (!room) return null

  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return null

  // Whether the room already has traffic decides if this is an introduction the
  // other participants should see. Read off the pre-insert snapshot — a later
  // read would count the join notice itself.
  const hasMessages = room.messages.length > 0

  if (room.agents.some((member) => member.id === agentId)) return room

  db.insert(roomAgents).values({ roomId, agentId, joinedAt: new Date() }).run()

  if (hasMessages) {
    createSystemMessage(db, roomId, `${agent.name} joined the chat`)
  }

  // `room_agents.py:59-62`. `getAgentsCached` holds the membership list for 60
  // seconds; without this drop, the agent that just joined is invisible to the
  // orchestrator for a full minute — long enough to miss its first turn.
  getCache().invalidate(roomAgentsKey(roomId))

  // Re-read rather than patching the snapshot: the membership row and the join
  // notice both changed, and Python's post-insert refresh returns the same.
  return getRoom(db, roomId)
}

/**
 * Remove an agent from a room. The agent itself is untouched.
 *
 * Port of `room_agents.py:69`. False means "nothing was removed", covering both
 * a missing room and an agent that was never a member — Python cannot tell
 * those apart either, since both fall through to the trailing `return False`.
 */
export function removeAgentFromRoom(db: Db, roomId: number, agentId: number): boolean {
  const room = db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).get()
  if (!room) return false

  const membership = db
    .select({ agentId: roomAgents.agentId })
    .from(roomAgents)
    .where(and(eq(roomAgents.roomId, roomId), eq(roomAgents.agentId, agentId)))
    .get()

  if (!membership) return false

  db.delete(roomAgents)
    .where(and(eq(roomAgents.roomId, roomId), eq(roomAgents.agentId, agentId)))
    .run()

  // `room_agents.py:89-92`.
  getCache().invalidate(roomAgentsKey(roomId))

  return true
}
