/**
 * CRUD operations for Room entities and room membership — port of
 * `backend/crud/rooms.py` plus the membership half of
 * `backend/crud/room_agents.py`.
 */

import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db'
import {
  agents,
  messages,
  roomAgents,
  rooms,
  worlds,
  type Agent,
  type Message,
  type Room,
  type World,
} from '../db/schema'
import { getCache, roomAgentsKey, roomObjectKey } from '../infrastructure/cache'
import { createSystemMessage } from './messages'

/**
 * A room with the three relationships `crud/helpers.py::get_room_with_relationships`
 * eager-loads. They are bundled here rather than fetched lazily because the
 * Python callers all touch at least two of them, and SQLAlchemy would raise on
 * a detached lazy load anyway.
 */
export interface RoomWithRelations extends Room {
  agents: Agent[]
  messages: Message[]
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
    // SQLAlchemy's `Room.messages` has no order_by, so it comes back in primary
    // key order; ordering by id here reproduces that rather than inventing one.
    messages: db
      .select()
      .from(messages)
      .where(eq(messages.roomId, roomId))
      .orderBy(asc(messages.id))
      .all(),
  }
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
