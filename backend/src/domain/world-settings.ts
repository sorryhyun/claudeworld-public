/**
 * The world's ground rules — the language everything is written in, what the
 * player is called, and the naming and style conventions every designer must
 * honour — and the brief that carries them into a sub-agent's prompt.
 *
 * They live in `world.json`, not in a file of their own: `language`, `user_name`,
 * `genre` and `theme` are already columns there and already read by the
 * localisation layer, so a second copy would be a second source of truth for the
 * same three fields. `set_world_settings` is the writer; what it adds beyond the
 * existing fields goes in the config's own `settings` bag.
 *
 * The brief is *rendered*, not stored: a world created before this tool existed
 * still has a language and a player name, so its designers get a brief too.
 */

import type { Language } from '@/db/schema'
import { toLangKey } from './enums'

/** Keys inside `world.json`'s `settings` bag. Named because the handler writes
 * them and the reader below has to find them again. */
export const NAMING_STYLE_KEY = 'naming_style'
export const STYLE_NOTES_KEY = 'style_notes'

export interface WorldSettings {
  worldName: string
  language: Language
  playerName: string | null
  genre: string | null
  theme: string | null
  /** How people, places and things are named in this world. */
  namingStyle: string | null
  /** Anything else every designer must honour: tone, era, rating, house rules. */
  styleNotes: string | null
}

/** How the language is named *to the model*. Both the endonym and the English
 * name, because the instruction has to survive being read in either. */
const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  ko: 'Korean (한국어)',
  jp: 'Japanese (日本語)',
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Typed structurally so this module does not depend on the service layer.
 * An unrecognised language degrades to English, as everywhere else. */
export function toWorldSettings(config: {
  name: string
  userName: string | null
  language: string
  genre: string | null
  theme: string | null
  settings: Record<string, unknown>
}): WorldSettings {
  return {
    worldName: config.name,
    language: toLangKey(config.language),
    playerName: asText(config.userName),
    genre: asText(config.genre),
    theme: asText(config.theme),
    namingStyle: asText(config.settings[NAMING_STYLE_KEY]),
    styleNotes: asText(config.settings[STYLE_NOTES_KEY]),
  }
}

/**
 * The block appended to every design sub-agent's system prompt, and echoed back
 * by `set_world_settings` so the manager can see what it registered.
 *
 * The language line is the reason this exists: a designer that is told only
 * "design an item for this world" writes the name and description in English,
 * and a Korean world ends up with a `Traveler's Worn Journal` in its inventory.
 * The identifier carve-out is the other half — told to write everything in
 * Korean, the same designer will hand `item_id` a Hangul string and put a
 * non-ASCII filename in `items/`.
 */
export function renderWorldSettingsBrief(settings: WorldSettings): string {
  const language = LANGUAGE_NAMES[settings.language]

  const lines = [
    '## World Settings',
    '',
    'Registered for this world. Everything you produce must honour them.',
    '',
    `- **World**: ${settings.worldName}`,
    `- **Language: ${language}** — write every player-visible string in this ` +
      'language: names, display names, titles, descriptions, dialogue, lore, and ' +
      'the free-text properties of whatever you persist. Do not fall back to ' +
      'English for convenience and do not append a translation.',
  ]

  if (settings.playerName) lines.push(`- **Player character**: ${settings.playerName}`)
  if (settings.genre) lines.push(`- **Genre**: ${settings.genre}`)
  if (settings.theme) lines.push(`- **Theme**: ${settings.theme}`)
  if (settings.namingStyle) lines.push(`- **Naming**: ${settings.namingStyle}`)
  if (settings.styleNotes) lines.push(`- **House rules**: ${settings.styleNotes}`)

  lines.push(
    '',
    'Machine identifiers are the one exception and stay lowercase ASCII ' +
      'snake_case: a location `name`, an `item_id`, a stat name, a flag name, an ' +
      'affordance id. Their player-facing counterparts — `display_name`, an item ' +
      "`name` — follow the world's language like everything else.",
  )

  return lines.join('\n')
}
