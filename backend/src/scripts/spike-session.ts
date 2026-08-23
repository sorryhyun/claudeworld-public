/**
 * The SDK-behaviour harness (`bun run spike`) — the standing canary for
 * `@anthropic-ai/claude-agent-sdk` upgrades. The SDK is pinned exactly, and
 * every behaviour this backend depends on but cannot unit-test, because it lives
 * in a CLI subprocess, is asserted here. It costs real tokens and needs working
 * Claude Code auth, so it is not part of `bun test`; run it when bumping the pin.
 *
 * | probe | protects |
 * |---|---|
 * | `pin` | the exact-version pin actually being what is installed |
 * | `session` | streaming-input mode: one subprocess, N turns |
 * | `mcp` | MCP tools callable on turns after the first, not just turn 1 |
 * | `hooks` | `PreToolUse` firing, and the *name* of the dispatch tool |
 * | `subagents` | `Options.agents` → dispatch → a parent MCP tool |
 * | `outputFormat` | `outputFormat` → `structured_output` on `result` |
 * | `instructions` | a server's MCP `instructions` reaching the model's context |
 *
 * The `subagents` probe deliberately loads the **real** definitions off
 * `agents/group_subagent/`, so a rename or a broken prompt there fails here
 * rather than in a player's turn.
 */
import { createSdkMcpServer, tool, type HookCallback, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { AgentSession } from '@/sdk/client/session'
import { buildClaudeEnv, getClaudeCwd } from '@/sdk/client/env'
import { buildSubagentDefinitionsForRole } from '@/sdk/agent/subagent-definitions'
import { SUBAGENT_DISPATCH_TOOLS } from '@/sdk/agent/hooks'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

function probePin(): void {
  console.log('\n=== pin ===')
  // The SDK's `exports` map has no `./package.json` entry, so the version is
  // read off the resolved entry point's directory rather than imported.
  const require_ = createRequire(import.meta.url)
  const sdkDir = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk'))
  const installed = String(readJson(join(sdkDir, 'package.json')).version)
  const dependencies = readJson(join(import.meta.dir, '..', '..', 'package.json'))
    .dependencies as Record<string, string>
  const declared = dependencies['@anthropic-ai/claude-agent-sdk'] ?? ''
  check(
    !/^[\^~]/.test(declared),
    `SDK pinned exactly (declared "${declared}")`,
  )
  check(
    declared === installed,
    `installed matches the pin (installed ${installed})`,
  )
  console.log(`  everything below was observed against CLI bundled with ${installed}`)
}

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

// Stand-in for the `subagents` namespace the real turn serves over HTTP. The
// *names* must match production exactly, or the sub-agent is handed a tool that
// does not exist and silently ends up with none.
const subagentTools = createSdkMcpServer({
  name: 'subagents',
  version: '1.0.0',
  tools: [
    tool(
      'persist_item',
      'Persist a designed item template.',
      {
        items: z.array(z.record(z.string(), z.unknown())).min(1),
        add_to_inventory: z.boolean().optional(),
      },
      async (args) => {
        for (const item of args.items) subagentPersists.push(String(item.item_id ?? item.name))
        return { content: [{ type: 'text', text: `${args.items.length} item(s) persisted.` }] }
      },
    ),
    tool(
      'persist_character_design',
      'Persist a designed character.',
      { name: z.string(), role: z.string() },
      async (args) => {
        subagentPersists.push(args.name)
        return { content: [{ type: 'text', text: `Character "${args.name}" persisted.` }] }
      },
    ),
    tool(
      'persist_location_design',
      'Persist a designed location.',
      { name: z.string(), display_name: z.string(), description: z.string() },
      async (args) => {
        subagentPersists.push(args.name)
        return { content: [{ type: 'text', text: `Location "${args.name}" persisted.` }] }
      },
    ),
  ],
})

const capturePreToolUse: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {}
  hookCalls.push(input.tool_name)
  return {}
}

const MCP_TOOLS = [
  'mcp__action_manager__narration',
  'mcp__action_manager__roll_the_dice',
  'mcp__subagents__persist_item',
  'mcp__subagents__persist_character_design',
  'mcp__subagents__persist_location_design',
]

const subagents = buildSubagentDefinitionsForRole('action_manager', MCP_TOOLS)

const SPIKE_TOOLS = [...MCP_TOOLS, ...SUBAGENT_DISPATCH_TOOLS, 'TaskOutput']

function baseOptions(): Options {
  return {
    model: 'claude-sonnet-5',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    settingSources: [],
    cwd: getClaudeCwd(),
    env: buildClaudeEnv(),
    includePartialMessages: true,
  }
}

const gameplayOptions: Options = {
  ...baseOptions(),
  systemPrompt:
    'You are the Action Manager of a text adventure. For every player action you MUST call the ' +
    'mcp__action_manager__narration tool with your narration. Never narrate in plain prose. Be brief.',
  mcpServers: { action_manager: gameTools, subagents: subagentTools },
  tools: SPIKE_TOOLS,
  allowedTools: SPIKE_TOOLS,
  agents: subagents,
  hooks: { PreToolUse: [{ hooks: [capturePreToolUse] }] },
}

function summarize(label: string, messages: SDKMessage[]): void {
  const kinds = new Map<string, number>()
  for (const m of messages) {
    const sub = (m as { subtype?: string }).subtype
    const k = sub ? `${m.type}/${sub}` : m.type
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
  }
  console.log(`  ${label}: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(', ')}`)
}

async function runTurn(session: AgentSession, label: string, text: string): Promise<SDKMessage[]> {
  const seen: SDKMessage[] = []
  let sawStreamEvent = false
  const t0 = Date.now()
  for await (const message of session.runTurn(text)) {
    seen.push(message)
    if (message.type === 'stream_event') sawStreamEvent = true
  }
  console.log(`\n[${label}] ${Date.now() - t0}ms, session=${session.sessionId?.slice(0, 8)}`)
  summarize('messages', seen)
  console.log(`  stream_event deltas: ${sawStreamEvent ? 'yes' : 'NO (includePartialMessages broken)'}`)
  return seen
}

async function probeGameplay(): Promise<void> {
  console.log('\n=== session / mcp / hooks / subagents ===')

  check(
    subagents !== undefined && Object.keys(subagents).length === 3,
    `real sub-agent definitions loaded (${Object.keys(subagents ?? {}).join(', ') || 'none'})`,
  )
  check(
    subagents?.item_designer?.tools?.[0] === 'mcp__subagents__persist_item',
    'item_designer names the persist tool this harness serves',
  )

  const session = new AgentSession('spike', 'fp-1', undefined, gameplayOptions)

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

    console.log('')
    check(session.turnsProcessed === 3, `3 turns on one session (got ${session.turnsProcessed})`)
    check(!session.isDead, 'session still alive after 3 turns')
    check(afterTurn1.tools.length > 0, `MCP tool called in turn 1 (${afterTurn1.tools.length})`)
    check(toolCalls.length > afterTurn1.tools.length, `MCP tools callable on later turns (${toolCalls.length} total)`)
    check(hookCalls.length > 0, `PreToolUse hook fired (${hookCalls.length}×: ${[...new Set(hookCalls)].join(', ')})`)
    // The finding this probe exists for: the dispatch tool is `Agent`, not
    // `Task`. Which one fires is printed, so a future rename shows up here
    // rather than as silently absent telemetry.
    const dispatch = hookCalls.find((name) =>
      (SUBAGENT_DISPATCH_TOOLS as readonly string[]).includes(name),
    )
    check(
      dispatch !== undefined,
      `PreToolUse saw the dispatch tool the telemetry hook matches on (${dispatch ?? 'none of ' + SUBAGENT_DISPATCH_TOOLS.join('/')})`,
    )
    check(
      subagentPersists.length > 0,
      `Task sub-agent called a parent MCP tool (${subagentPersists.join(', ') || 'none'})`,
    )
    check(session.sessionId !== null, 'session id captured for resume')

    console.log(`\ntool calls: ${toolCalls.join(' | ')}`)
  } finally {
    await session.close()
  }
}

// `outputFormat` is plumbed end to end (`AgentOptionsInput` → `Options` →
// `stream-parser` → `TurnEvent.structuredOutput`) but no production caller sets
// it; this probe keeps the plumbing honest until something adopts it.
async function probeOutputFormat(): Promise<void> {
  console.log('\n=== outputFormat ===')

  const schema = {
    type: 'object',
    properties: {
      genre: { type: 'string' },
      theme: { type: 'string' },
    },
    required: ['genre', 'theme'],
    additionalProperties: false,
  }

  const session = new AgentSession('spike-output', 'fp-2', undefined, {
    ...baseOptions(),
    systemPrompt: 'You seed worlds for a text adventure. Answer with the requested fields only.',
    mcpServers: {},
    tools: [],
    allowedTools: [],
    outputFormat: { type: 'json_schema', schema },
  })

  try {
    const seen = await runTurn(session, 'turn 1', 'Seed a world about a drowned lighthouse city.')
    const result = seen.find((m) => m.type === 'result') as
      | (SDKMessage & { structured_output?: unknown })
      | undefined
    const structured = result?.structured_output as Record<string, unknown> | undefined

    check(structured !== undefined, 'result message carried structured_output')
    check(
      typeof structured?.genre === 'string' && typeof structured?.theme === 'string',
      `structured_output matched the schema (${JSON.stringify(structured)})`,
    )
  } finally {
    await session.close()
  }
}

/**
 * Does a server's `instructions` string actually reach the model?
 * `SERVER_INSTRUCTIONS` in `sdk/handlers/servers.ts` relies on CLI internals for
 * that, so this is the behavioural check over them. `createSdkMcpServer` stands
 * in for the stateless HTTP endpoint production uses — the CLI funnels both
 * transports into the same `getInstructions()`. The planted fact is nonsense on
 * purpose: nothing else in the turn could supply it.
 */
const PLANTED = 'Bramblewick'

async function probeInstructions(): Promise<void> {
  console.log('\n=== instructions ===')

  const server = createSdkMcpServer({
    name: 'action_manager',
    version: '1.0.0',
    instructions:
      `The tavern keeper in this world is always named ${PLANTED}. ` +
      'Never call the tavern keeper anything else.',
    tools: [
      tool('roll_the_dice', 'Roll for a random outcome.', {}, async () => ({
        content: [{ type: 'text', text: 'nothing_happened' }],
      })),
    ],
  })

  const session = new AgentSession('spike-instructions', 'fp-3', undefined, {
    ...baseOptions(),
    systemPrompt: 'You are the Action Manager of a text adventure. Answer in one short sentence.',
    mcpServers: { action_manager: server },
    tools: ['mcp__action_manager__roll_the_dice'],
    allowedTools: ['mcp__action_manager__roll_the_dice'],
  })

  try {
    const seen = await runTurn(
      session,
      'turn 1',
      'What is the name of the tavern keeper in this world? Answer with the name only.',
    )
    const text = seen
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => (m as { message: { content: unknown[] } }).message.content)
      .map((block) => (block as { text?: string }).text ?? '')
      .join(' ')

    check(
      text.includes(PLANTED),
      `the server's instructions reached the model (looked for "${PLANTED}" in "${text.trim().slice(0, 80)}")`,
    )
  } finally {
    await session.close()
  }
}

probePin()
await probeGameplay()
await probeOutputFormat()
await probeInstructions()

console.log(failures === 0 ? '\nSPIKE GREEN' : `\nSPIKE RED (${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
