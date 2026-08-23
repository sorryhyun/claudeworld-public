import { describe, expect, test } from 'bun:test'

import type { Agent } from '@/db/schema'
import { turnEventToSse } from '@/http/stream-events'
import type { TurnEvent } from '@/sdk/agent/turn-runner'

const agent = { id: 7, name: 'Onboarding_Manager' } as Agent

const streamEnd: TurnEvent = {
  type: 'stream_end',
  tempId: 't1',
  responseText: 'hello',
  thinkingText: '',
  narrationText: '',
  sessionId: null,
  memoryEntries: [],
  anthropicCalls: [],
  skipped: false,
  structuredOutput: undefined,
  usage: undefined,
  interrupted: false,
}

describe('turnEventToSse', () => {
  test('stream_start carries the identity useSSE keys its bubble on', () => {
    const sse = turnEventToSse(agent, { type: 'stream_start', tempId: 't1' }, { roomId: 1, hidden: false })
    expect(sse).toEqual({
      type: 'stream_start',
      agent_id: 7,
      agent_name: 'Onboarding_Manager',
      temp_id: 't1',
    })
  })

  test('content_delta passes for a visible agent', () => {
    const sse = turnEventToSse(
      agent,
      { type: 'content_delta', tempId: 't1', delta: 'Wel' },
      { roomId: 1, hidden: false },
    )
    expect(sse).toEqual({ type: 'content_delta', agent_id: 7, temp_id: 't1', delta: 'Wel' })
  })

  test('a hidden agent leaks no prose, but thinking and narration stream', () => {
    const meta = { roomId: 1, hidden: true }
    expect(turnEventToSse(agent, { type: 'content_delta', tempId: 't1', delta: 'x' }, meta)).toBeNull()
    expect(
      turnEventToSse(agent, { type: 'thinking_delta', tempId: 't1', delta: 'hm' }, meta),
    ).toEqual({ type: 'thinking_delta', agent_id: 7, temp_id: 't1', delta: 'hm' })
    expect(
      turnEventToSse(agent, { type: 'narration_delta', tempId: 't1', delta: 'The door' }, meta),
    ).toEqual({ type: 'narration_delta', agent_id: 7, temp_id: 't1', delta: 'The door' })
  })

  test('stream_start and stream_end pass even hidden, so the bubble opens and clears', () => {
    const meta = { roomId: 1, hidden: true }
    expect(turnEventToSse(agent, { type: 'stream_start', tempId: 't1' }, meta)).not.toBeNull()
    expect(turnEventToSse(agent, streamEnd, meta)).toEqual({
      type: 'stream_end',
      agent_id: 7,
      temp_id: 't1',
      skipped: false,
    })
  })

  test('stream_end reports a skip so the client can drop the bubble silently', () => {
    const sse = turnEventToSse(agent, { ...streamEnd, skipped: true }, { roomId: 1, hidden: false })
    expect(sse).toMatchObject({ type: 'stream_end', skipped: true })
  })
})
