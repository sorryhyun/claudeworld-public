/**
 * Turn events → the SSE wire format `frontend/src/hooks/useSSE.ts` listens for:
 * `stream_start` {agent_id, agent_name, temp_id}, the three `*_delta`s
 * {temp_id, delta}, and `stream_end` {temp_id, skipped}, which clears the
 * client's typing bubble. The shape is the one `agent_manager.py` broadcast
 * before the port — the frontend was built against it.
 */

import type { Agent } from '../db/schema'
import type { SseEvent } from '../infrastructure/sse'
import type { TurnEvent } from '../sdk/agent/turn-runner'
import type { TurnEventMeta } from '../orchestration/turn'

/** `null` when the event must not reach clients: a hidden agent's prose
 * (NPC reactions, the Action Manager's tool discussion) stays on the server,
 * while its thinking and narration stream — the game UI shows both. */
export function turnEventToSse(
  agent: Agent,
  event: TurnEvent,
  meta: TurnEventMeta,
): SseEvent | null {
  switch (event.type) {
    case 'stream_start':
      return {
        type: 'stream_start',
        agent_id: agent.id,
        agent_name: agent.name,
        temp_id: event.tempId,
      }
    case 'content_delta':
      if (meta.hidden) return null
      return { type: 'content_delta', agent_id: agent.id, temp_id: event.tempId, delta: event.delta }
    case 'thinking_delta':
      return { type: 'thinking_delta', agent_id: agent.id, temp_id: event.tempId, delta: event.delta }
    case 'narration_delta':
      return { type: 'narration_delta', agent_id: agent.id, temp_id: event.tempId, delta: event.delta }
    case 'stream_end':
      return { type: 'stream_end', agent_id: agent.id, temp_id: event.tempId, skipped: event.skipped }
  }
}
