import type { ItemService } from '../../services/item-service'
import type { PlayerService } from '../../services/player-service'
import { persistItemTool } from '../tools/subagent'
import type { ItemDefinitionInput } from '../tools/subagent'
import { resolveTool } from '../tools/registry'
import { getLogger } from '../../infrastructure/logging/logger'
import type { PlayerMutationsPort } from './ports'
import { tool, requireWorldName, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * `persist_item` — the Item Designer sub-agent's callback. Batched on purpose:
 * onboarding creates a dozen starting items and one call each would be a dozen
 * round trips. An existing id is skipped and reported, never overwritten — the
 * designer runs repeatedly and must not rewrite an author's edits.
 */

const logger = getLogger('GameplayTools.Item')

/** Drop `null`-valued keys, so an absent field is absent rather than explicit. */
function stripNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null))
}

export interface ItemToolDeps {
  items: ItemService
  players: PlayerService
  /**
   * Present during gameplay, absent for a bare sub-agent context. Without it
   * the inventory append is filesystem-only, which onboarding's item designer
   * needs: it runs before the world has a room to sync against.
   */
  mutations?: PlayerMutationsPort
}

export function createItemTools(ctx: ToolContext, deps: ItemToolDeps): SdkTool[] {
  const worldName = requireWorldName(ctx)

  const def = resolveTool(persistItemTool.name, ctx.groupName)
  if (!def) return []

  return [
    tool(
      persistItemTool.name,
      def.description,
      persistItemTool.inputSchema,
      async (args) => {
        const created: ItemDefinitionInput[] = []
        const skipped: string[] = []
        const inventoryAdded: string[] = []

        try {
          for (const item of args.items) {
            if (deps.items.loadItemTemplate(worldName, item.item_id)) {
              skipped.push(item.item_id)
              logger.warning(`Item '${item.item_id}' already exists, skipping`)
              continue
            }

            deps.items.saveItemTemplate(worldName, {
              itemId: item.item_id,
              name: item.name,
              description: item.description,
              properties: item.properties,
              category: item.category ?? null,
              tags: item.tags ?? null,
              rarity: item.rarity ?? null,
              icon: item.icon ?? null,
              stacking: item.stacking ?? null,
              // `Equippable`'s optional fields are `T | undefined`, never
              // `T | null`: the item service tests them for absence, so a
              // written-out `accepts_as: null` would read as present.
              equippable: item.equippable ? stripNulls(item.equippable) : null,
              usable: item.usable ?? null,
            })
            created.push(item)
          }

          if (args.add_to_inventory && created.length > 0) {
            if (deps.mutations) {
              for (const item of created) {
                deps.mutations.addItem(worldName, {
                  itemId: item.item_id,
                  name: item.name,
                  quantity: item.quantity,
                  description: item.description,
                  properties: item.properties,
                })
                inventoryAdded.push(`${item.quantity}x ${item.name}`)
              }
            } else {
              const state = deps.players.loadPlayerState(worldName)
              if (state) {
                for (const item of created) {
                  // Reference form only — the template just created carries the
                  // name and description.
                  state.inventory.push({ item_id: item.item_id, quantity: item.quantity })
                  inventoryAdded.push(`${item.quantity}x ${item.name}`)
                }
                deps.players.savePlayerState(worldName, state)
              } else {
                logger.warning('Could not load player state to add items to inventory')
              }
            }
          }

          const parts: string[] = []

          if (created.length > 0) {
            parts.push(`**Created ${created.length} item(s):**`)
            for (const item of created) {
              let line = `- \`${item.item_id}\`: ${item.name}`
              if (Object.keys(item.properties).length > 0) {
                const props = Object.entries(item.properties)
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(', ')
                line += ` (${props})`
              }
              parts.push(line)
            }
          }

          if (skipped.length > 0) {
            parts.push(`\n**Skipped ${skipped.length} (already exist):** ${skipped.join(', ')}`)
          }

          if (inventoryAdded.length > 0) {
            parts.push(`\n**Added to inventory:** ${inventoryAdded.join(', ')}`)
          } else if (args.add_to_inventory && created.length === 0) {
            parts.push('\n⚠️ No items added to inventory (all items already existed)')
          } else if (!args.add_to_inventory && created.length > 0) {
            parts.push('\nAction Manager can add these items to inventory via change_stat.')
          }

          return toolSuccess(parts.join('\n'))
        } catch (error) {
          logger.error(`persist_item error: ${String(error)}`)
          return toolError(`Error creating items: ${String(error)}`)
        }
      },
    ),
  ]
}
