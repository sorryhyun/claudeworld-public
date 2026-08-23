// CRUD for Room entities and room membership. Synchronous throughout.

import { and, asc, desc, eq } from 'drizzle-orm'
import type { Db } from '@/db'
import {
  agents,
  messages,
  roomAgents,
  rooms,
  worlds,
  type Agent,
  type Room,
  type World,
} from '@/db/schema'
import type { UserRole } from '@/auth/roles'
import { getCache, roomAgentsKey, roomObjectKey } from '@/infrastructure/cache'
import { getLogger } from '@/infrastructure/logging/logger'
import { invalidateRoomCache } from './cache-invalidation'
import { createSystemMessage, type MessageWithAgent } from './messages'

const logger = getLogger('CRUD')

/** Each message carries its agent because the room response fills
 * `agent_name`/`agent_profile_pic` off it. */
export interface RoomWithRelations extends Room {
  agents: Agent[]
  messages: MessageWithAgent[]
  world: World | null
}

export interface RoomCreate {
  name: string
  /** Agent-interaction cap; `null`/absent means unlimited. */
  maxInteractions?: number | null
}

/** `ownerId` scopes the unique index `ux_rooms_owner_name_world`. The timestamps
 * are written explicitly because the columns have no SQL `DEFAULT` — omitting them
 * stores NULL and sorts the room last in every `last_activity_at` listing. */
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

// Ordered by id, unlike `crud/messages.ts`, which sorts on `timestamp`.
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

/** Omits `agents` and `messages`, which would mean loading a transcript per room
 * only to throw it away. */
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

export interface RoomListIdentity {
  role: UserRole
  /** Stable per-session id; `admin` for the admin, `guest-<hex>` for guests. */
  userId: string
}

/** Guests see only rooms they own; an admin — and an absent identity — see all,
 * so omitting the identity is the *unscoped* read. SQLite sorts NULL smallest, so
 * a room that has never seen a message sorts last. `isPaused`/`isFinished` are
 * coerced because a row predating the server defaults reads NULL. */
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

export function getAgentsInRoom(db: Db, roomId: number): Agent[] {
  return db
    .select({ agent: agents })
    .from(agents)
    .innerJoin(roomAgents, eq(agents.id, roomAgents.agentId))
    .where(eq(roomAgents.roomId, roomId))
    .all()
    .map((r) => r.agent)
}

export interface RoomUpdate {
  maxInteractions?: number | null
  isPaused?: boolean | null
  isFinished?: boolean | null
}

/** `null` for an unknown room. `null`/`undefined` fields mean "leave alone", so
 * there is no way to clear `maxInteractions` back to unlimited here; a negative
 * one throws uncaught, reaching the generic 500 envelope. */
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

  // Drizzle rejects an empty SET clause; an all-absent patch skips it.
  if (Object.keys(patch).length > 0) {
    db.update(rooms).set(patch).where(eq(rooms.id, roomId)).run()
  }

  // The scheduler polls `is_paused` off the 30s-cached room object; without this
  // a pause takes effect up to half a minute late.
  getCache().invalidate(roomObjectKey(roomId))

  return getRoom(db, roomId)
}

/** `locations.room_id` and `worlds.onboarding_room_id` are `ON DELETE SET NULL`
 * (everything else cascades), so a location outlives its room — which
 * `createNewRoomForLocation` repairs. The cache sweep is required: SQLite reuses
 * rowids, so a cached `room_obj:{id}` outliving its row can be served to a
 * *different* room that inherits the id. */
export function deleteRoom(db: Db, roomId: number): boolean {
  const deleted = db.delete(rooms).where(eq(rooms.id, roomId)).returning({ id: rooms.id }).get()
  if (!deleted) return false

  invalidateRoomCache(roomId)
  return true
}

/** Identified by naming convention (`Direct: {name}`) scoped to the owner, not by
 * a column, so renaming an agent orphans its direct room. The unique index
 * includes **world_id**, so an owner can hold one inside a world and one outside;
 * the first match wins. Unlike {@link addAgentToRoom} this writes no join notice
 * and leaves `joinedAt` NULL, which `getMessagesAfterAgentResponse` reads as
 * *show the whole recent window*. */
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
    // One connection, so `db` statements here are already in the transaction.
    const created = createRoom(db, { name: roomName }, ownerId)
    db.insert(roomAgents).values({ roomId: created.id, agentId }).run()
    return created.id
  })

  logger.info(`Created direct room '${roomName}' for owner '${ownerId}'`)
  return getRoom(db, roomId)
}

/** Stops the background scheduler driving the room. */
export function markRoomAsFinished(db: Db, roomId: number): Room | null {
  const updated = db
    .update(rooms)
    .set({ isFinished: true })
    .where(eq(rooms.id, roomId))
    .returning()
    .get()

  if (!updated) return null

  // Same 30s cache: `is_finished` is what stops the scheduler.
  getCache().invalidate(roomObjectKey(roomId))

  return updated
}

/** Idempotent: returns the room whenever both exist, *including* when the agent
 * was already a member — `addGameplayAgentsToRoom` counts on that. */
export function addAgentToRoom(db: Db, roomId: number, agentId: number): RoomWithRelations | null {
  const room = getRoom(db, roomId)
  if (!room) return null

  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return null

  // Pre-insert snapshot — a later read would count the join notice itself.
  const hasMessages = room.messages.length > 0

  if (room.agents.some((member) => member.id === agentId)) return room

  db.insert(roomAgents).values({ roomId, agentId, joinedAt: new Date() }).run()

  if (hasMessages) {
    createSystemMessage(db, roomId, `${agent.name} joined the chat`)
  }

  // `getAgentsCached` holds membership for 60s: without this drop the new agent
  // would miss its first turn.
  getCache().invalidate(roomAgentsKey(roomId))

  return getRoom(db, roomId)
}

/** False means "nothing was removed"; a missing room and a non-member are not
 * distinguished. */
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

  getCache().invalidate(roomAgentsKey(roomId))

  return true
}
