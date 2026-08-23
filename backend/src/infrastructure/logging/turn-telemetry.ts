/**
 * Adapter from a turn's telemetry callbacks to the logging sinks. They exist so
 * the SDK layer knows nothing about `latency.log` or `debug.txt`; a caller that
 * wants neither (the pilot, a test) simply does not build one.
 */

import type { HookTelemetry } from '@/sdk/agent/hooks'
import type { TurnEvent } from '@/sdk/agent/turn-runner'
import { writeAgentResponseLog } from './agent-log'
import { getLogger } from './logger'
import { getPerfLogger, type PerfLogger } from './perf'

const logger = getLogger('Turn')

export interface TurnTelemetryOptions {
  roomId: number
  perf?: PerfLogger
}

export interface TurnTelemetry {
  /** Takes anything with a name, so this layer does not depend on the ORM type. */
  onEvent: (agent: { name: string }, event: TurnEvent) => void
  onTelemetry: (event: HookTelemetry) => void
  /** Bracket a whole interaction; returns the closing half. */
  interaction: (action: string) => (agentCount: number) => void
}

// Timing is measured per agent, from `stream_start` to `stream_end`.
export function createTurnTelemetry({
  roomId,
  perf = getPerfLogger(),
}: TurnTelemetryOptions): TurnTelemetry {
  const startedAt = new Map<string, number>()

  return {
    onEvent: (agent, event) => {
      if (event.type === 'stream_start') {
        startedAt.set(event.tempId, performance.now())
        return
      }
      if (event.type !== 'stream_end') return

      const started = startedAt.get(event.tempId)
      startedAt.delete(event.tempId)
      if (started !== undefined) {
        perf.log('sdk_response', performance.now() - started, {
          agentName: agent.name,
          roomId,
          extra: {
            skipped: event.skipped,
            interrupted: event.interrupted,
            chars: event.responseText?.length ?? 0,
          },
        })
      }

      if (event.error) logger.warning(`${agent.name} ended in error: ${event.error}`)

      writeAgentResponseLog({
        agentName: agent.name,
        taskId: event.tempId,
        responseText: event.responseText ?? '',
        thinkingText: event.thinkingText,
        skipped: event.skipped,
      })
    },

    onTelemetry: (event) => {
      // Only the completion carries a duration; the rest are marks, and a mark
      // with a fabricated 0ms duration would pollute the phase averages.
      if (event.kind === 'subagent_completed') {
        perf.log('subagent', event.durationMs, {
          agentName: event.agentName,
          roomId: event.roomId,
          extra: { subagent: event.subagentType, matched: event.matched },
        })
        return
      }
      logger.debug(`${event.agentName}: ${event.kind}`)
    },

    interaction: (action) => {
      perf.logInteractionStart(roomId, action)
      const started = performance.now()
      return (agentCount) => perf.logInteractionEnd(roomId, performance.now() - started, agentCount)
    },
  }
}
