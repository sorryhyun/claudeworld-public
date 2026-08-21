/**
 * Phase 0 go/no-go spike.
 *
 * Proves, against a live CLI, the four things the Python client pool provides
 * that the migration plan doubted could be reproduced:
 *
 *   1. one subprocess serving multiple turns (streaming-input mode)
 *   2. in-process MCP tools callable across those turns
 *   3. hooks firing and capturing tool input
 *   4. a `Task` sub-agent calling a parent-provided MCP tool
 *
 * Anything less than all four means the pilot cannot be built this way.
 */
import { createSdkMcpServer, tool, type HookCallback, type Options } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { AgentSession } from '../sdk/client/session'
import { buildClaudeEnv, getClaudeCwd } from '../sdk/client/env'

const toolCalls: string[] = []
const hookCalls: string[] = []
const subagentPersists: string[] = []

const gameTools = createSdkMcpServer({
  name: 'action_manager',
  version: '1.0.0',
  tools: [
    tool(
      'narration',
      'Narrate the outcome of the player action to the player.',
      { narrative: z.string().min(1).describe('The narration text shown to the player.') },
      async (args) => {
        toolCalls.push(`narration:${args.narrative.slice(0, 40)}`)
        return { content: [{ type: 'text', text: 'Narration delivered to the player.' }] }
      },
    ),
    tool(
      'roll_the_dice',
      'Roll for a random outcome. Call before narrating an uncertain action.',
      {},
      async () => {
        toolCalls.push('roll_the_dice')
        return { content: [{ type: 'text', text: 'nothing_happened' }] }
      },
    ),
  ],
})

const subagentTools = createSdkMcpServer({
  name: 'subagents',
  version: '1.0.0',
  tools: [
    tool(
      'persist_item',
      'Persist a designed item. The item_designer sub-agent MUST call this.',
      { name: z.string(), description: z.string() },
      async (args) => {
        subagentPersists.push(args.name)
        return { content: [{ type: 'text', text: `Item "${args.name}" persisted.` }] }
      },
    ),
  ],
})

const capturePreToolUse: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {}
  hookCalls.push(input.tool_name)
  return {}
}

const options: Options = {
  model: 'claude-sonnet-5',
  systemPrompt:
    'You are the Action Manager of a text adventure. For every player action you MUST call the ' +
    'mcp__action_manager__narration tool with your narration. Never narrate in plain prose. Be brief.',
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  thinking: { type: 'adaptive', display: 'summarized' },
  mcpServers: { action_manager: gameTools, subagents: subagentTools },
  tools: [
    'mcp__action_manager__narration',
    'mcp__action_manager__roll_the_dice',
    'mcp__subagents__persist_item',
    'Task',
    'TaskOutput',
  ],
  allowedTools: [
    'mcp__action_manager__narration',
    'mcp__action_manager__roll_the_dice',
    'mcp__subagents__persist_item',
    'Task',
    'TaskOutput',
  ],
  agents: {
    item_designer: {
      description: 'Designs a single item and persists it.',
      prompt:
        'You design items for a text adventure. You MUST call mcp__subagents__persist_item ' +
        'with the item you designed. Do not return anything else.',
      tools: ['mcp__subagents__persist_item'],
      model: 'inherit',
    },
  },
  settingSources: [],
  cwd: getClaudeCwd(),
  env: buildClaudeEnv(),
  includePartialMessages: true,
  hooks: { PreToolUse: [{ hooks: [capturePreToolUse] }] },
}

function summarize(label: string, messages: unknown[]): void {
  const kinds = new Map<string, number>()
  for (const m of messages) {
    const t = (m as { type?: string }).type ?? '?'
    const sub = (m as { subtype?: string }).subtype
    const k = sub ? `${t}/${sub}` : t
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
  }
  console.log(`  ${label}: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(', ')}`)
}

async function runTurn(session: AgentSession, label: string, text: string): Promise<void> {
  const seen: unknown[] = []
  let sawStreamEvent = false
  const t0 = Date.now()
  for await (const message of session.runTurn(text)) {
    seen.push(message)
    if ((message as { type?: string }).type === 'stream_event') sawStreamEvent = true
  }
  console.log(`\n[${label}] ${Date.now() - t0}ms, session=${session.sessionId?.slice(0, 8)}`)
  summarize('messages', seen)
  console.log(`  stream_event deltas: ${sawStreamEvent ? 'yes' : 'NO (includePartialMessages broken)'}`)
}

const session = new AgentSession('spike', 'fp-1', undefined, options)

let failures = 0
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

try {
  await runTurn(session, 'turn 1', 'I push open the tavern door and step inside.')
  const afterTurn1 = { tools: [...toolCalls], hooks: [...hookCalls] }

  await runTurn(session, 'turn 2', 'I ask the barkeep about the missing caravan.')

  await runTurn(
    session,
    'turn 3 (subagent)',
    'I find a strange amulet on the floor. Use the Task tool with subagent_type "item_designer" ' +
      'to design the amulet, then narrate what I see.',
  )

  console.log('\n--- results ---')
  check(session.turnsProcessed === 3, `3 turns on one session (got ${session.turnsProcessed})`)
  check(!session.isDead, 'session still alive after 3 turns')
  check(afterTurn1.tools.length > 0, `MCP tool called in turn 1 (${afterTurn1.tools.length})`)
  check(toolCalls.length > afterTurn1.tools.length, `MCP tools callable on later turns (${toolCalls.length} total)`)
  check(hookCalls.length > 0, `PreToolUse hook fired (${hookCalls.length}×: ${[...new Set(hookCalls)].join(', ')})`)
  check(subagentPersists.length > 0, `sub-agent called a parent MCP tool (${subagentPersists.join(', ') || 'none'})`)
  check(session.sessionId !== null, 'session id captured for resume')

  console.log(`\ntool calls: ${toolCalls.join(' | ')}`)
} finally {
  await session.close()
}

console.log(failures === 0 ? '\nGO — all four capabilities confirmed' : `\nNO-GO (${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
