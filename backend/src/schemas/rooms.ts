/** Room request/response schemas. */

import { z } from 'zod'
import type { RoomWithRelations } from '@/crud/rooms'
import type { Agent as AgentRow, Message as MessageRow, Room as RoomRow } from '@/db/schema'
import { WORLD_PHASES } from '@/db/schema'
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

/** `{"is_paused": null}` and `{}` are the same request. `name` is not updatable. */
export const RoomUpdate = z.object({
  max_interactions: optionalInt(),
  is_paused: optionalBool(),
  is_finished: optionalBool(),
})

export type RoomUpdate = z.infer<typeof RoomUpdate>

/** The fields `Room` and `RoomSummary` share, in serialization order. */
const roomResponseFields = {
  id: pydanticInt(),
  owner_id: optionalString(),
  max_interactions: optionalInt(),
  is_paused: pydanticBool().default(false),
  is_finished: pydanticBool().default(false),
  created_at: isoDatetime(),
  last_activity_at: isoDatetime().nullable().default(null),
}

/** Cast and whole transcript inlined; `messages` is unbounded by contract. */
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
 * `getRoom` does not join `agents`, so {@link toRoom} falls back to the room's
 * own cast — resolving every case except an author who has left the room.
 */
export type RoomMessageRow = MessageRow & { agent?: AgentRow | null }

export interface RoomResponseSource extends Omit<RoomWithRelations, 'messages'> {
  messages: RoomMessageRow[]
}

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
    // Read through the world relationship rather than stored on the room.
    world_phase: row.world?.phase ?? null,
  }
}

/** A `Pick` so `getRooms`' projection can go straight to {@link toRoomSummary}. */
export type RoomResponseFieldsSource = Pick<
  RoomRow,
  | 'id'
  | 'name'
  | 'ownerId'
  | 'maxInteractions'
  | 'isPaused'
  | 'isFinished'
  | 'createdAt'
  | 'lastActivityAt'
>

export function toRoomSummary(row: RoomResponseFieldsSource): RoomSummary {
  return { name: row.name, ...toRoomResponseFields(row) }
}

function toRoomResponseFields(row: RoomResponseFieldsSource) {
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
