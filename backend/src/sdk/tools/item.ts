import { z } from 'zod'
import { requiredText, type ToolDefinition } from './definitions'

/**
 * Inventory, equipment and item usage.
 *
 * **Only two of these six have handlers.** `list_inventory` and
 * `list_world_item` are implemented in `handlers/mechanics-tools.ts`;
 * `equip_item`, `unequip_item`, `use_item` and `list_equipment` exist only as
 * definitions, because `group_config.yaml` can name them and
 * `getToolNamesByGroup` reads the definitions — no server offers them, so a call
 * fails. `domain/player-rules.ts` already carries every rule they would need.
 */

export const listInventoryTool = {
  name: 'list_inventory',
  description: `List all items in the player's inventory.
Returns item names, descriptions, and quantities.
Use this to check what items the player has before making decisions.`,
  inputSchema: {},
  response: '{inventory_list}',
  readOnly: true,
  enabled: true,
} satisfies ToolDefinition

export const listWorldItemTool = {
  name: 'list_world_item',
  description: `List all item templates available in this world's item dictionary.
Returns item IDs, names, descriptions, and properties.

**Use Cases:**
- Check what items exist before adding to player inventory
- Find specific items by keyword search
- Review available items for quest design or rewards`,
  inputSchema: {
    keyword: z
      .string()
      .default('')
      .describe(
        'Optional keyword to filter items by name or description. Leave empty to list all items.',
      ),
  },
  response: '{items_list}',
  readOnly: true,
  enabled: true,
} satisfies ToolDefinition

export const equipItemTool = {
  name: 'equip_item',
  description: `Equip an item from inventory to an equipment slot.

**Requirements:**
- Item must be in player's inventory
- Item must have an 'equippable' component with a valid slot
- The target slot must be defined in the world's equipment_slots catalog

**Behavior:**
- If an item is already equipped in that slot, it's returned to inventory
- Passive effects from equipped items are automatically applied to stats
- Slot can be auto-detected from item template if not specified`,
  inputSchema: {
    item_id: requiredText('item_id').describe('ID of the item to equip'),
    slot: z
      .string()
      .nullable()
      .default(null)
      .describe('Target equipment slot. If not specified, auto-detects from item template.'),
  },
  response: '{equip_result}',
  enabled: true,
} satisfies ToolDefinition

export const unequipItemTool = {
  name: 'unequip_item',
  description: `Unequip an item from an equipment slot, returning it to inventory.

**Behavior:**
- The item's passive effects are removed
- Item is added back to inventory`,
  inputSchema: {
    slot: requiredText('slot').describe('Equipment slot to unequip from'),
  },
  response: '{unequip_result}',
  enabled: true,
} satisfies ToolDefinition

export const useItemTool = {
  name: 'use_item',
  description: `Use an item's affordance (action/ability).

**Process:**
1. Check if affordance is off cooldown
2. Check if item has charges remaining (if applicable)
3. Check requirements (stats, flags, items)
4. Apply costs (deduct stats, consume items)
5. Apply effects (stat changes, flag changes, grant items)
6. Update charges and cooldown
7. Remove item if 'remove_self: true'

**Use Cases:**
- Consumables: Use a potion to heal
- Abilities: Cast a spell or use a skill
- Key items: Use a key to unlock a door
- Gifts: Give an item to an NPC for affection bonus`,
  inputSchema: {
    item_id: requiredText('item_id').describe('ID of the item to use'),
    affordance_id: requiredText('affordance_id').describe(
      'ID of the affordance (action) to invoke',
    ),
    context: z
      .record(z.string(), z.unknown())
      .nullable()
      .default(null)
      .describe('Optional context for the action (e.g., target character)'),
  },
  response: '{use_result}',
  enabled: true,
} satisfies ToolDefinition

export const listEquipmentTool = {
  name: 'list_equipment',
  description: `List all currently equipped items and their passive effects.

Returns all equipment slots (defined in world config) with:
- Slot name
- Equipped item name (or empty)
- Passive stat effects from equipped items`,
  inputSchema: {},
  response: '{equipment_list}',
  enabled: true,
} satisfies ToolDefinition

export const ITEM_TOOLS = {
  list_inventory: listInventoryTool,
  list_world_item: listWorldItemTool,
  equip_item: equipItemTool,
  unequip_item: unequipItemTool,
  use_item: useItemTool,
  list_equipment: listEquipmentTool,
} satisfies Record<string, ToolDefinition>

/**
 * The four item tools no MCP server offers. Exported so a test can pin the
 * omission: writing handlers for them breaks that assertion, forcing the
 * decision to be made explicitly rather than drifting in.
 */
export const UNIMPLEMENTED_ITEM_TOOLS = [
  'equip_item',
  'unequip_item',
  'use_item',
  'list_equipment',
] as const
