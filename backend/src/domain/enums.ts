// The enums with no column to live in. Persisted ones live next to their table:
// `WorldPhase`/`Language`/`MessageRole` in `db/schema.ts`, `UserRole` in
// `auth/roles.ts`.

import { LANGUAGES, type Language } from '../db/schema'

/** Which context builder a turn runs through. `normal` is the pre-TRPG chat room,
 * still reachable for non-world rooms; `chat` is the `/chat` NPC conversation. */
export const CONVERSATION_MODES = ['normal', 'onboarding', 'game', 'chat'] as const

export type ConversationMode = (typeof CONVERSATION_MODES)[number]

/** Who authored a message — a different axis from `role`, which is the Anthropic
 * user/assistant distinction. Both are written; the frontend renders off this. */
export const PARTICIPANT_TYPES = ['user', 'character', 'system', 'agent'] as const

export type ParticipantType = (typeof PARTICIPANT_TYPES)[number]

export function isParticipantType(value: unknown): value is ParticipantType {
  return (PARTICIPANT_TYPES as readonly unknown[]).includes(value)
}

/** An NPC's standing attitude toward the player, carried in character files. */
export const CHARACTER_DISPOSITIONS = ['friendly', 'neutral', 'wary', 'hostile'] as const

export type CharacterDisposition = (typeof CHARACTER_DISPOSITIONS)[number]

/** The direction of an inventory mutation requested by a gameplay tool. */
export const INVENTORY_CHANGE_ACTIONS = ['add', 'remove'] as const

export type InventoryChangeAction = (typeof INVENTORY_CHANGE_ACTIONS)[number]

/** A world's stored language can be absent or predate the enum, so anything
 * unrecognised falls back to English rather than raising: a bad value degrades
 * the prompt's wording instead of failing the turn. */
export function toLangKey(lang: string | null | undefined): Language {
  return lang === 'ko' || lang === 'jp' ? lang : 'en'
}

/** Whether a raw string is one of the three supported languages. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}
