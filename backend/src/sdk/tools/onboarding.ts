import { z } from 'zod'
import { requiredText, requiredTextOfLength, type ToolDefinition } from './definitions'

/**
 * World initialisation. Port of `sdk/tools/onboarding.py`.
 *
 * The order these are called in is the whole design, and the descriptions are
 * what enforce it: `draft_world` writes just enough lore for the Task-tool
 * sub-agents to start producing thematically consistent content, they run while
 * the Onboarding Manager is still writing, `persist_world` overwrites the draft
 * with the full version, and `complete` flips the phase. Reordering them
 * produces a world whose locations were designed against nothing.
 */

// ============================================================================
// Shared models
// ============================================================================

/** One entry in the world's stat system, as written to `stats.yaml`. */
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

// ============================================================================
// Tool definitions
// ============================================================================

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
  description: `Create a lightweight world draft with genre, theme, and lore summary.
Call this FIRST to unblock sub-agents. They will use this context to
create thematically consistent content while you refine the full lore.`,
  inputSchema: {
    genre: requiredText('Genre').describe(
      "World genre (e.g., 'dark fantasy', 'sci-fi horror', 'cozy mystery')",
    ),
    theme: requiredText('Theme').describe(
      "Thematic elements (e.g., 'survival and redemption', 'political intrigue')",
    ),
    lore_summary: requiredTextOfLength('Lore summary', 50, 1000).describe(
      'One-paragraph summary of the world concept (50-1000 chars). ' +
        'Captures the essential setting, conflict, and atmosphere. ' +
        'Sub-agents use this context to create thematically consistent content.',
    ),
  },
  response: `World draft created.
Genre: {genre}
Theme: {theme}
Sub-agents can now start with this context.`,
  enabled: true,
} satisfies ToolDefinition

export const persistWorldTool = {
  name: 'persist_world',
  description: `Persist comprehensive world data: full lore + stat system + player state.
Call this AFTER sub-agents have started with draft_world context.
Overwrites the draft lore with the full version.`,
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
1. draft_world (genre, theme, lore summary)
2. Sub-agents (location_designer, character_designer, item_designer)
3. persist_world (full lore, stats)

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
  draft_world: draftWorldTool,
  persist_world: persistWorldTool,
  complete: completeTool,
} satisfies Record<string, ToolDefinition>
