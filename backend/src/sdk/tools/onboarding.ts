import { z } from 'zod'
import { requiredText, requiredTextOfLength, type ToolDefinition } from './definitions'

/**
 * World initialisation. Only the *ends* are ordered: `draft_world` writes just
 * enough lore for the designers to produce thematically consistent content, and
 * `complete` flips the phase. Between them the Onboarding Manager builds
 * incrementally — re-drafting as the interview moves, dispatching a designer the
 * moment the player names something, reading `world_status` to see what already
 * exists — and `persist_world` writes the finished lore and stat system over the
 * draft. Skipping `draft_world` produces a world whose locations were designed
 * against nothing; that is the one sequencing the descriptions still enforce.
 */

/** One entry in the world's stat system, as written to `stats.json`. */
export const statDefinitionSchema = z.object({
  name: z.string().describe("Internal stat name (e.g., 'health', 'mana')"),
  display: z.string().describe("Display name shown to player (e.g., 'HP', 'MP')"),
  min: z.number().int().nullable().default(0).describe('Minimum value (default: 0)'),
  max: z.number().int().nullable().default(100).describe('Maximum value (null for unlimited)'),
  default: z.number().int().describe('Starting value for new players'),
  color: z
    .string()
    .nullable()
    .default(null)
    .describe("Optional hex color for UI (e.g., '#ff0000')"),
})

export const statSystemSchema = z.object({
  stats: z.array(statDefinitionSchema).min(1).describe('List of stat definitions'),
  derived: z
    .array(z.record(z.string(), z.unknown()))
    .nullable()
    .default([])
    .describe('Optional derived stats (computed from base stats)'),
})

export type StatSystemInput = z.infer<typeof statSystemSchema>

export const readLoreGuidelinesTool = {
  name: 'read_lore_guidelines',
  description: `Return the lore writing guidelines for world creation.
Call this tool to review the recommended structure, layers, and checklist
for creating comprehensive world lore before calling draft_world or persist_world.`,
  inputSchema: {},
  // Filled from `lore_guidelines.yaml`'s active version, not from this template.
  response: '{lore_guidelines_content}',
  readOnly: true,
  enabled: true,
} satisfies ToolDefinition

export const draftWorldTool = {
  name: 'draft_world',
  description: `Create or update the lightweight world draft: genre, theme, lore summary.
Call this FIRST — as soon as the world has a direction, not once the interview is
over — because it is what unblocks the design sub-agents. They use this context to
create thematically consistent content while the conversation continues.

**Call it again whenever the conversation moves the world.** Pass only the fields
that changed; omitted fields keep their current value, and the sections your
designers have written into the lore are preserved either way.`,
  inputSchema: {
    genre: requiredText('Genre')
      .nullable()
      .default(null)
      .describe(
        "World genre (e.g., 'dark fantasy', 'sci-fi horror', 'cozy mystery'). " +
          'Omit to keep the current genre.',
      ),
    theme: requiredText('Theme')
      .nullable()
      .default(null)
      .describe(
        "Thematic elements (e.g., 'survival and redemption', 'political intrigue'). " +
          'Omit to keep the current theme.',
      ),
    lore_summary: requiredTextOfLength('Lore summary', 50, 1000)
      .nullable()
      .default(null)
      .describe(
        'One-paragraph summary of the world concept (50-1000 chars). ' +
          'Captures the essential setting, conflict, and atmosphere. ' +
          'Sub-agents use this context to create thematically consistent content. ' +
          'Omit to keep the current summary.',
      ),
  },
  response: `World draft updated.
Genre: {genre}
Theme: {theme}
Sub-agents can now start with this context.`,
  enabled: true,
} satisfies ToolDefinition

export const worldStatusTool = {
  name: 'world_status',
  description: `Report what this world already contains: genre and theme, whether the
full lore and stat system have been persisted, and the locations, characters, items
and lore sections created so far.

Free of side effects. Call it before creating anything, so incremental building does
not produce a second version of a place or a person the player already met, and again
before \`complete\` to check the starting location and the cast actually exist.`,
  inputSchema: {},
  response: '{status}',
  readOnly: true,
  enabled: true,
} satisfies ToolDefinition

export const persistWorldTool = {
  name: 'persist_world',
  description: `Persist comprehensive world data: full lore + stat system + player state.
Call this AFTER sub-agents have started with draft_world context, once the world's
shape has settled — the locations and characters already on disk are what the lore
should describe.

Replaces the draft body with the full version. Sections written by design sub-agents
through \`add_world_lore\`, and any existing world notes, are kept.`,
  inputSchema: {
    lore: requiredTextOfLength('Lore', 100).describe(
      'Comprehensive world lore (8-15 paragraphs). ' +
        'Call read_lore_guidelines first for structure and checklist.',
    ),
    stat_system: statSystemSchema.describe('The stat system for this world (4-6 stats)'),
    initial_stats: z
      .record(z.string(), z.number().int())
      .nullable()
      .default(null)
      .describe('Override starting stat values (uses defaults if not provided)'),
    world_notes: z
      .string()
      .nullable()
      .default(null)
      .describe('Additional notes about the world for other agents'),
  },
  response: `World persisted successfully.
Stats: {stat_count}
Lore: {lore_length} characters`,
  enabled: true,
} satisfies ToolDefinition

export const completeTool = {
  name: 'complete',
  description: `Complete the onboarding phase and transition the world to active.
This is a lightweight tool that finalizes the onboarding process.

Call this tool LAST, after:
1. draft_world (genre, theme, lore summary) — early, and re-called as the world moved
2. Sub-agents (location_designer, character_designer, item_designer) — dispatched
   throughout the interview, not all at the end
3. persist_world (full lore, stats)

Call world_status first if you are unsure what exists.

You MUST specify the starting_location - use the internal name (not display name)
of the location where the player's adventure begins.`,
  inputSchema: {
    player_name: requiredText('Player name').describe(
      'The name the player wants to be called in the world',
    ),
    starting_location: requiredText('Starting location').describe(
      "The location name (internal name, not display name) where the player's adventure begins. " +
        'Must match one of the locations created by location_designer.',
    ),
    starting_hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .default(8)
      .describe('The hour of day to start the adventure (0-23, default: 8 for morning)'),
  },
  response: `World initialized successfully.
Player: {player_name}
Starting location: {starting_location}
Starting time: {starting_hour}:00
Phase: active

The world is now ready for adventure!`,
  enabled: true,
} satisfies ToolDefinition

export const ONBOARDING_TOOLS = {
  read_lore_guidelines: readLoreGuidelinesTool,
  world_status: worldStatusTool,
  draft_world: draftWorldTool,
  persist_world: persistWorldTool,
  complete: completeTool,
} satisfies Record<string, ToolDefinition>
