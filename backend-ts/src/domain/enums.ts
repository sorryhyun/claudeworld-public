/**
 * The enums from `backend/domain/value_objects/enums.py` that have no column
 * to live in.
 *
 * Most of that file's enums are persisted, so they belong next to the table
 * that stores them: `WorldPhase`, `Language` and `MessageRole` are in
 * `db/schema.ts`, and `UserRole` is in `auth/roles.ts`. What is left are the
 * three that only ever travel through prompts, tool arguments and JSON blobs —
 * plus `Language`'s one helper, which is behaviour rather than a column type.
 *
 * All of these are `str, Enum` in Python and therefore serialise as bare
 * strings into the world files the Python backend still reads. String-literal
 * unions reproduce that exactly and cost nothing at runtime; the `const` array
 * beside each is there so a value can be validated or iterated. This matches
 * the shape already used by `auth/roles.ts` and `db/schema.ts`.
 *
 */

import { LANGUAGES, type Language } from '../db/schema'

/**
 * Which context builder a turn runs through.
 *
 * `normal` is the pre-TRPG chat room, still reachable for non-world rooms;
 * `chat` is the in-world NPC conversation entered with `/chat`.
 */
export const CONVERSATION_MODES = ['normal', 'onboarding', 'game', 'chat'] as const

export type ConversationMode = (typeof CONVERSATION_MODES)[number]

/** An NPC's standing attitude toward the player, carried in character files. */
/**
 * Who authored a message. Port of `ParticipantType`.
 *
 * Not the same axis as `role`: `role` is the Anthropic user/assistant
 * distinction the SDK needs, while this says whether the author was the player,
 * a character, a system notice, or a non-character agent. Both columns are
 * written on every row, and the frontend renders off this one.
 */
export const PARTICIPANT_TYPES = ['user', 'character', 'system', 'agent'] as const

export type ParticipantType = (typeof PARTICIPANT_TYPES)[number]

export function isParticipantType(value: unknown): value is ParticipantType {
  return (PARTICIPANT_TYPES as readonly unknown[]).includes(value)
}

export const CHARACTER_DISPOSITIONS = ['friendly', 'neutral', 'wary', 'hostile'] as const

export type CharacterDisposition = (typeof CHARACTER_DISPOSITIONS)[number]

/** The direction of an inventory mutation requested by a gameplay tool. */
export const INVENTORY_CHANGE_ACTIONS = ['add', 'remove'] as const

export type InventoryChangeAction = (typeof INVENTORY_CHANGE_ACTIONS)[number]

/**
 * `Language.to_lang_key` from `enums.py:61-66`.
 *
 * Config files key their per-language strings by `en` / `ko` / `jp`, and a
 * world's stored language can be absent, or a value that predates the enum.
 * Anything unrecognised falls back to English rather than raising, so a bad
 * value degrades the prompt's wording instead of failing the turn.
 *
 * The helper lives here rather than beside `Language` in `db/schema.ts`
 * because it is prompt-building logic, and `db/schema.ts` is kept to the
 * table definitions the drift gate compares.
 */
export function toLangKey(lang: string | null | undefined): Language {
  return lang === 'ko' || lang === 'jp' ? lang : 'en'
}

/** Whether a raw string is one of the three supported languages. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}
