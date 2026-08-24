/**
 * The state a late-connecting client is replayed.
 *
 * The bug this exists for: `POST /worlds/{id}/enter` mints a room, hands the
 * opening turn to a background task and answers, so `stream_start` is broadcast
 * before the client can possibly have subscribed to a room whose id it learns
 * from that answer. `useSSE.ts` drops every delta for an agent it has no bubble
 * for, so the whole opening scene streamed into nothing.
 */

import { describe, expect, test } from 'bun:test'

import { LiveStreamRegistry } from '@/http/live-streams'

function start(registry: LiveStreamRegistry, roomId: number, agentId = 2): void {
  registry.record(roomId, {
    type: 'stream_start',
    agent_id: agentId,
    agent_name: 'Action_Manager',
    temp_id: `temp_room_${roomId}_agent_${agentId}_0`,
  })
}

describe('LiveStreamRegistry', () => {
  test('a snapshot holds what a client connected the whole time would hold', () => {
    const registry = new LiveStreamRegistry()
    start(registry, 10)
    registry.record(10, { type: 'thinking_delta', agent_id: 2, delta: 'weighing ' })
    registry.record(10, { type: 'thinking_delta', agent_id: 2, delta: 'the room' })
    registry.record(10, { type: 'narration_delta', agent_id: 2, delta: 'Wednesday, ' })
    registry.record(10, { type: 'narration_delta', agent_id: 2, delta: 'nine at night.' })
    registry.record(10, { type: 'content_delta', agent_id: 2, delta: 'tool talk' })

    expect(registry.snapshot(10)).toEqual([
      {
        agentId: 2,
        agentName: 'Action_Manager',
        tempId: 'temp_room_10_agent_2_0',
        thinkingText: 'weighing the room',
        responseText: 'tool talk',
        narrationText: 'Wednesday, nine at night.',
      },
    ])
  })

  test('an empty room snapshots to nothing', () => {
    expect(new LiveStreamRegistry().snapshot(10)).toEqual([])
  })

  test('stream_end retires the entry, so a finished turn replays no bubble', () => {
    const registry = new LiveStreamRegistry()
    start(registry, 10)
    registry.record(10, { type: 'narration_delta', agent_id: 2, delta: 'done' })
    registry.record(10, { type: 'stream_end', agent_id: 2, temp_id: 't', skipped: false })

    expect(registry.snapshot(10)).toEqual([])
  })

  test('a delta with no stream_start before it is ignored', () => {
    // The server half of the contract: a bubble is created by `stream_start`,
    // never by a stray delta, so a `stream_end` that arrived first cannot
    // resurrect the entry it just retired.
    const registry = new LiveStreamRegistry()
    registry.record(10, { type: 'narration_delta', agent_id: 2, delta: 'orphan' })
    expect(registry.snapshot(10)).toEqual([])
  })

  test('rooms are independent', () => {
    const registry = new LiveStreamRegistry()
    start(registry, 10, 2)
    start(registry, 11, 3)
    registry.record(10, { type: 'narration_delta', agent_id: 2, delta: 'ten' })
    registry.record(11, { type: 'narration_delta', agent_id: 3, delta: 'eleven' })

    expect(registry.snapshot(10)[0]?.narrationText).toBe('ten')
    expect(registry.snapshot(11)[0]?.narrationText).toBe('eleven')
  })

  test('two agents streaming at once each get an entry', () => {
    const registry = new LiveStreamRegistry()
    start(registry, 10, 2)
    start(registry, 10, 5)
    expect(registry.snapshot(10).map((s) => s.agentId).sort()).toEqual([2, 5])

    registry.record(10, { type: 'stream_end', agent_id: 5, temp_id: 't', skipped: true })
    expect(registry.snapshot(10).map((s) => s.agentId)).toEqual([2])
  })

  test('a snapshot is a copy — mutating it cannot corrupt the live state', () => {
    const registry = new LiveStreamRegistry()
    start(registry, 10)
    const [taken] = registry.snapshot(10)
    taken!.narrationText = 'tampered'
    expect(registry.snapshot(10)[0]?.narrationText).toBe('')
  })

  test('a runaway generation cannot grow an accumulator without bound', () => {
    const registry = new LiveStreamRegistry()
    start(registry, 10)
    for (let i = 0; i < 200; i++) {
      registry.record(10, { type: 'narration_delta', agent_id: 2, delta: 'x'.repeat(1024) })
    }
    const text = registry.snapshot(10)[0]!.narrationText
    expect(text.length).toBe(64 * 1024)
  })

  test('clearRoom drops a turn that died without a stream_end', () => {
    const registry = new LiveStreamRegistry()
    start(registry, 10)
    registry.clearRoom(10)
    expect(registry.snapshot(10)).toEqual([])
  })

  test('an event with no agent_id is ignored rather than throwing', () => {
    const registry = new LiveStreamRegistry()
    registry.record(10, { type: 'stream_start', temp_id: 't' })
    registry.record(10, { type: 'keepalive' })
    expect(registry.snapshot(10)).toEqual([])
  })
})
