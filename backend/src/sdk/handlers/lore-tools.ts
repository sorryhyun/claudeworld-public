import { getLogger } from '@/infrastructure/logging/logger'
import type { WorldService } from '@/services/world-service'
import { resolveTool } from '@/sdk/tools/registry'
import { addWorldLoreTool } from '@/sdk/tools/subagent'
import { composeLore, splitLore, upsertAddition } from './lore-sections'
import { requireWorldName, tool, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * The one write into `lore.md` that is *not* the Onboarding Manager's. Offered
 * on the `subagents` server, so every designer — and the agent that dispatched
 * it — can extend the world it is designing for instead of only adding rows to
 * it. See `lore-sections.ts` for why the region is separate from the body.
 */

const logger = getLogger('LoreTools')

export interface LoreToolDeps {
  worlds: WorldService
}

export function createLoreContributionTools(ctx: ToolContext, deps: LoreToolDeps): SdkTool[] {
  const worldName = requireWorldName(ctx)

  const definition = resolveTool(addWorldLoreTool.name, ctx.groupName)
  if (!definition) return []

  return [
    tool(
      addWorldLoreTool.name,
      definition.description,
      addWorldLoreTool.inputSchema,
      async (args) => {
        try {
          // Read, edit and write with no `await` between them: concurrent
          // designers each run this block to completion, so the last writer
          // merges rather than clobbers. An `await` here reintroduces the race.
          const sections = splitLore(deps.worlds.loadLore(worldName))
          const { additions, replaced } = upsertAddition(
            sections.additions,
            args.title,
            args.content,
          )
          deps.worlds.saveLore(worldName, composeLore({ ...sections, additions }))

          logger.info(
            `${ctx.agentName} ${replaced ? 'rewrote' : 'added'} lore section ` +
              `'${args.title}' in world '${worldName}'`,
          )
          return toolSuccess(
            replaced
              ? `Lore section '${args.title}' rewritten (${args.content.length} characters).`
              : `Lore section '${args.title}' added (${args.content.length} characters).`,
          )
        } catch (error) {
          logger.error(`Failed to add world lore: ${String(error)}`)
          return toolError(`Error writing world lore: ${String(error)}`)
        }
      },
    ),
  ]
}
