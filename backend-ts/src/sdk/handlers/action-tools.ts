import { tool } from '@anthropic-ai/claude-agent-sdk'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatTemplate } from '../tools/definitions'
import { memorizeTool, recallTool, skipTool } from '../tools/action'
import { toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * The tools every character has: decline to speak, write a memory, read one.
 * Port of `sdk/handlers/action_tools.py`.
 */

export interface ActionDeps {
  /** Absolute path of the agent's config directory; where memories are written. */
  configDir: string
  /** Stamped onto a memory so a character remembers *when* something happened. */
  gameTimeLabel?: () => string
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

export function createActionTools(
  ctx: ToolContext,
  deps: ActionDeps,
): SdkTool[] {
  const tools: SdkTool[] = []

  const skip = tool(skipTool.name, describe(skipTool.description, ctx), skipTool.inputSchema, async () =>
    // No side effect at all. The signal is the call itself: the stream parser
    // notices the tool use and the turn is reported as skipped.
    toolSuccess(skipTool.response ?? ''),
  )

  const memorize = tool(
    memorizeTool.name,
    describe(memorizeTool.description, ctx),
    memorizeTool.inputSchema,
    async (args) => {
      const entry = args.memory_entry
      const stamp = deps.gameTimeLabel?.()
      const line = stamp ? `- [${stamp}] ${entry}\n` : `- ${entry}\n`
      try {
        // Appended to the filesystem, which is the source of truth for agent
        // config; the DB copy is a cache and is refreshed from here.
        appendFileSync(join(deps.configDir, 'recent_events.md'), line, 'utf8')
      } catch (error) {
        return toolError(`Could not record that memory: ${String(error)}`)
      }
      if (ctx.agentId !== undefined) deps.invalidateAgentConfig?.(ctx.agentId)
      return toolSuccess(formatTemplate(memorizeTool.response ?? '', { memory_entry: entry }))
    },
  )

  tools.push(skip, memorize)

  // Offered only to characters that have memories. A `recall` tool with nothing
  // to recall is an invitation to call it and be told no.
  if (Object.keys(ctx.longTermMemoryIndex).length > 0) {
    const recall = tool(
      recallTool.name,
      describe(recallTool.description, ctx),
      recallTool.inputSchema,
      async (args) => {
        const subtitle = args.subtitle
        const content = ctx.longTermMemoryIndex[subtitle]
        if (content === undefined) {
          const available = Object.keys(ctx.longTermMemoryIndex).join(', ')
          return toolError(`No memory titled "${subtitle}". Available memories: ${available}`)
        }
        return toolSuccess(formatTemplate(recallTool.response ?? '{memory_content}', { memory_content: content }))
      },
    )
    tools.push(recall)
  }

  return tools
}
