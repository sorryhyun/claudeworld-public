// The row → response mapping is not validation, so it lives in `toMessage`.

import { z } from 'zod'
import type { MessageWithAgent } from '@/crud/messages'
import { MESSAGE_ROLES } from '@/db/schema'
import { PARTICIPANT_TYPES, type ParticipantType } from '@/domain/enums'
import { isoDatetime, optionalInt, optionalString, parseJsonColumn, pydanticInt, requiredTimestamp } from './common'

// Re-exported so a caller naming these schemas needs only this module.
export { PARTICIPANT_TYPES }
export type { ParticipantType }

/** One entry of the `messages.images` JSON blob. */
export const ImageItem = z.object({
  /** Base64, without a `data:` prefix. */
  data: z.string(),
  media_type: z.string(),
})

export type ImageItem = z.infer<typeof ImageItem>

/** The clock frozen onto a message when it was written. Deliberately open rather
 * than `GameTime`, though hour/minute/day are the only keys anything writes. */
export const GameTimeSnapshot = z.record(z.string(), pydanticInt())

export type GameTimeSnapshot = z.infer<typeof GameTimeSnapshot>

export const MessageBase = z.object({
  content: z.string(),
  role: z.enum(MESSAGE_ROLES),
  participant_type: z.enum(PARTICIPANT_TYPES).nullable().default(null),
  /** The display name for `participant_type: 'character'`. */
  participant_name: optionalString(),
  images: ImageItem.array().nullable().default(null),
  /** Deprecated, and folded into `images` by {@link toMessage} — but
   * `frontend/src/types.ts` still reads them directly, so they stay. */
  image_data: optionalString(),
  image_media_type: optionalString(),
})

export type MessageBase = z.infer<typeof MessageBase>

export const MessageCreate = MessageBase.extend({
  agent_id: optionalInt(),
  thinking: optionalString(),
  anthropic_calls: z.string().array().nullable().default(null),
  /** Agent ids parsed out of `@mentions`; consumed by the orchestrator, not stored. */
  mentioned_agent_ids: pydanticInt().array().nullable().default(null),
  chat_session_id: optionalInt(),
  game_time_snapshot: GameTimeSnapshot.nullable().default(null),
})

export type MessageCreate = z.infer<typeof MessageCreate>

/** The message response. `images` serializes fifth, between `participant_name`
 * and `image_data`, not last — the field order below is the wire order. */
export const Message = MessageBase.extend({
  id: pydanticInt(),
  room_id: pydanticInt(),
  agent_id: optionalInt(),
  thinking: optionalString(),
  anthropic_calls: z.string().array().nullable().default(null),
  timestamp: isoDatetime(),
  agent_name: optionalString(),
  agent_profile_pic: optionalString(),
  chat_session_id: optionalInt(),
  game_time_snapshot: GameTimeSnapshot.nullable().default(null),
})

export type Message = z.infer<typeof Message>

/** A row with no `images` blob but both deprecated image columns gets a
 * one-element array synthesized from them, which lets the frontend treat `images`
 * as the only image field. The back-fill needs *both* — an attachment with no
 * media type is not renderable. */
export function toMessage(row: MessageWithAgent): Message {
  const images = parseJsonColumn(row.images, ImageItem.array())
  const backfilled =
    images === null && row.imageData && row.imageMediaType
      ? [{ data: row.imageData, media_type: row.imageMediaType }]
      : images

  return {
    content: row.content,
    role: row.role,
    participant_type: asParticipantType(row.participantType),
    participant_name: row.participantName,
    images: backfilled,
    image_data: row.imageData,
    image_media_type: row.imageMediaType,
    id: row.id,
    room_id: row.roomId,
    agent_id: row.agentId,
    thinking: row.thinking,
    anthropic_calls: parseJsonColumn(row.anthropicCalls, z.string().array()),
    timestamp: requiredTimestamp(row.timestamp, 'Message', 'timestamp'),
    agent_name: row.agent?.name ?? null,
    agent_profile_pic: row.agent?.profilePic ?? null,
    chat_session_id: row.chatSessionId,
    game_time_snapshot: parseJsonColumn(row.gameTimeSnapshot, GameTimeSnapshot),
  }
}

// `participant_type` is untyped TEXT but a constrained enum in the schema. An
// out-of-range value becomes `null` rather than throwing: one unclassifiable row
// should not take down the room's whole message list.
function asParticipantType(value: string | null): ParticipantType | null {
  return (PARTICIPANT_TYPES as readonly string[]).includes(value ?? '')
    ? (value as ParticipantType)
    : null
}

/** Unused: `GET /api/game/{world_id}/poll` builds its own response with a
 * *different* message shape, and that contract belongs with the poll route. */
export const PollResponse = z.object({
  messages: Message.array().default([]),
  state: z.record(z.string(), z.unknown()).nullable().default(null),
  location: z.record(z.string(), z.unknown()).nullable().default(null),
})

export type PollResponse = z.infer<typeof PollResponse>
