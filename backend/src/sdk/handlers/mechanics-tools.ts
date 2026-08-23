import { getAgentByName } from '@/crud/agents'
import { invalidateAgentCache } from '@/crud/cache-invalidation'
import type { AgentConfigService } from '@/services/agent-config-service'
import type { ItemService } from '@/services/item-service'
import type { PlayerService } from '@/services/player-service'
import { advanceTimeTool, changeStatTool, injectMemoryTool } from '@/sdk/tools/gameplay'
import { listInventoryTool, listWorldItemTool } from '@/sdk/tools/item'
import { resolveTool } from '@/sdk/tools/registry'
import { getLogger } from '@/infrastructure/logging/logger'
import type { PlayerMutationsPort } from './ports'
import { tool, requireWorldName, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * Stats, the clock, inventory queries, and implanted memories. The mutating
 * paths go through {@link PlayerMutationsPort} rather than `PlayerService`
 * because each must reach the `player_states` row as well as `player.json`: the
 * polling endpoint reads the row, so a change that only lands on disk is
 * invisible to the player until a full state reload.
 */

const logger = getLogger('GameplayTools.Mechanics')

function preview(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// `add` -> `Add`.
function titleCase(value: string): string {
  return value.replace(/\w+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export interface MechanicsDeps {
  players: PlayerService
  items: ItemService
  agentConfigs: AgentConfigService
  /** Absent means `change_stat` and `advance_time` are not offered. */
  mutations?: PlayerMutationsPort
}

export function createMechanicsTools(ctx: ToolContext, deps: MechanicsDeps): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const tools: SdkTool[] = []

  const injectDef = resolveTool(injectMemoryTool.name, ctx.groupName)
  if (injectDef) {
    tools.push(
      tool(
        injectMemoryTool.name,
        injectDef.description,
        injectMemoryTool.inputSchema,
        async (args) => {
          const { character_name: characterName, memory_entry: memoryEntry } = args
          try {
            const db = ctx.getDb()
            // Exact name, world-scoped, no fuzzy fallback: this writes into
            // another character's head, so the wrong match is worse than a miss.
            const agent = getAgentByName(db, characterName, worldName)
            if (!agent) {
              return toolError(
                `Character '${characterName}' not found. Use list_characters to see available characters.`,
              )
            }
            if (!agent.configFile) {
              return toolError(
                `Character '${agent.name}' does not have a config file for memory storage.`,
              )
            }

            const gameTime = deps.players.loadPlayerState(worldName)?.gameTime ?? null
            const written = deps.agentConfigs.appendToRecentEvents(
              agent.configFile,
              memoryEntry,
              gameTime,
            )

            if (!written) return toolSuccess(`Failed to inject memory into ${agent.name}.`)

            // The DB row caches `recent_events.md`; without this the memory is
            // absent from the character's context until the cache expires.
            invalidateAgentCache(agent.id)

            return toolSuccess(
              `**Memory Injected:**\n- Target: ${agent.name}\n- Memory: ${memoryEntry}\n\n` +
                `${agent.name} now remembers this as if it actually happened.`,
            )
          } catch (error) {
            logger.error(`inject_memory error: ${String(error)}`)
            return toolError(`Error injecting memory: ${String(error)}`)
          }
        },
      ),
    )
  }

  const inventoryDef = resolveTool(listInventoryTool.name, ctx.groupName)
  if (inventoryDef) {
    tools.push(
      tool(
        listInventoryTool.name,
        inventoryDef.description,
        listInventoryTool.inputSchema,
        async () => {
          try {
            const inventory = deps.players.getResolvedInventory(worldName)
            if (inventory.length === 0) return toolSuccess('**Inventory:** Empty')

            const lines = inventory.map((item) => {
              const name = asString(item.name) || 'Unknown'
              const quantity = asNumber(item.quantity, 1)
              let entry = quantity > 1 ? `- **${name}** x${quantity}` : `- **${name}**`
              const description = asString(item.description)
              if (description) entry += `: ${preview(description, 80)}`
              return entry
            })

            return toolSuccess(
              `**Inventory (${inventory.length} items):**\n\n${lines.join('\n')}`,
            )
          } catch (error) {
            logger.error(`list_inventory error: ${String(error)}`)
            return toolError(`Error listing inventory: ${String(error)}`)
          }
        },
      ),
    )
  }

  const worldItemDef = resolveTool(listWorldItemTool.name, ctx.groupName)
  if (worldItemDef) {
    tools.push(
      tool(
        listWorldItemTool.name,
        worldItemDef.description,
        listWorldItemTool.inputSchema,
        async (args) => {
          // Lowercased here and on the compared fields, so caps still match.
          const keyword = args.keyword.trim().toLowerCase()
          try {
            const allItems = deps.items.getAllItemsInWorld(worldName)
            if (allItems.length === 0) {
              return toolSuccess(
                "**World Items:** No items defined in this world's items/ directory.",
              )
            }

            const filterNote = keyword ? ` matching '${keyword}'` : ''
            const shown = keyword
              ? allItems.filter((item) =>
                  [item.name, item.description, item.id].some((field) =>
                    asString(field).toLowerCase().includes(keyword),
                  ),
                )
              : allItems

            if (shown.length === 0) {
              return toolSuccess(`**World Items:** No items found${filterNote}.`)
            }

            const entries = shown.map((item) => {
              const itemId = asString(item.id) || 'unknown'
              const name = asString(item.name) || 'Unknown'
              let entry = `- **${name}** (\`${itemId}\`)`
              const description = asString(item.description)
              if (description) entry += `\n  ${preview(description, 100)}`

              const properties = item.default_properties
              if (properties && Object.keys(properties).length > 0) {
                const rendered = Object.entries(properties)
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join(', ')
                entry += `\n  Properties: ${rendered}`
              }
              return entry
            })

            return toolSuccess(
              `**World Items (${shown.length}${filterNote}):**\n\n${entries.join('\n\n')}`,
            )
          } catch (error) {
            logger.error(`list_world_item error: ${String(error)}`)
            return toolError(`Error listing world items: ${String(error)}`)
          }
        },
      ),
    )
  }

  const mutations = deps.mutations
  if (!mutations) return tools

  const changeStatDef = resolveTool(changeStatTool.name, ctx.groupName)
  if (changeStatDef) {
    tools.push(
      tool(
        changeStatTool.name,
        changeStatDef.description,
        changeStatTool.inputSchema,
        async (args) => {
          try {
            const statChanges = args.stat_changes
            const inventoryChanges = args.inventory_changes

            if (statChanges.length > 0) {
              const changes: Record<string, number> = {}
              for (const change of statChanges) {
                const statName = asString(change.stat_name)
                if (statName) changes[statName] = asNumber(change.delta, 0)
              }
              if (Object.keys(changes).length > 0) mutations.updateStats(worldName, changes)
            }

            // An item may only enter the inventory if a template exists under
            // `items/`; without that the model invents items with no
            // description, properties or equip slot and the UI renders an id.
            // Removal is unguarded on purpose.
            const skipped = new Set<string>()
            for (const change of inventoryChanges) {
              const action = asString(change.action) || 'add'
              const itemId = asString(change.item_id)
              const name = asString(change.name)

              if (action === 'add' && itemId && name) {
                if (!deps.items.loadItemTemplate(worldName, itemId)) {
                  logger.warning(
                    `Item '${itemId}' not found in items/. Use Task with item_designer to create it first.`,
                  )
                  skipped.add(itemId)
                  continue
                }
                mutations.addItem(worldName, {
                  itemId,
                  name,
                  quantity: asNumber(change.quantity, 1),
                  description: asString(change.description) || null,
                  properties:
                    typeof change.properties === 'object' && change.properties !== null
                      ? (change.properties as Record<string, unknown>)
                      : {},
                })
              } else if (action === 'remove' && itemId) {
                mutations.removeItem(worldName, itemId, asNumber(change.quantity, 1))
              }
            }

            let text = `**Changes Applied:**\n${args.summary}`
            if (statChanges.length > 0) {
              text += '\n\n**Stat Changes:**'
              for (const change of statChanges) {
                const delta = asNumber(change.delta, 0)
                text += `\n- ${asString(change.stat_name)}: ${delta >= 0 ? '+' : ''}${delta}`
              }
            }
            if (inventoryChanges.length > 0) {
              text += '\n\n**Inventory Changes:**'
              for (const change of inventoryChanges) {
                const itemId = asString(change.item_id)
                if (skipped.has(itemId)) {
                  text += `\n- ⚠️ SKIPPED: ${asString(change.name)} (item not in items/ directory)`
                } else {
                  text += `\n- ${titleCase(asString(change.action) || 'add')}: ${asString(change.name)} x${asNumber(change.quantity, 1)}`
                }
              }
            }
            if (skipped.size > 0) {
              text +=
                "\n\n**⚠️ Warning:** Some items were skipped because they don't exist " +
                "in the world's items/ directory. Use Task with item_designer " +
                'to create them first.'
            }

            return toolSuccess(text)
          } catch (error) {
            logger.error(`change_stat error: ${String(error)}`)
            return toolError(`Error applying changes: ${String(error)}`)
          }
        },
      ),
    )
  }

  const advanceDef = resolveTool(advanceTimeTool.name, ctx.groupName)
  if (advanceDef) {
    tools.push(
      tool(
        advanceTimeTool.name,
        advanceDef.description,
        advanceTimeTool.inputSchema,
        async (args) => {
          const { minutes, reason } = args
          try {
            const result = mutations.advanceTime(worldName, minutes)
            if (!result) {
              // No player state, or a non-positive delta. Reported as success:
              // an error would make the model retry the whole narration beat.
              return toolSuccess(`**Time Advanced:** +${minutes} minutes\n- Reason: ${reason}`)
            }
            const { newTime } = result
            return toolSuccess(
              `**Time Advanced:** +${minutes} minutes\n` +
                `- Reason: ${reason}\n` +
                `- New time: ${pad2(newTime.hour)}:${pad2(newTime.minute)} (Day ${newTime.day})`,
            )
          } catch (error) {
            logger.error(`advance_time error: ${String(error)}`)
            return toolError(`Error advancing time: ${String(error)}`)
          }
        },
      ),
    )
  }

  return tools
}
