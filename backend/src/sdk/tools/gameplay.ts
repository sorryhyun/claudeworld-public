import { z } from 'zod'
import { requiredText, type ToolDefinition } from './definitions'
import { ITEM_TOOLS } from './item'
import { LOCATION_TOOLS } from './location'

/**
 * Action Manager tools. This module owns the *core* gameplay tools and merges
 * in the item and location sets to produce `ACTION_MANAGER_TOOLS`, the single
 * object the registry and the group-config override path read. A few tools have
 * no handler and are declarations only — see `item.ts` and `setFlagTool`.
 */

// Re-exported for the import path; these are *defined* in `location.ts`.
export {
  listCharactersTool,
  listLocationsTool,
  moveCharacterTool,
  travelTool,
  LOCATION_TOOLS,
} from './location'
export { ITEM_TOOLS } from './item'

export const removeCharacterTool = {
  name: 'remove_character',
  description: `Remove an NPC from the current location.
Use this when a character leaves, departs, or should no longer be at this location.
The character still exists in the world and can be encountered elsewhere.`,
  inputSchema: {
    character_name: requiredText('Character name').describe(
      'Name of character to remove from current location',
    ),
  },
  response: '{removal_result}',
  enabled: true,
} satisfies ToolDefinition

export const deleteCharacterTool = {
  name: 'delete_character',
  description: `Permanently delete an NPC from the game.
Use this when an NPC dies, 실종, or is removed by magic.
The character will be archived and no longer exist in the world.
Reasons: 'death', '실종', 'magic'`,
  inputSchema: {
    character_name: requiredText('Character name').describe('Name of character to delete'),
    // The handler maps anything it does not recognise onto DEATH, so no
    // normalisation is needed here.
    reason: z.string().default('death').describe("Reason for deletion: 'death', '실종', or 'magic'"),
    narrative: z.string().default('').describe('Optional narrative description of the deletion'),
  },
  response: '{deletion_result}',
  enabled: true,
} satisfies ToolDefinition

export const injectMemoryTool = {
  name: 'inject_memory',
  description: `Inject a memory into a specific character's recent_events.
Use this when external events should implant memories into NPCs, such as hypnosis, mind control, illusions, or similar supernatural effects.
The character will remember this as if it actually happened or regard as commonsense.`,
  inputSchema: {
    character_name: requiredText('Character name').describe(
      'Name of the character to inject memory into',
    ),
    memory_entry: requiredText('Memory entry').describe('The memory to inject (one-liner)'),
  },
  response: '{inject_memory_result}',
  enabled: true,
} satisfies ToolDefinition

// Accept a list the model may have serialised as a JSON string — `change_stat`
// gets `'[]'` or `'[{"stat_name": "HP", ...}]'` often enough to matter. A
// malformed list is dropped rather than raised: failing the call would lose the
// whole mechanical resolution of the turn.
const recordList = z.preprocess((value): unknown => {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed === '[]') return []
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? value : []
}, z.array(z.record(z.string(), z.unknown())))

export const changeStatTool = {
  name: 'change_stat',
  description: `Apply stat and inventory changes to player state.
Used directly by Action Manager after determining mechanical effects.
Persists changes to filesystem and syncs to database.

**IMPORTANT: Item Handling**
- Items can ONLY be added if they already exist in the world's items/ directory.
- Use Task with item_designer to create new items BEFORE adding to inventory.
- If an item doesn't exist, it will be SKIPPED and reported in the response.
- Removing items always works (no template required).

**Note:** For time advancement, use \`advance_time\` tool separately.`,
  inputSchema: {
    summary: requiredText('Summary').describe('Summary of changes'),
    stat_changes: recordList.default([]).describe('List of {stat_name, delta} objects'),
    inventory_changes: recordList
      .default([])
      .describe(
        'List of {action, item_id, name, quantity, description?, properties?} objects',
      ),
    time_advance_minutes: z
      .number()
      .int()
      .default(0)
      .describe('Minutes to advance (0 = no time change)'),
  },
  response: '{persist_result}',
  enabled: true,
} satisfies ToolDefinition

export const advanceTimeTool = {
  name: 'advance_time',
  description: `Advance in-game time. Use this when actions take significant time:
- Travel between locations
- Resting, sleeping, waiting
- Long activities (crafting, studying, training)
- Passage of time during scenes

**Effects:**
- Updates world clock (hour, minute, day)
- May trigger time-based events (day/night cycle, NPC schedules)
- Returns new time state for narration`,
  inputSchema: {
    minutes: z.number().int().min(1).describe('Minutes to advance (minimum 1)'),
    reason: requiredText('Reason').describe('Brief explanation of why time passes'),
  },
  response: '{time_result}',
  enabled: true,
} satisfies ToolDefinition

// Declared but never implemented: there is no `set_flag` handler and no server
// offers it. The declaration exists because `group_config.yaml` addresses tools
// by name.
export const setFlagTool = {
  name: 'set_flag',
  description: `Set a player flag for game state tracking.

Flags are boolean values used for:
- Item affordance requirements (e.g., 'in_conversation' flag)
- Story progression tracking (e.g., 'boss_defeated')
- Route unlocking (e.g., 'route_unlocked')
- World state (e.g., 'night_time', 'rainy')

Many item affordances require certain flags to be true/false.`,
  inputSchema: {
    flag: requiredText('flag').describe('Name of the flag to set'),
    value: z.boolean().default(true).describe('Value to set the flag to (default: True)'),
  },
  response: '{flag_result}',
  enabled: true,
} satisfies ToolDefinition

export const recallHistoryTool = {
  name: 'recall_history',
  description: `Retrieve a past event from the world's consolidated history by subtitle.
Use this to recall specific events that happened earlier in the game.

Available history entries: {history_subtitles}

**When to use:**
- When the player references past events
- When you need context about what happened before
- When continuity with earlier story beats matters`,
  inputSchema: {
    subtitle: requiredText('Subtitle').describe('The subtitle of the history entry to recall'),
  },
  // The matched section, verbatim. A group config can narrow this.
  response: '{history_content}',
  readOnly: true,
  enabled: true,
} satisfies ToolDefinition

export const awaitReactionsTool = {
  name: 'await_reactions',
  description: `Collect what the NPCs at this location did and said in response to the player's action.

They are running **right now**, started at the same moment you were, so this tool waits for
whichever of them are still speaking and returns every reaction verbatim.

**Call it after you have already narrated the player's own action.** That first \`narration\`
is what the player reads while the NPCs are still thinking; this tool is how you find out
what to write next. Calling it before you have narrated anything wastes the head start and
leaves the player watching a blank screen.

Then call \`narration\` a second time for what came back: quote each NPC's dialogue as
spoken lines, attributed by name, and stage the actions they described. What they said is
not raw material to summarise — it is the scene, and a reaction that never reaches the
player was never in the game.

Returns a note saying so when nobody is present. Safe to call more than once; every call
after the first returns the same reactions without waiting again.`,
  inputSchema: {},
  response: '{reactions}',
  enabled: true,
  readOnly: true,
} satisfies ToolDefinition

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

**Voice the NPCs — this is the narrator's job, not theirs.**
An NPC has no voice of its own in front of the player: nothing it says reaches the screen
except through this tool. So whenever \`await_reactions\` has returned something, name the
character and quote what they actually said as spoken dialogue, then stage the action they
took around it. Keep their wording and their register — do not flatten three characters
into one summary sentence, and do not report speech in the abstract ("the guard objects")
where the guard gave you a line.

**DO NOT:**
- Write the player's actions or feelings
- Use purple prose or overwrite
- Resolve situations too quickly
- Drop an NPC's reaction, or paraphrase away a line they actually spoke

Called more than once per turn, by design: narrate the player's action as soon as the
ruling is clear, then call \`await_reactions\` and narrate again for what the NPCs and the
sub-agents brought back. Resolve mechanics (\`change_stat\`, \`travel\`, …) before describing
their effects.`,
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

/** Weighted outcomes for `roll_the_dice`, as percentages summing to 100. */
export const DICE_OUTCOMES: ReadonlyArray<readonly [outcome: string, weight: number]> = [
  ['very_lucky', 1],
  ['lucky', 5],
  ['nothing_happened', 88],
  ['bad_luck', 5],
  ['worst_day_of_game', 1],
] as const

/**
 * The line the model is shown under each outcome. Load-bearing, not decoration:
 * `nothing_happened` alone reads as "the tool failed to decide" and the Action
 * Manager re-rolls; the sentence tells it the roll *was* the answer.
 */
export const DICE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  very_lucky:
    '🌟 **VERY LUCKY!** An exceptional stroke of fortune! The outcome is far better than expected.',
  lucky: '🍀 **Lucky!** Fortune favors the bold. The outcome is better than expected.',
  nothing_happened: '⚖️ **Standard outcome.** Things proceed as one might normally expect.',
  bad_luck: "😓 **Bad luck.** Things don't go quite as planned. The outcome is worse than expected.",
  worst_day_of_game: '💀 **WORST DAY!** A critical failure! Something has gone terribly wrong.',
}

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

/** The full tool result text, not just the bucket name. */
export function formatDiceRoll(outcome: string): string {
  return `**Dice Roll Result:** \`${outcome}\`\n\n${DICE_DESCRIPTIONS[outcome] ?? ''}`
}

export const CORE_GAMEPLAY_TOOLS = {
  remove_character: removeCharacterTool,
  delete_character: deleteCharacterTool,
  inject_memory: injectMemoryTool,
  roll_the_dice: rollTheDiceTool,
  await_reactions: awaitReactionsTool,
  narration: narrationTool,
  suggest_options: suggestOptionsTool,
  change_stat: changeStatTool,
  advance_time: advanceTimeTool,
  set_flag: setFlagTool,
  recall_history: recallHistoryTool,
} satisfies Record<string, ToolDefinition>

export const ACTION_MANAGER_TOOLS = {
  ...CORE_GAMEPLAY_TOOLS,
  ...ITEM_TOOLS,
  ...LOCATION_TOOLS,
} satisfies Record<string, ToolDefinition>
