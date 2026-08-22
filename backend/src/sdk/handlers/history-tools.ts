import type { WorldService } from '../../services/world-service'
import { formatTemplate } from '../tools/definitions'
import { recallHistoryTool } from '../tools/gameplay'
import { resolveTool } from '../tools/registry'
import { tool, requireWorldName, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * Reading back the compressed world history.
 * Port of `sdk/handlers/history_tools.py`.
 *
 * The whole tool is conditional on there being history to read. That is not a
 * courtesy: the description *lists the available subtitles*, so with none the
 * model is handed a tool advertising an empty set, calls it to find out what is
 * there, and burns a turn learning nothing. Python returns an empty tool list in
 * that case and so does this.
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
          // An error result here, unlike `recall`'s miss, which Python reports as
          // a success. The asymmetry is Python's and is reproduced: the history
          // index is generated, so a subtitle the model made up is a mistake it
          // should see flagged, where a character's memory index is authored and
          // a near-miss is an ordinary conversational fumble.
          return toolError(`History entry '${subtitle}' not found. Available entries: ${quoted}`)
        }

        return toolSuccess(
          formatTemplate(def.response || '{history_content}', { history_content: content }),
        )
      },
    ),
  ]
}
