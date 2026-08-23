import type { WorldService } from '@/services/world-service'
import { formatTemplate } from '@/sdk/tools/definitions'
import { recallHistoryTool } from '@/sdk/tools/gameplay'
import { resolveTool } from '@/sdk/tools/registry'
import { tool, requireWorldName, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * Reading back the compressed world history. The tool is offered only when there
 * is history to read: its description *lists the available subtitles*, so with
 * none the model gets a tool advertising an empty set and burns a turn on it.
 */

export interface HistoryDeps {
  worlds: WorldService
}

export function createHistoryTools(ctx: ToolContext, deps: HistoryDeps): SdkTool[] {
  const worldName = requireWorldName(ctx)

  const subtitles = deps.worlds.getHistorySubtitles(worldName)
  if (subtitles.length === 0) return []

  const def = resolveTool(recallHistoryTool.name, ctx.groupName)
  if (!def) return []

  const quoted = subtitles.map((s) => `'${s}'`).join(', ')

  return [
    tool(
      recallHistoryTool.name,
      formatTemplate(def.description, { history_subtitles: quoted }),
      recallHistoryTool.inputSchema,
      async (args) => {
        const { subtitle } = args
        const content = deps.worlds.getHistoryBySubtitle(worldName, subtitle)

        if (content === null) {
          // An error, unlike `recall`'s miss: the history index is generated, so
          // an invented subtitle is a mistake the model should see flagged.
          return toolError(`History entry '${subtitle}' not found. Available entries: ${quoted}`)
        }

        return toolSuccess(
          formatTemplate(def.response || '{history_content}', { history_content: content }),
        )
      },
    ),
  ]
}
