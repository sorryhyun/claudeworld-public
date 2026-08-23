import { z } from 'zod'
import { requiredText, requiredTextOfLength, type ToolDefinition } from './definitions'

/**
 * Persist tools for the sub-agents dispatched by the `Agent` tool. A sub-agent
 * has no database session and no filesystem service of its own, so the *parent*
 * exposes an MCP server the child calls back into — the one capability with no
 * `resume`-based workaround.
 *
 * The component schemas below exist mainly so the *model* is told the shape of
 * an affordance; runtime validation is secondary, since `item-validation.ts`
 * re-checks every reference against the world's catalogs before a write.
 */

const statRequirement = z.object({
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
})

const statChange = z.object({
  stat: z.string(),
  delta: z.number(),
})

const flagChange = z.object({
  flag: z.string(),
  value: z.boolean(),
})

const itemConsumption = z.object({
  item_id: z.string(),
  quantity: z.number().int().default(1),
})

const chargeConfig = z.object({
  max: z.number().int().nullable().optional(),
  consume: z.number().int().default(1),
  /** `{event, amount}` — validated against the world's recharge-event catalog. */
  recharge: z.record(z.string(), z.unknown()).nullable().optional(),
})

const cooldownConfig = z.object({
  domain: z.string(),
  value: z.number().int(),
})

const affordanceRequirements = z.object({
  stats: z.record(z.string(), statRequirement).nullable().optional(),
  flags_all: z.array(z.string()).nullable().optional(),
  flags_any: z.array(z.string()).nullable().optional(),
  flags_none: z.array(z.string()).nullable().optional(),
  items: z.array(z.string()).nullable().optional(),
})

const affordanceCost = z.object({
  stat_changes: z.array(statChange).nullable().optional(),
  consume_items: z.array(itemConsumption).nullable().optional(),
})

const affordanceEffects = z.object({
  stat_changes: z.array(statChange).nullable().optional(),
  set_flags: z.array(flagChange).nullable().optional(),
  grant_items: z.array(itemConsumption).nullable().optional(),
  remove_self: z.boolean().nullable().optional(),
})

const affordance = z.object({
  id: z.string(),
  label: z.string(),
  requirements: affordanceRequirements.nullable().optional(),
  cost: affordanceCost.nullable().optional(),
  effects: affordanceEffects.nullable().optional(),
  charges: chargeConfig.nullable().optional(),
  cooldown: cooldownConfig.nullable().optional(),
})

const stackingConfig = z.object({
  stackable: z.boolean().default(true),
  max_stack: z.number().int().nullable().optional(),
  unique: z.boolean().default(false),
})

const equippableConfig = z.object({
  slot: z.string(),
  accepts_as: z.array(z.string()).nullable().optional(),
  passive_effects: z.record(z.string(), z.number()).nullable().optional(),
})

const usableConfig = z.object({
  affordances: z.array(affordance),
})

/** One item in a `persist_item` call. */
export const itemDefinitionSchema = z.object({
  item_id: requiredText('Item ID').describe('Unique item identifier (snake_case)'),
  name: requiredText('Item name').describe('Display name for the item'),
  description: requiredText('Description').describe(
    'Item description with lore/visual details',
  ),
  quantity: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('Quantity to add to inventory (default: 1)'),
  category: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Item category: gift, credential, clue, tool, ability, status, ' +
        'relationship, material, document, vehicle, equipment, consumable',
    ),
  tags: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Tags for filtering/behavior: [romance, combat, consumable, unique]'),
  rarity: z
    .string()
    .nullable()
    .optional()
    .describe('Rarity tier: common, uncommon, rare, epic, legendary'),
  icon: z.string().nullable().optional().describe('UI hint for icon display'),
  stacking: stackingConfig
    .nullable()
    .optional()
    .describe('Stacking rules: {stackable, max_stack, unique}'),
  equippable: equippableConfig
    .nullable()
    .optional()
    .describe('Equipment config: {slot, accepts_as, passive_effects}'),
  usable: usableConfig.nullable().optional().describe('Usable actions: {affordances: [...]}'),
  properties: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      'Additional item properties (legacy format, also stored as default_properties)',
    ),
})

export type ItemDefinitionInput = z.infer<typeof itemDefinitionSchema>

export const persistCharacterDesignTool = {
  name: 'persist_character_design',
  description: `Persist a character design to the game world.
Used by Character Designer sub-agent after designing a character.
Creates the character in filesystem and database.`,
  inputSchema: {
    name: requiredText('Name').describe("Character's name"),
    role: requiredText('Role').describe("Character's role (e.g., merchant, guard)"),
    appearance: requiredText('Appearance').describe('Physical description'),
    personality: requiredText('Personality').describe('Personality traits'),
    which_location: z
      .string()
      .default('current')
      .describe("Where to place: 'current' or location name"),
    secret: z.string().nullable().default(null).describe('Hidden detail or motivation'),
    initial_disposition: z
      .string()
      .default('neutral')
      .describe('Initial attitude: friendly, neutral, wary, hostile'),
  },
  response: '{persist_result}',
  enabled: true,
} satisfies ToolDefinition

export const persistLocationDesignTool = {
  name: 'persist_location_design',
  description: `Persist a location design to the game world.
Used by Location Designer sub-agent after designing a location.
Creates the location in filesystem and database.`,
  inputSchema: {
    name: requiredText('Name').describe('Location slug (snake_case)'),
    display_name: requiredText('Display name').describe('Human-readable name'),
    description: requiredText('Description').describe('Rich description'),
    position_x: z.number().int().default(0).describe('X coordinate on map'),
    position_y: z.number().int().default(0).describe('Y coordinate on map'),
    // A bare string is wrapped into a one-element list: the model writes
    // `adjacent_to: "town_square"` often enough that rejecting it would cost a
    // whole location design.
    adjacent_to: z
      .preprocess(
        (value) => (typeof value === 'string' ? [value] : value),
        z.array(z.string()).nullable(),
      )
      .default(null)
      .describe('Name(s) of adjacent location(s) to connect to'),
    is_starting: z
      .boolean()
      .default(false)
      .describe("Whether this is the starting location (sets player's current_location)"),
  },
  response: '{persist_result}',
  enabled: true,
} satisfies ToolDefinition

export const persistItemTool = {
  name: 'persist_item',
  description: `Persist an item design to the game world.
Used by Item Designer sub-agent after designing an item.
Creates the item template in filesystem (items/[item_id].json).

**Returns error if:**
- Item ID already exists (use existing item instead)
- Item ID contains invalid characters`,
  inputSchema: {
    items: z
      .array(itemDefinitionSchema)
      .min(1)
      .describe('List of items to create. Each item will be saved as a template.'),
    add_to_inventory: z
      .boolean()
      .default(false)
      .describe(
        'If true, also add items to player inventory. Use during onboarding for starting items.',
      ),
  },
  response: '{persist_result}',
  enabled: true,
} satisfies ToolDefinition

export const addWorldLoreTool = {
  name: 'add_world_lore',
  description: `Write a named section into the world's shared lore.
Every designer may call this: the world you are designing *for* is also a world
you are allowed to extend. Use it when your design establishes something the
rest of the world should know — a faction, a custom, a piece of history, the
reason a place is abandoned — not to restate the design itself, which your
persist tool already stores.

The section is filed under its title. Calling this again with the same title
**rewrites** that section, so a revision is one call, not a second entry.
Sections written here survive the Onboarding Manager's \`persist_world\`.`,
  inputSchema: {
    title: requiredText('Title').describe(
      "Short section title, unique within the world (e.g. 'The Ashen Compact', " +
        "'Why the North Gate Is Sealed'). Reusing a title rewrites that section.",
    ),
    content: requiredTextOfLength('Content', 40, 4000).describe(
      'The lore text, 1-3 paragraphs (40-4000 chars). Written in the world\'s ' +
        'own voice, consistent with the existing genre, theme and lore.',
    ),
  },
  response: '{lore_result}',
  enabled: true,
} satisfies ToolDefinition

export const SUBAGENT_TOOLS = {
  persist_character_design: persistCharacterDesignTool,
  persist_location_design: persistLocationDesignTool,
  persist_item: persistItemTool,
  add_world_lore: addWorldLoreTool,
} satisfies Record<string, ToolDefinition>

/** Which qualified tool each sub-agent type calls back into. */
export const SUBAGENT_TOOL_NAMES = {
  item_designer: 'mcp__subagents__persist_item',
  character_designer: 'mcp__subagents__persist_character_design',
  location_designer: 'mcp__subagents__persist_location_design',
} as const

/** Offered *alongside* the persist tool above, to every designer that gets one.
 * Separate from {@link SUBAGENT_TOOL_NAMES} because that map is the "which
 * sub-agent reports through which callback" join, and this tool belongs to all
 * of them. Gated on `ServerDeps.worlds` like the rest of the lore surface, so
 * `subagent-definitions.ts` grants it only when the turn actually serves it. */
export const LORE_CONTRIBUTION_TOOL = 'mcp__subagents__add_world_lore'
