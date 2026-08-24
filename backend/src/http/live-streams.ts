/**
 * What a client that connected *late* has to be told before the deltas make
 * sense.
 *
 * `useSSE.ts` only accumulates a delta for an agent it already has an entry
 * for, and the only thing that creates one is `stream_start`. That is fine for
 * a room the player has been sitting in, and wrong for every room a turn starts
 * in before anyone is watching — which is exactly what `POST /worlds/{id}/enter`
 * does: it mints a fresh room, writes the arrival line, hands the opening turn
 * to a background task, and answers. The client learns the new room id from the
 * response, so its `EventSource` cannot be up before the turn is; `stream_start`
 * is broadcast to nobody, and every `thinking_delta` and `narration_delta` that
 * follows is dropped on arrival. The player watches an empty room for the whole
 * turn and concludes the app is broken.
 *
 * So the fan-out keeps the state a `stream_start` would have established, and
 * {@link LiveStreamRegistry.snapshot} replays it as the `catch_up` event
 * `useSSE.ts` has always listened for. Recording happens on the *mapped* SSE
 * event rather than the raw turn event, so a snapshot holds exactly what a
 * client connected the whole time would hold — a hidden agent's suppressed
 * prose never reaches this either.
 *
 * Transient by design: a restart forgets it, as it forgets the turn.
 */

import type { SseEvent } from '@/infrastructure/sse'

/** One agent's in-flight response, as the client would have accumulated it. */
export interface LiveStream {
  agentId: number
  agentName: string
  tempId: string
  thinkingText: string
  responseText: string
  narrationText: string
}

/**
 * Per accumulator, not per stream. A runaway generation must not grow this
 * without bound; the tail is what a late joiner would have seen anyway, and the
 * persisted message carries the whole thing once the turn saves it.
 */
const MAX_TEXT = 64 * 1024

function append(existing: string, delta: string): string {
  const joined = existing + delta
  return joined.length <= MAX_TEXT ? joined : joined.slice(joined.length - MAX_TEXT)
}

export class LiveStreamRegistry {
  private readonly byRoom = new Map<number, Map<number, LiveStream>>()

  /**
   * Fold one broadcast event into the room's state. Call it with the event that
   * actually goes on the wire, immediately before broadcasting it.
   */
  record(roomId: number, event: SseEvent): void {
    const agentId = event.agent_id
    if (typeof agentId !== 'number') return

    if (event.type === 'stream_start') {
      const room = this.byRoom.get(roomId) ?? new Map<number, LiveStream>()
      room.set(agentId, {
        agentId,
        agentName: typeof event.agent_name === 'string' ? event.agent_name : '',
        tempId: typeof event.temp_id === 'string' ? event.temp_id : '',
        thinkingText: '',
        responseText: '',
        narrationText: '',
      })
      this.byRoom.set(roomId, room)
      return
    }

    if (event.type === 'stream_end') {
      const room = this.byRoom.get(roomId)
      if (!room) return
      room.delete(agentId)
      if (room.size === 0) this.byRoom.delete(roomId)
      return
    }

    const stream = this.byRoom.get(roomId)?.get(agentId)
    if (!stream) return
    const delta = typeof event.delta === 'string' ? event.delta : ''
    if (delta === '') return

    switch (event.type) {
      case 'thinking_delta':
        stream.thinkingText = append(stream.thinkingText, delta)
        break
      case 'content_delta':
        stream.responseText = append(stream.responseText, delta)
        break
      case 'narration_delta':
        stream.narrationText = append(stream.narrationText, delta)
        break
    }
  }

  /**
   * Everything currently mid-stream in a room. Must be read in the same tick as
   * {@link EventBroadcaster.subscribe}: later and a delta is counted twice,
   * earlier and one is lost.
   */
  snapshot(roomId: number): LiveStream[] {
    const room = this.byRoom.get(roomId)
    return room ? [...room.values()].map((stream) => ({ ...stream })) : []
  }

  /** A turn that died without a `stream_end` must not strand a typing bubble. */
  clearRoom(roomId: number): void {
    this.byRoom.delete(roomId)
  }
}
