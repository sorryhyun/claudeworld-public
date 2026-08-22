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

/**
 * The CLI's sub-agent dispatch tool, by name.
 *
 * `Agent` is what CLI 2.1.238 calls it (`sdk-tools.d.ts` declares `AgentInput`
 * with the `subagent_type` field, and no `TaskInput` at all); `Task` is the
 * name the early-0.3 CLI used, which every comment in this repository and the
 * Python backend still say. Both are matched because the rename is exactly the
 * kind of silent drift the pin is meant to catch and the telemetry is not worth
 * losing to it: `bun run spike` asserts which one actually fires.
 *
 * This is not cosmetic. Matching only `Task` is why `subagent_invoked` and
 * every sub-agent duration were missing from telemetry — the hook ran, saw
 * `Agent`, and returned.
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

/**
 * Sub-agent start times, keyed by the CLI's `agent_id`.
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

  /**
   * The authoritative start of a sub-agent, keyed by the CLI's own id.
   *
   * `PreToolUse` on the dispatch is the *request*; this is the run. They are
   * keyed differently — the dispatch has a `tool_use_id`, the run has an
   * `agent_id` — and `SubagentStop` is given the latter, which is why pairing a
   * stop against the dispatch's id produced `unknown` / `matched: false` on
   * every completed sub-agent in the pilot.
   */
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
      // The stop carries the type outright, so an unpaired duration no longer
      // costs us the identity of what finished.
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
  // Registered only when there is somewhere to put the result. Python always
  // created the key and sometimes left it an empty array.
  if (context.anthropicCalls) {
    hooks.PostToolUse = [{ matcher: 'mcp__guidelines__anthropic', hooks: [captureAnthropic] }]
  }
  return hooks
}
