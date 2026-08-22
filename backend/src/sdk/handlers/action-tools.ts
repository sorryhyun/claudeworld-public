import type { AgentConfigService } from '../../services/agent-config-service'
import type { PlayerService } from '../../services/player-service'
import { formatTemplate } from '../tools/definitions'
import { memorizeTool, recallTool, skipTool } from '../tools/action'
import { resolveTool } from '../tools/registry'
import { tool, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * The tools every character has: decline to speak, write a memory, read one.
 * Port of `sdk/handlers/action_tools.py`.
 */

export interface ActionDeps {
  /**
   * Owns the write to `recent_events.md`.
   *
   * Phase 0 inlined an `appendFileSync` here and emitted `- entry\n`. That is
   * wrong in two ways the service gets right: entries carry a *leading*
   * newline, so they are blank-line separated the way Python's are, and the
   * in-world timestamp is formatted as `- [Day 3, 14:05] …` rather than
   * whatever a caller-supplied label happened to say.
   */
  agentConfigs: AgentConfigService
  /** Source of the in-world clock a memory is stamped with. */
  players?: PlayerService
  /** Drops the cached agent config so the new memory is visible next turn. */
  invalidateAgentConfig?: (agentId: number) => void
}

/**
 * Fill an agent's name and memory list into a description template.
 *
 * The description is what tells a character which memories it has, so it is
 * per-agent text rather than a constant — `recall`'s description literally lists
 * the subtitles this character can ask for.
 */
function describe(template: string, ctx: ToolContext): string {
  return formatTemplate(template, {
    agent_name: ctx.agentName,
    memory_subtitles: Object.keys(ctx.longTermMemoryIndex)
      .map((s) => `'${s}'`)
      .join(', '),
  })
}

export function createActionTools(ctx: ToolContext, deps: ActionDeps): SdkTool[] {
  const tools: SdkTool[] = []

  // Resolved through the registry so a `group_config.yaml` override of the
  // description or the response text reaches the model, and so a group that
  // disables a tool — `group_gameplay` disables all three — is honoured here
  // rather than only in the allowed-tools list.
  const skipDef = resolveTool('skip', ctx.groupName)
  const memorizeDef = resolveTool('memorize', ctx.groupName)
  const recallDef = resolveTool('recall', ctx.groupName)

  if (skipDef) {
    tools.push(
      tool(skipTool.name, describe(skipDef.description, ctx), skipTool.inputSchema, async () =>
        // No side effect at all. The signal is the call itself: the stream parser
        // notices the tool use and the turn is reported as skipped.
        toolSuccess(skipDef.response ?? ''),
      ),
    )
  }

  if (memorizeDef) {
    tools.push(
      tool(
        memorizeTool.name,
        describe(memorizeDef.description, ctx),
        memorizeTool.inputSchema,
        async (args) => {
          const entry = args.memory_entry

          // Python's fallback when the agent has no config folder: the memory is
          // acknowledged and dropped, rather than the call failing. A character
          // with no folder on disk is a database row without a home, and the
          // turn should still finish.
          if (!ctx.configFile) {
            return toolSuccess(`Memory noted (no config file): ${entry}`)
          }

          const gameTime = ctx.worldName
            ? (deps.players?.loadPlayerState(ctx.worldName)?.gameTime ?? null)
            : null

          const written = deps.agentConfigs.appendToRecentEvents(ctx.configFile, entry, gameTime)
          if (!written) return toolSuccess(`Failed to record memory: ${entry}`)

          if (ctx.agentId !== undefined) deps.invalidateAgentConfig?.(ctx.agentId)
          return toolSuccess(formatTemplate(memorizeDef.response ?? '', { memory_entry: entry }))
        },
      ),
    )
  }

  // Offered only to characters that have memories. A `recall` tool with nothing
  // to recall is an invitation to call it and be told no.
  if (recallDef && Object.keys(ctx.longTermMemoryIndex).length > 0) {
    tools.push(
      tool(
        recallTool.name,
        describe(recallDef.description, ctx),
        recallTool.inputSchema,
        async (args) => {
          const subtitle = args.subtitle
          const content = ctx.longTermMemoryIndex[subtitle]
          if (content === undefined) {
            const available = Object.keys(ctx.longTermMemoryIndex)
              .map((s) => `'${s}'`)
              .join(', ')
            // Success, not an error: Python returns a plain `RecallOutput` here,
            // and the difference is visible to the model — an `is_error` result
            // reads as a broken tool, where this reads as "ask for one of these".
            return toolSuccess(
              `Memory subtitle '${subtitle}' not found. Available subtitles: ${available}`,
            )
          }
          return toolSuccess(
            formatTemplate(recallDef.response ?? '{memory_content}', { memory_content: content }),
          )
        },
      ),
    )
  }

  return tools
}
