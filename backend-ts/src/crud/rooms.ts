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
 * Add an existing agent to a room. Idempotent.
 *
 * Returns the room when both room and agent exist — *including* when the agent
 * was already a member — and null otherwise. That is Python's return contract,
 * and `addGameplayAgentsToRoom` counts on it, so the "already present" case
 * must not become a null.
 *
 * Unlike Python this returns the bare room row, without the eager-loaded
 * agents/messages/world; no caller in the Phase 0 slice reads them off the
 * return value, and materializing them on every membership write is wasteful.
 */
export function addAgentToRoom(db: Db, roomId: number, agentId: number): Room | null {
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get()
  if (!room) return null

  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return null

  const existing = db
    .select({ roomId: roomAgents.roomId })
    .from(roomAgents)
    .where(and(eq(roomAgents.roomId, roomId), eq(roomAgents.agentId, agentId)))
    .get()

  if (existing) return room

  // Whether the room already has traffic decides if this is an introduction the
  // other participants should see. Read it before the insert — after, the join
  // notice itself would count.
  const hasMessages = Boolean(
    db.select({ id: messages.id }).from(messages).where(eq(messages.roomId, roomId)).limit(1).get(),
  )

  db.insert(roomAgents).values({ roomId, agentId, joinedAt: new Date() }).run()

  if (hasMessages) {
    createSystemMessage(db, roomId, `${agent.name} joined the chat`)
  }

  return room
}
