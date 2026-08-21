import { z } from 'zod'
import type { ToolDefinition } from './definitions'

/**
 * Action Manager tools. Port of the subset of `sdk/tools/gameplay.py` a
 * gameplay turn needs.
 *
 * Scope note for Phase 0: this is the pilot's tool set — `narration`,
 * `suggest_options`, `roll_the_dice`, `list_characters`, `list_locations`.
 * The full Python set also declares `change_stat`, `advance_time`,
 * `inject_memory`, `travel`, `move_character`, `remove_character`,
 * `delete_character`, `recall_history` and the item tools; those arrive with
 * Phase 2's services layer.
 *
 * Five tools declared in Python are deliberately NOT ported: `set_flag`,
 * `equip_item`, `unequip_item`, `use_item` and `list_equipment` have no handler
 * on the Python side either. They reach the model through `allowed_tool_names`
 * and fail when called, so they are dropped rather than reproduced.
 */

export const narrationTool = {
  name: 'narration',
  description: `REQUIRED: Create a visible narrative message describing the outcome of the player's action.

This is the text the player will see in the chat. It should be:
- Vivid and engaging with sensory details
- Appropriate to the world's genre and tone
- Focused on the outcome of their action
- Natural continuation of the story

**Writing Guidelines:**
- Use present tense for immediacy
- Engage multiple senses (sight, sound, smell)
- Show NPC emotions through actions and dialogue
- Keep paragraphs focused and punchy
- End on a moment of tension or choice

**DO NOT:**
- Write the player's actions or feelings
- Use purple prose or overwrite
- Resolve situations too quickly

Call this AFTER resolving mechanics (stat changes via change_stat, travel, etc.) to describe what happened.`,
  inputSchema: {
    narrative: z
      .string()
      .min(1)
      .describe("The narrative text describing the outcome of the player's action"),
  },
  response: 'Narrative message created and displayed to player.',
  enabled: true,
} satisfies ToolDefinition

export const suggestOptionsTool = {
  name: 'suggest_options',
  description: `REQUIRED: Provide two suggested actions for the player at the end of your turn.
These suggestions appear as clickable buttons in the UI.

Good suggestions:
- Are contextually relevant to the current situation
- Offer meaningful choices (not just "go left" / "go right")
- Can include dialogue options, actions, or exploration
- Should feel natural given what just happened`,
  inputSchema: {
    action_1: z.string().min(1).describe('First suggested action'),
    action_2: z.string().min(1).describe('Second suggested action'),
  },
  response: '**Suggested Actions:**\n1. {action_1}\n2. {action_2}',
  enabled: true,
} satisfies ToolDefinition

export const rollTheDiceTool = {
  name: 'roll_the_dice',
  description: `Roll the dice to determine a random outcome for uncertain events.
Use this when an action's success depends on chance or luck.

**Probability Distribution:**
- very_lucky (1%): Exceptional success, bonus rewards
- lucky (5%): Better than expected outcome
- nothing_happened (88%): Standard outcome, no bonus
- bad_luck (5%): Worse than expected outcome
- worst_day_of_game (1%): Critical failure, negative consequences

**Usage:**
Call this tool when the player attempts something risky or uncertain.
Use the result to inform how you narrate the outcome and what stat changes to apply via change_stat.

No parameters required - just call to get a random result.`,
  inputSchema: {},
  response: '{roll_result}',
  enabled: true,
} satisfies ToolDefinition

export const listCharactersTool = {
  name: 'list_characters',
  description:
    'List the characters present at a location. Leave `location` empty for the current location. ' +
    'Use this before narrating who is in the scene.',
  inputSchema: {
    location: z.string().default('').describe('Location name; empty means the current location'),
  },
  enabled: true,
} satisfies ToolDefinition

export const listLocationsTool = {
  name: 'list_locations',
  description:
    'List the locations that exist in this world, marking the current one. ' +
    'Use this before moving the player, to check a destination exists.',
  inputSchema: {},
  enabled: true,
} satisfies ToolDefinition

/**
 * Weighted outcomes for `roll_the_dice`, as percentages summing to 100.
 * Ported verbatim from `handlers/mechanics_tools.py`.
 */
export const DICE_OUTCOMES: ReadonlyArray<readonly [outcome: string, weight: number]> = [
  ['very_lucky', 1],
  ['lucky', 5],
  ['nothing_happened', 88],
  ['bad_luck', 5],
  ['worst_day_of_game', 1],
] as const

export function rollDice(random: () => number = Math.random): string {
  const total = DICE_OUTCOMES.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = random() * total
  for (const [outcome, weight] of DICE_OUTCOMES) {
    roll -= weight
    if (roll < 0) return outcome
  }
  // Only reachable if random() returns exactly 1; the last bucket is correct.
  return DICE_OUTCOMES[DICE_OUTCOMES.length - 1]![0]
}

export const ACTION_MANAGER_TOOLS = {
  narration: narrationTool,
  suggest_options: suggestOptionsTool,
  roll_the_dice: rollTheDiceTool,
  list_characters: listCharactersTool,
  list_locations: listLocationsTool,
} satisfies Record<string, ToolDefinition>
