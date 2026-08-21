/**
 * Room request/response schemas — port of `backend/schemas/rooms.py`.
 */

import { z } from 'zod'
import type { RoomWithRelations } from '../crud/rooms'
import type { Agent as AgentRow, Message as MessageRow, Room as RoomRow } from '../db/schema'
import { WORLD_PHASES } from '../db/schema'
import { Agent, toAgent } from './agents'
import {
  isoDatetime,
  optionalBool,
  optionalInt,
  optionalString,
  pydanticBool,
  pydanticInt,
  requiredTimestamp,
  serializeBool,
  serializeOptionalUtcDatetime,
} from './common'
import { Message, toMessage } from './messages'

export const RoomBase = z.object({
  name: z.string(),
})

export type RoomBase = z.infer<typeof RoomBase>

export const RoomCreate = RoomBase.extend({
  /** Agent-interaction cap; absent or null means unlimited. */
  max_interactions: optionalInt(),
})

export type RoomCreate = z.infer<typeof RoomCreate>

/**
 * A partial update.
 *
 * Every field is `Optional[...] = None`, and Python cannot tell "omitted" from
 * "explicitly null" without `exclude_unset`, which no caller uses — so
 * `{"is_paused": null}` and `{}` are the same request, and both leave the column
 * alone. Zod's `.nullable().default(null)` reproduces that collapse exactly.
 * Note `name` is *not* updatable here even though the frontend's `RoomUpdate`
 * type lists it; Pydantic drops the unknown key silently, as does Zod.
 */
export const RoomUpdate = z.object({
  max_interactions: optionalInt(),
  is_paused: optionalBool(),
  is_finished: optionalBool(),
})

export type RoomUpdate = z.infer<typeof RoomUpdate>

/** The fields `Room` and `RoomSummary` share, in Pydantic's declaration order. */
const roomResponseFields = {
  id: pydanticInt(),
  owner_id: optionalString(),
  max_interactions: optionalInt(),
  is_paused: pydanticBool().default(false),
  is_finished: pydanticBool().default(false),
  created_at: isoDatetime(),
  last_activity_at: isoDatetime().nullable().default(null),
}

/**
 * The full room, with its cast and its whole transcript inlined.
 *
 * `messages` is unbounded — `crud/helpers.py::get_room_with_relationships`
 * eager-loads every message in the room and the response carries all of them.
 * That is the existing contract, not an oversight to fix here.
 */
export const Room = RoomBase.extend({
  ...roomResponseFields,
  agents: Agent.array().default([]),
  messages: Message.array().default([]),
  /** Set for TRPG rooms; a plain chat room has neither. */
  world_id: optionalInt(),
  world_phase: z.enum(WORLD_PHASES).nullable().default(null),
})

export type Room = z.infer<typeof Room>

/** The listing shape: the same room without its agents, messages or world link. */
export const RoomSummary = RoomBase.extend(roomResponseFields)

export type RoomSummary = z.infer<typeof RoomSummary>

/**
 * A room message row that may or may not carry its joined author.
 *
 * Python eager-loads `Room.messages → Message.agent`, so `agent_name` and
 * `agent_profile_pic` are populated on every message in a room response.
 * `src/crud/rooms.ts::getRoom` does not join `agents` onto the messages yet, so
 * {@link toRoom} accepts either shape and falls back to looking the author up in
 * the room's own cast — which resolves every case except an author who has since
 * left the room.
 */
export type RoomMessageRow = MessageRow & { agent?: AgentRow | null }

/** What {@link toRoom} needs: a `RoomWithRelations` whose join is optional. */
export interface RoomResponseSource extends Omit<RoomWithRelations, 'messages'> {
  messages: RoomMessageRow[]
}

/** Drizzle row (with agents, messages and world) → `Room` response. */
export function toRoom(row: RoomResponseSource): Room {
  const agentsById = new Map(row.agents.map((agent) => [agent.id, agent]))

  return {
    name: row.name,
    ...toRoomResponseFields(row),
    agents: row.agents.map(toAgent),
    messages: row.messages.map((message) =>
      toMessage({
        ...message,
        agent: message.agent ?? (message.agentId === null ? null : (agentsById.get(message.agentId) ?? null)),
      }),
    ),
    world_id: row.worldId,
    // `models.py::Room.world_phase` is a property reading through the world
    // relationship, which is why this is on the room response at all.
    world_phase: row.world?.phase ?? null,
  }
}

/** Drizzle row → `RoomSummary` response. */
export function toRoomSummary(row: RoomRow): RoomSummary {
  return { name: row.name, ...toRoomResponseFields(row) }
}

function toRoomResponseFields(row: RoomRow) {
  return {
    id: row.id,
    owner_id: row.ownerId,
    max_interactions: row.maxInteractions,
    is_paused: serializeBool(row.isPaused),
    is_finished: serializeBool(row.isFinished),
    created_at: requiredTimestamp(row.createdAt, 'Room', 'created_at'),
    last_activity_at: serializeOptionalUtcDatetime(row.lastActivityAt),
  }
}
