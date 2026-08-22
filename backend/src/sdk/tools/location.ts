import { z } from 'zod'
import { requiredText, type ToolDefinition } from './definitions'

/**
 * Travel, location listing and character movement. Port of
 * `sdk/tools/location.py`.
 *
 * `list_locations` and `list_characters` live here rather than in
 * `gameplay.ts` for the same reason they do in Python: they are location
 * queries, and `gameplay.ts` re-exports them so the merged Action Manager set
 * stays one object.
 */

/**
 * Coerce whatever the model produced into a list of trimmed names.
 *
 * Python's `normalize_characters` validator exists because Claude routinely
 * hands `bring_characters` a *JSON string* — `'["유나-7"]'` — instead of an
 * array, and occasionally a bare name. Rejecting those would fail the travel
 * call outright and lose the narration with it, so all three shapes are
 * accepted and anything else degrades to the empty list.
 *
 * `z.preprocess` rather than `.transform` because the coercion has to happen
 * *before* the array type is checked, which is exactly what `mode="before"`
 * means on the Python side.
 */
const characterNameList = z.preprocess((value): unknown => {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        return JSON.parse(trimmed)
      } catch {
        return []
      }
    }
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(value)) return []
  return value
}, z.array(z.unknown()).transform((entries) => entries.filter((e) => Boolean(e)).map((e) => String(e).trim())))

export const travelTool = {
  name: 'travel',
  description: `Move the player to an existing location. This is the most comprehensive tool -
it combines travel, narration, action suggestions, AND chat summary into a single call.

When you use this tool:
1. The chat summary is saved to world history (what happened at the current location)
2. The player is moved to the destination
3. Your narration is displayed to the player (like the 'narration' tool)
4. Your action suggestions appear as clickable buttons (like 'suggest_options')

Use Task tool with location_designer to create new locations before traveling there, and use advance_time tool before using this tool to reflect 'time taken for travel' if needed.`,
  inputSchema: {
    destination: requiredText('Destination').describe(
      'Location to travel to (must already exist)',
    ),
    bring_characters: characterNameList
      .default([])
      .describe('List of character names to bring along'),
    narration: requiredText('Narration').describe(
      'REQUIRED: The narrative text describing the travel and arrival. ' +
        'This will be displayed to the player. Make it vivid and engaging, ' +
        'describing the journey and what the player sees upon arrival.',
    ),
    action_1: requiredText('Action').describe(
      'REQUIRED: First suggested action for the player at the new location.',
    ),
    action_2: requiredText('Action').describe(
      'REQUIRED: Second suggested action for the player at the new location.',
    ),
    chat_summary: requiredText('Chat summary').describe(
      'REQUIRED: A 2-4 sentence summary of what happened at the current location ' +
        "before leaving. This will be saved to the world's history. Focus on key events, " +
        'decisions, and outcomes.',
    ),
    user_action: requiredText('User action').describe(
      "REQUIRED: The player's original action that triggered this travel " +
        "(e.g., 'Go to the tavern'). This provides continuity for the next scene.",
    ),
  },
  response: '{travel_result}',
  enabled: true,
} satisfies ToolDefinition

export const moveCharacterTool = {
  name: 'move_character',
  description: `Move an existing character to a different location.
Use this when an NPC needs to relocate (e.g., following the player, fleeing, returning home, or being summoned elsewhere).
The character must already exist in the game.`,
  inputSchema: {
    character_name: requiredText('Character name').describe('Name of the character to move'),
    destination: requiredText('Destination').describe('Location to move the character to'),
    narrative: z.string().default('').describe('Optional narrative description of the movement'),
  },
  response: '{move_result}',
  enabled: true,
} satisfies ToolDefinition

/**
 * Phase 0 rewrote this description; Python's reads:
 * "List all available locations in the current world. / Returns location names,
 * display names, and brief descriptions. / Use this to see where characters can
 * travel or be moved to."
 *
 * The rewrite is left in place deliberately — it is the description a *working*
 * `list_locations` handler was tuned against — but it is a live divergence from
 * the parity contract and is recorded here so the Phase 4 harness has an
 * explanation for the diff rather than a mystery.
 */
export const listLocationsTool = {
  name: 'list_locations',
  description:
    'List the locations that exist in this world, marking the current one. ' +
    'Use this before moving the player, to check a destination exists.',
  inputSchema: {},
  response: '{locations_list}',
  readOnly: true,
  enabled: true,
} satisfies ToolDefinition

/** Same divergence note as {@link listLocationsTool}. */
export const listCharactersTool = {
  name: 'list_characters',
  description:
    'List the characters present at a location. Leave `location` empty for the current location. ' +
    'Use this before narrating who is in the scene.',
  inputSchema: {
    location: z.string().default('').describe('Location name; empty means the current location'),
  },
  response: '{characters_list}',
  readOnly: true,
  enabled: true,
} satisfies ToolDefinition

export const LOCATION_TOOLS = {
  travel: travelTool,
  move_character: moveCharacterTool,
  list_locations: listLocationsTool,
  list_characters: listCharactersTool,
} satisfies Record<string, ToolDefinition>
