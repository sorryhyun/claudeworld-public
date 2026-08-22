import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'

/**
 * SDK hooks. None change what the model may do — every one returns `{}`,
 * meaning "proceed". They observe: timings, and the tool input a turn reports.
 */

/**
 * The CLI's sub-agent dispatch tool. 2.1.238 calls it `Agent`; older CLIs said
 * `Task`. Both are matched — matching only `Task` is why `subagent_invoked` and
 * every sub-agent duration silently vanished. `bun run spike` asserts which
 * one actually fires.
 */
export const SUBAGENT_DISPATCH_TOOLS = ['Agent', 'Task'] as const

/** Regex form for `HookCallbackMatcher.matcher`, which matches on tool name. */
const SUBAGENT_DISPATCH_MATCHER = SUBAGENT_DISPATCH_TOOLS.join('|')

function isSubagentDispatch(toolName: string): boolean {
  return (SUBAGENT_DISPATCH_TOOLS as readonly string[]).includes(toolName)
}

/** Timing for a sub-agent invocation, from PreToolUse to SubagentStop. */
interface SubagentStart {
  startedAt: number
  parentAgent: string
  roomId: number
  subagentType: string
}

// Keyed by the CLI's `agent_id`. This is telemetry, so an unmatched stop is
// recorded as unmatched rather than guessed at.
export class SubagentTimings {
  private readonly starts = new Map<string, SubagentStart>()

  /** Entries older than this are swept; a sub-agent that never stops must not leak. */
  private static readonly MAX_AGE_MS = 300_000

  record(id: string, start: SubagentStart): void {
    this.sweep()
    this.starts.set(id, start)
  }

  take(id: string | undefined): SubagentStart | null {
    if (!id) return null
    const found = this.starts.get(id)
    if (found) this.starts.delete(id)
    return found ?? null
  }

  private sweep(): void {
    const cutoff = Date.now() - SubagentTimings.MAX_AGE_MS
    for (const [id, start] of this.starts) {
      if (start.startedAt < cutoff) this.starts.delete(id)
    }
  }
}

export interface HookContext {
  agentName: string
  roomId: number
  /** Owned by the turn, so its lifetime is one turn by construction. */
  anthropicCalls?: { push(situation: string): void }
  onEvent?: (event: HookTelemetry) => void
}

export type HookTelemetry =
  | { kind: 'prompt_submitted'; agentName: string; roomId: number; promptChars: number }
  | { kind: 'tool_used'; agentName: string; roomId: number; toolName: string }
  | { kind: 'subagent_invoked'; agentName: string; roomId: number; subagentType: string; background: boolean }
  | {
      kind: 'subagent_completed'
      agentName: string
      roomId: number
      subagentType: string
      durationMs: number
      matched: boolean
    }

export function buildHooks(context: HookContext, timings: SubagentTimings): Options['hooks'] {
  const promptSubmit: HookCallback = async (input) => {
    if (input.hook_event_name !== 'UserPromptSubmit') return {}
    context.onEvent?.({
      kind: 'prompt_submitted',
      agentName: context.agentName,
      roomId: context.roomId,
      // Characters, not tokens.
      promptChars: typeof input.prompt === 'string' ? input.prompt.length : 0,
    })
    return {}
  }

  const captureAnthropic: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {}
    if (!input.tool_name.endsWith('__anthropic')) return {}
    const situation = (input.tool_input as { situation?: unknown } | undefined)?.situation
    if (typeof situation === 'string' && situation) context.anthropicCalls?.push(situation)
    return {}
  }

  // Every tool call, not just dispatches.
  const observeTool: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    context.onEvent?.({
      kind: 'tool_used',
      agentName: context.agentName,
      roomId: context.roomId,
      toolName: input.tool_name,
    })
    return {}
  }

  const preTask: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== 'PreToolUse' || !isSubagentDispatch(input.tool_name)) return {}
    const toolInput = input.tool_input as { subagent_type?: unknown; run_in_background?: unknown } | undefined
    const subagentType = toolInput?.subagent_type
    if (typeof subagentType !== 'string' || !subagentType) return {}

    if (toolUseId) {
      timings.record(toolUseId, {
        startedAt: Date.now(),
        parentAgent: context.agentName,
        roomId: context.roomId,
        subagentType,
      })
    }
    context.onEvent?.({
      kind: 'subagent_invoked',
      agentName: context.agentName,
      roomId: context.roomId,
      subagentType,
      background: toolInput?.run_in_background === true,
    })
    return {}
  }

  // The authoritative start. `PreToolUse` on the dispatch is the *request* and
  // carries a `tool_use_id`; the run carries an `agent_id`, which is what
  // `SubagentStop` is given — pairing against the dispatch id never matches.
  const subagentStart: HookCallback = async (input) => {
    if (input.hook_event_name !== 'SubagentStart') return {}
    timings.record(input.agent_id, {
      startedAt: Date.now(),
      parentAgent: context.agentName,
      roomId: context.roomId,
      subagentType: input.agent_type,
    })
    return {}
  }

  const subagentStop: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== 'SubagentStop') return {}
    // `agent_id` first; the dispatch's `tool_use_id` is the fallback for a CLI
    // that does not emit `SubagentStart`, where the two ids coincide.
    const start = timings.take(input.agent_id) ?? timings.take(toolUseId)
    context.onEvent?.({
      kind: 'subagent_completed',
      agentName: context.agentName,
      roomId: context.roomId,
      // The stop carries the type, so an unpaired duration still names what
      // finished.
      subagentType: input.agent_type || start?.subagentType || 'unknown',
      durationMs: start ? Date.now() - start.startedAt : 0,
      matched: start !== null,
    })
    return {}
  }

  const hooks: Options['hooks'] = {
    UserPromptSubmit: [{ hooks: [promptSubmit] }],
    PreToolUse: [
      { hooks: [observeTool] },
      { matcher: SUBAGENT_DISPATCH_MATCHER, hooks: [preTask] },
    ],
    SubagentStart: [{ hooks: [subagentStart] }],
    SubagentStop: [{ hooks: [subagentStop] }],
  }
  // Registered only when there is somewhere to put the result.
  if (context.anthropicCalls) {
    hooks.PostToolUse = [{ matcher: 'mcp__guidelines__anthropic', hooks: [captureAnthropic] }]
  }
  return hooks
}
