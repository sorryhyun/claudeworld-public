import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'

/**
 * SDK hooks. Port of `sdk/agent/hooks.py`.
 *
 * None of these change what the model may do — every one returns an empty
 * result, meaning "proceed". They exist to observe: three record timings, and
 * one captures tool input the turn needs to report back.
 *
 * The Python versions returned `{"continue_": True}`; the TS field is spelled
 * `continue`, and omitting it entirely means the same thing. They are returned
 * as `{}` here so the no-op is obvious.
 */

/** Timing for a `Task` sub-agent invocation, from PreToolUse to SubagentStop. */
interface SubagentStart {
  startedAt: number
  parentAgent: string
  roomId: number
  subagentType: string
}

/**
 * Sub-agent start times, keyed by `tool_use_id`.
 *
 * Python also kept a `${roomId}:${subagentType}` composite key as a fallback
 * and scanned it when the id was missing, which mismatched whenever a room ran
 * two sub-agents of the same type at once. Since this is telemetry, an
 * unmatched stop is recorded as unmatched rather than guessed at.
 */
export class SubagentTimings {
  private readonly starts = new Map<string, SubagentStart>()

  /** Entries older than this are swept; a sub-agent that never stops must not leak. */
  private static readonly MAX_AGE_MS = 300_000

  record(toolUseId: string, start: SubagentStart): void {
    this.sweep()
    this.starts.set(toolUseId, start)
  }

  take(toolUseId: string | undefined): SubagentStart | null {
    if (!toolUseId) return null
    const found = this.starts.get(toolUseId)
    if (found) this.starts.delete(toolUseId)
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
  /**
   * Collector for `mcp__guidelines__anthropic` calls made during the turn.
   *
   * Python passed a bare list into the options builder, closed over it in the
   * hook, and read it back after the stream ended — invisible coupling through
   * a mutable default argument. Here the collector is an explicit object the
   * turn owns, so its lifetime is one turn by construction.
   */
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
      // Characters, not tokens — Python's field name said so explicitly.
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

  // Every tool call, not just Task. Python logged this through the perf logger;
  // keeping it on the telemetry channel means a caller that wants to know which
  // tools an agent actually reached for does not have to parse a log file.
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
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Task') return {}
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

  const subagentStop: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== 'SubagentStop') return {}
    const start = timings.take(toolUseId)
    context.onEvent?.({
      kind: 'subagent_completed',
      agentName: context.agentName,
      roomId: context.roomId,
      subagentType: start?.subagentType ?? 'unknown',
      durationMs: start ? Date.now() - start.startedAt : 0,
      matched: start !== null,
    })
    return {}
  }

  const hooks: Options['hooks'] = {
    UserPromptSubmit: [{ hooks: [promptSubmit] }],
    PreToolUse: [{ hooks: [observeTool] }, { matcher: 'Task', hooks: [preTask] }],
    SubagentStop: [{ hooks: [subagentStop] }],
  }
  // Registered only when there is somewhere to put the result. Python always
  // created the key and sometimes left it an empty array.
  if (context.anthropicCalls) {
    hooks.PostToolUse = [{ matcher: 'mcp__guidelines__anthropic', hooks: [captureAnthropic] }]
  }
  return hooks
}
