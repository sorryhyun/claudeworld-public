/**
 * Sub-agent telemetry hooks.
 *
 * These exist because of a live finding from `bun run spike` against CLI
 * 2.1.238: the dispatch tool is called **`Agent`**, not `Task`, so a hook that
 * matched only `'Task'` never fired. Nothing failed — `subagent_invoked` simply
 * stopped being emitted and every `subagent_completed` reported
 * `subagentType: 'unknown', matched: false`, which reads as "sub-agents are not
 * being used" rather than as a bug.
 *
 * The callbacks are invoked directly here rather than through a CLI: the
 * matcher string is the CLI's business, but the `tool_name` guard inside the
 * callback is this repository's, and it is the half that regressed.
 */

import { describe, expect, test } from 'bun:test'
import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'

import {
  buildHooks,
  SubagentTimings,
  SUBAGENT_DISPATCH_TOOLS,
  type HookTelemetry,
} from '@/sdk/agent/hooks'

const NO_SIGNAL = { signal: new AbortController().signal }

type HookEventName = 'PreToolUse' | 'SubagentStart' | 'SubagentStop'

function harness() {
  const events: HookTelemetry[] = []
  const timings = new SubagentTimings()
  const hooks = buildHooks(
    { agentName: 'Action_Manager', roomId: 7, onEvent: (event) => events.push(event) },
    timings,
  )

  /** Every callback registered for an event, matcher-independent. */
  const callbacks = (event: HookEventName): HookCallback[] =>
    (hooks?.[event] ?? []).flatMap((entry) => entry.hooks)

  const fire = async (
    event: HookEventName,
    input: Record<string, unknown>,
    toolUseId: string | undefined,
  ): Promise<void> => {
    for (const hook of callbacks(event)) {
      await hook({ hook_event_name: event, ...input } as unknown as HookInput, toolUseId, NO_SIGNAL)
    }
  }

  return { events, timings, hooks, fire }
}

describe('sub-agent dispatch hooks', () => {
  test.each([...SUBAGENT_DISPATCH_TOOLS])('%s dispatch is recorded', async (toolName) => {
    const { events, fire } = harness()
    await fire(
      'PreToolUse',
      { tool_name: toolName, tool_input: { subagent_type: 'item_designer' } },
      'toolu_1',
    )

    expect(events).toContainEqual({
      kind: 'subagent_invoked',
      agentName: 'Action_Manager',
      roomId: 7,
      subagentType: 'item_designer',
      background: false,
    })
  })

  test('the matcher names every dispatch tool the callback accepts', () => {
    // The matcher is a regex over the tool name; if it and the guard inside the
    // callback drift apart, the hook is registered for a tool it then ignores.
    const { hooks } = harness()
    const matchers = (hooks?.PreToolUse ?? []).map((entry) => entry.matcher).filter(Boolean)
    for (const toolName of SUBAGENT_DISPATCH_TOOLS) {
      expect(matchers.some((m) => new RegExp(`^(?:${m as string})$`).test(toolName))).toBe(true)
    }
  })

  test('a background dispatch is reported as such', async () => {
    const { events, fire } = harness()
    await fire(
      'PreToolUse',
      { tool_name: 'Agent', tool_input: { subagent_type: 'location_designer', run_in_background: true } },
      'toolu_2',
    )
    expect(events.find((e) => e.kind === 'subagent_invoked')).toMatchObject({ background: true })
  })

  test('an ordinary tool call is observed but not counted as a dispatch', async () => {
    const { events, fire } = harness()
    await fire('PreToolUse', { tool_name: 'mcp__action_manager__narration', tool_input: {} }, 'toolu_3')

    expect(events.map((e) => e.kind)).toEqual(['tool_used'])
  })

  test('a dispatch with no subagent_type is not recorded', async () => {
    const { events, fire } = harness()
    await fire('PreToolUse', { tool_name: 'Agent', tool_input: {} }, 'toolu_4')
    expect(events.some((e) => e.kind === 'subagent_invoked')).toBe(false)
  })

  test('SubagentStart/Stop pair on agent_id, which is what the CLI sends', async () => {
    // The dispatch's `tool_use_id` and the run's `agent_id` are different ids;
    // pairing on the former is why every completed sub-agent reported
    // `unknown` / `matched: false`.
    const { events, fire } = harness()
    await fire(
      'PreToolUse',
      { tool_name: 'Agent', tool_input: { subagent_type: 'location_designer' } },
      'toolu_dispatch',
    )
    await fire('SubagentStart', { agent_id: 'agent_1', agent_type: 'location_designer' }, undefined)
    await fire(
      'SubagentStop',
      { agent_id: 'agent_1', agent_type: 'location_designer' },
      'agent_1',
    )

    expect(events.find((e) => e.kind === 'subagent_completed')).toMatchObject({
      subagentType: 'location_designer',
      matched: true,
    })
  })

  test('a stop with no start still names what finished', async () => {
    // `agent_type` comes on the stop itself, so losing the pairing costs the
    // duration and nothing else.
    const { events, fire } = harness()
    await fire('SubagentStop', { agent_id: 'agent_9', agent_type: 'item_designer' }, undefined)

    expect(events.find((e) => e.kind === 'subagent_completed')).toMatchObject({
      subagentType: 'item_designer',
      matched: false,
      durationMs: 0,
    })
  })

  test('SubagentStop falls back to pairing on tool_use_id', async () => {
    const { events, fire } = harness()
    await fire(
      'PreToolUse',
      { tool_name: 'Agent', tool_input: { subagent_type: 'character_designer' } },
      'toolu_5',
    )
    await fire('SubagentStop', {}, 'toolu_5')

    expect(events.find((e) => e.kind === 'subagent_completed')).toMatchObject({
      subagentType: 'character_designer',
      matched: true,
    })
  })

  test('an unmatched stop is reported as unmatched rather than guessed at', async () => {
    const { events, fire } = harness()
    await fire('SubagentStop', {}, 'toolu_unknown')

    expect(events.find((e) => e.kind === 'subagent_completed')).toMatchObject({
      subagentType: 'unknown',
      matched: false,
      durationMs: 0,
    })
  })
})
