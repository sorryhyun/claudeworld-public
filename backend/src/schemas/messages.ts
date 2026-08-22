/**
 * Message request/response schemas — port of `backend/schemas/messages.py`.
 *
 * The interesting half of this module is {@link toMessage}. `schemas.Message`
 * carries a `model_validator(mode="before")` that turns an ORM row into a dict:
 * it decodes three JSON TEXT columns, flattens the eager-loaded `Message.agent`
 * into two scalar fields, and back-fills the deprecated single-image columns
 * into the `images` array. None of that is expressible as a Zod schema, because
 * none of it is validation — it is the row → response mapping, and it lives in
 * the mapper.
 */

import { z } from 'zod'
import type { MessageWithAgent } from '../crud/messages'
import { MESSAGE_ROLES } from '../db/schema'
import { PARTICIPANT_TYPES, type ParticipantType } from '../domain/enums'
import { isoDatetime, optionalInt, optionalString, parseJsonColumn, pydanticInt, requiredTimestamp } from './common'

/**
 * Re-exported from `src/domain/enums.ts`, which is the canonical home for
 * `domain/value_objects/enums.py::ParticipantType`. Re-exported rather than
 * merely imported because the request and response schemas below both name it,
 * and a caller importing this module should not have to import two.
 */
export { PARTICIPANT_TYPES }
export type { ParticipantType }

/** One attachment, as stored inside the `messages.images` JSON blob. */
export const ImageItem = z.object({
  /** Base64, without a `data:` prefix. */
  data: z.string(),
  media_type: z.string(),
})

export type ImageItem = z.infer<typeof ImageItem>

/**
 * The in-game clock frozen onto a message at the moment it was written.
 *
 * Typed as `Dict[str, int]` in Python rather than as the `GameTime` model, so
 * the keys are not constrained to hour/minute/day even though those are the only
 * three anything writes. Kept open here for the same reason.
 */
export const GameTimeSnapshot = z.record(z.string(), pydanticInt())

export type GameTimeSnapshot = z.infer<typeof GameTimeSnapshot>

export const MessageBase = z.object({
  content: z.string(),
  role: z.enum(MESSAGE_ROLES),
  participant_type: z.enum(PARTICIPANT_TYPES).nullable().default(null),
  /** The display name for `participant_type: 'character'`. */
  participant_name: optionalString(),
  images: ImageItem.array().nullable().default(null),
  /**
   * Deprecated single-image fields. They are still columns, still populated on
   * old rows, and {@link toMessage} folds them into `images` — but the frontend
   * also still reads them directly (`frontend/src/types.ts`), so they stay on
   * the response rather than being dropped.
   */
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

/**
 * The message response.
 *
 * `images` is declared on `MessageBase` and re-declared on the subclass in
 * Python. Pydantic keeps a redeclared field in its *original* position, so it
 * serializes fifth, between `participant_name` and `image_data`, not last. The
 * order below is the order `Message.model_fields` reports.
 */
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

/**
 * Drizzle row (with `Message.agent` joined) → `Message` response.
 *
 * Port of `Message.populate_agent_fields`. Three JSON columns are decoded, and
 * a row that has no `images` blob but does have both deprecated image columns
 * gets a one-element array synthesized from them — that back-fill is why the
 * frontend can treat `images` as the only image field for messages written
 * after the migration while old rows keep rendering.
 *
 * The back-fill requires *both* legacy columns. `image_data` alone is dropped,
 * because an attachment with no media type is not renderable.
 */
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

/**
 * `participant_type` is an untyped TEXT column but a constrained enum in the
 * schema, so a value outside the four is a 500 in Python. Here it becomes
 * `null`, on the same reasoning as {@link parseJsonColumn}: one unclassifiable
 * row should not take down the room's whole message list.
 */
function asParticipantType(value: string | null): ParticipantType | null {
  return (PARTICIPANT_TYPES as readonly string[]).includes(value ?? '')
    ? (value as ParticipantType)
    : null
}

/**
 * Declared by `schemas/messages.py` and used by nothing.
 *
 * `GET /api/game/{world_id}/poll` builds its response as a bare dict in
 * `routers/game/polling.py`, with a *different* message shape (eleven fields,
 * and `timestamp` written by `datetime.isoformat()` — no `Z` suffix, unlike
 * every other timestamp in the API). Ported for completeness; the poll route's
 * real contract belongs with the poll route.
 */
export const PollResponse = z.object({
  messages: Message.array().default([]),
  state: z.record(z.string(), z.unknown()).nullable().default(null),
  location: z.record(z.string(), z.unknown()).nullable().default(null),
})

export type PollResponse = z.infer<typeof PollResponse>
