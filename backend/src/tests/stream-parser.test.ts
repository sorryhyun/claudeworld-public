import { describe, expect, test } from 'bun:test';

import type { SDKAssistantMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';

import { parseMessage } from '@/sdk/client/stream-parser';

/** Assistant message in the TS SDK shape (blocks nested under `message.content`). */
function assistant(content: unknown[]): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: 'u1',
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

function streamEvent(event: Record<string, unknown>, sessionId = 's1'): Record<string, unknown> {
  return { type: 'stream_event', uuid: 'u1', session_id: sessionId, parent_tool_use_id: null, event };
}

function result(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    uuid: 'u1',
    session_id: 's1',
    ...extra,
  };
}

const text = (value: string) => ({ type: 'text', text: value });
const thinking = (value: string) => ({ type: 'thinking', thinking: value, signature: 'sig' });
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id: 't1',
  name,
  input,
});

describe('parseMessage / assistant content blocks', () => {
  test('extracts a text block when nothing has streamed yet', () => {
    const parsed = parseMessage(assistant([text('Hello, world!')]), '', '');

    expect(parsed.responseText).toBe('Hello, world!');
    expect(parsed.thinkingText).toBe('');
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.hasToolUsage).toBe(false);
  });

  test('extracts a thinking block', () => {
    const parsed = parseMessage(assistant([thinking('Agent is thinking...')]), '', '');

    expect(parsed.responseText).toBe('');
    expect(parsed.thinkingText).toBe('Agent is thinking...');
  });

  test('concatenates multiple text blocks', () => {
    const parsed = parseMessage(assistant([text('Part 1 '), text('Part 2')]), '', '');

    expect(parsed.responseText).toBe('Part 1 Part 2');
  });

  test('ignores text/thinking blocks once deltas have accumulated (no duplication)', () => {
    // The assistant message repeats the whole turn; appending it after
    // stream_event deltas would emit the response twice.
    const parsed = parseMessage(
      assistant([text('Previous more text'), thinking('all of the thinking')]),
      'Previous',
      'Existing thinking',
    );

    expect(parsed.responseText).toBe('Previous');
    expect(parsed.thinkingText).toBe('Existing thinking');
  });

  test('the empty-accumulator rule is per-channel', () => {
    const parsed = parseMessage(assistant([text('full text'), thinking('full thinking')]), '', 'streamed');

    expect(parsed.responseText).toBe('full text');
    expect(parsed.thinkingText).toBe('streamed');
  });

  test('handles mixed content blocks', () => {
    const parsed = parseMessage(
      assistant([text('Hello'), thinking('Processing...'), toolUse('agent__skip')]),
      '',
      '',
    );

    expect(parsed.responseText).toBe('Hello');
    expect(parsed.thinkingText).toBe('Processing...');
    expect(parsed.skipUsed).toBe(true);
    expect(parsed.hasToolUsage).toBe(true);
  });

  test('accepts the Python SDK shape with blocks at the top level', () => {
    const parsed = parseMessage({ type: 'assistant', content: [text('flat shape')] }, '', '');

    expect(parsed.responseText).toBe('flat shape');
  });

  test('tolerates missing/garbage content', () => {
    expect(parseMessage({ type: 'assistant' }, 'keep', 'think').responseText).toBe('keep');
    expect(parseMessage(assistant(['nonsense', 42, null]), '', '').responseText).toBe('');
    expect(parseMessage(assistant([{ type: 'text' }]), '', '').responseText).toBe('');
  });
});

describe('parseMessage / tool_use blocks', () => {
  test('detects skip by name suffix', () => {
    const parsed = parseMessage(assistant([toolUse('agent_name__skip')]), '', '');

    expect(parsed.skipUsed).toBe(true);
    expect(parsed.hasToolUsage).toBe(true);
  });

  test('collects memorize entries', () => {
    const parsed = parseMessage(
      assistant([toolUse('agent__memorize', { memory_entry: 'Important memory' })]),
      '',
      '',
    );

    expect(parsed.memoryEntries).toEqual(['Important memory']);
    expect(parsed.hasToolUsage).toBe(true);
  });

  test('collects multiple memorize entries in order', () => {
    const parsed = parseMessage(
      assistant([
        toolUse('agent__memorize', { memory_entry: 'Memory 1' }),
        toolUse('agent__memorize', { memory_entry: 'Memory 2' }),
      ]),
      '',
      '',
    );

    expect(parsed.memoryEntries).toEqual(['Memory 1', 'Memory 2']);
  });

  test('collects anthropic tool situations', () => {
    const parsed = parseMessage(
      assistant([toolUse('agent__anthropic', { situation: 'Need help' })]),
      '',
      '',
    );

    expect(parsed.anthropicCalls).toEqual(['Need help']);
    expect(parsed.hasToolUsage).toBe(true);
  });

  test('skips memorize/anthropic calls with a missing or empty argument', () => {
    const parsed = parseMessage(
      assistant([
        toolUse('agent__memorize', { other_field: 'value' }),
        toolUse('agent__memorize', { memory_entry: '' }),
        toolUse('agent__anthropic', { situation: '' }),
      ]),
      '',
      '',
    );

    expect(parsed.memoryEntries).toEqual([]);
    expect(parsed.anthropicCalls).toEqual([]);
    expect(parsed.hasToolUsage).toBe(false);
  });

  test('ignores unrelated tools', () => {
    const parsed = parseMessage(assistant([toolUse('agent__unknown_tool')]), '', '');

    expect(parsed.skipUsed).toBe(false);
    expect(parsed.memoryEntries).toEqual([]);
    expect(parsed.hasToolUsage).toBe(false);
  });

  test('matches fully namespaced MCP tool names', () => {
    const parsed = parseMessage(assistant([toolUse('mcp__agent_name__skip')]), '', '');

    expect(parsed.skipUsed).toBe(true);
  });
});

describe('parseMessage / system messages', () => {
  test('reads the top-level session_id (TS SDK shape)', () => {
    const parsed = parseMessage({ type: 'system', subtype: 'init', session_id: 'sess_abc123' }, '', '');

    expect(parsed.sessionId).toBe('sess_abc123');
  });

  test('falls back to data.session_id (Python SDK shape)', () => {
    const parsed = parseMessage(
      { type: 'system', subtype: 'sessionStarted', data: { session_id: 'sess_nested', other: 'x' } },
      '',
      '',
    );

    expect(parsed.sessionId).toBe('sess_nested');
  });

  test('returns no session id when absent, preserving accumulated text', () => {
    const parsed = parseMessage({ type: 'system', subtype: 'other', data: {} }, 'Existing', 'Thinking');

    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.responseText).toBe('Existing');
    expect(parsed.thinkingText).toBe('Thinking');
    expect(parsed.hasToolUsage).toBe(false);
  });
});

describe('parseMessage / result messages', () => {
  test('extracts structured output', () => {
    const structured = { stat_system: { stats: [{ name: 'health' }] } };
    const parsed = parseMessage(result({ structured_output: structured }), '', '');

    expect(parsed.structuredOutput).toEqual(structured);
  });

  test('has no structured output when the field is absent', () => {
    expect(parseMessage(result(), '', '').structuredOutput).toBeUndefined();
  });

  test('normalizes usage, defaulting missing counters to 0', () => {
    const parsed = parseMessage(result({ usage: { input_tokens: 100, output_tokens: 50 } }), '', '');

    expect(parsed.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  test('extracts all four cache counters', () => {
    const parsed = parseMessage(
      result({
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
          server_tool_use: { web_search_requests: 0 },
        },
      }),
      '',
      '',
    );

    expect(parsed.usage).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    });
  });

  test('treats an empty usage object as no usage', () => {
    expect(parseMessage(result({ usage: {} }), '', '').usage).toBeUndefined();
  });

  test('preserves accumulated text', () => {
    const parsed = parseMessage(result({ usage: { input_tokens: 1 } }), 'text so far', 'thoughts');

    expect(parsed.responseText).toBe('text so far');
    expect(parsed.thinkingText).toBe('thoughts');
  });
});

describe('parseMessage / stream_event', () => {
  test('appends a text delta to the accumulator', () => {
    const parsed = parseMessage(
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }),
      'Hello',
      '',
    );

    expect(parsed.responseText).toBe('Hello world');
    expect(parsed.thinkingText).toBe('');
  });

  test('appends a thinking delta to the accumulator', () => {
    const parsed = parseMessage(
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mm...' } }),
      '',
      'Hm',
    );

    expect(parsed.responseText).toBe('');
    expect(parsed.thinkingText).toBe('Hmmm...');
  });

  test('exposes input_json_delta fragments', () => {
    const parsed = parseMessage(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"narr' },
      }),
      '',
      '',
    );

    expect(parsed.toolInputDelta).toBe('{"narr');
  });

  test('reports an empty input_json_delta as "" rather than undefined', () => {
    const parsed = parseMessage(
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } }),
      '',
      '',
    );

    // The caller distinguishes `!== undefined` (a fragment arrived) from absent.
    expect(parsed.toolInputDelta).toBe('');
  });

  test('reports the tool name on content_block_start', () => {
    const parsed = parseMessage(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'mcp__action_manager__narration', input: {} },
      }),
      '',
      '',
    );

    expect(parsed.toolStartName).toBe('mcp__action_manager__narration');
    expect(parsed.contentBlockStopped).toBe(false);
  });

  test('ignores content_block_start for non-tool blocks', () => {
    const parsed = parseMessage(
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      '',
      '',
    );

    expect(parsed.toolStartName).toBeUndefined();
  });

  test('flags content_block_stop', () => {
    const parsed = parseMessage(streamEvent({ type: 'content_block_stop', index: 0 }), 'kept', 'thought');

    expect(parsed.contentBlockStopped).toBe(true);
    expect(parsed.responseText).toBe('kept');
    expect(parsed.thinkingText).toBe('thought');
  });

  test('captures the session id only while the response is still empty', () => {
    const event = streamEvent({ type: 'message_start' }, 'sess_123');

    expect(parseMessage(event, '', '').sessionId).toBe('sess_123');
    expect(parseMessage(event, 'already has content', '').sessionId).toBeUndefined();
  });

  test('leaves accumulators untouched for irrelevant events', () => {
    const parsed = parseMessage(streamEvent({ type: 'message_stop' }), 'existing', 'thinking');

    expect(parsed.responseText).toBe('existing');
    expect(parsed.thinkingText).toBe('thinking');
  });

  test('tolerates a missing event payload', () => {
    const parsed = parseMessage({ type: 'stream_event', session_id: 's1' }, 'existing', '');

    expect(parsed.responseText).toBe('existing');
    expect(parsed.toolInputDelta).toBeUndefined();
  });
});

describe('parseMessage / unknown and malformed messages', () => {
  test('an unrecognized message subtype is inert', () => {
    const parsed = parseMessage(
      { type: 'some_future_message_type', payload: { text: 'ignored' } },
      'response',
      'thinking',
    );

    expect(parsed.responseText).toBe('response');
    expect(parsed.thinkingText).toBe('thinking');
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.structuredOutput).toBeUndefined();
    expect(parsed.usage).toBeUndefined();
    expect(parsed.hasToolUsage).toBe(false);
  });

  test('non-object messages do not throw', () => {
    for (const bad of [null, undefined, 'string', 42, []] as unknown[]) {
      const parsed = parseMessage(bad as Record<string, unknown>, 'r', 't');
      expect(parsed.responseText).toBe('r');
      expect(parsed.thinkingText).toBe('t');
    }
  });
});

describe('parseMessage / accepts real SDK types', () => {
  test('typed SDKPartialAssistantMessage', () => {
    const message: SDKPartialAssistantMessage = {
      type: 'stream_event',
      uuid: '11111111-1111-4111-8111-111111111111',
      session_id: 'sess_typed',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'typed' },
      },
    };

    const parsed = parseMessage(message, '', '');

    expect(parsed.responseText).toBe('typed');
    expect(parsed.sessionId).toBe('sess_typed');
  });

  test('typed SDKAssistantMessage', () => {
    const message: SDKAssistantMessage = {
      type: 'assistant',
      uuid: '22222222-2222-4222-8222-222222222222',
      session_id: 'sess_typed',
      parent_tool_use_id: null,
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'typed text', citations: null }],
        stop_reason: null,
        stop_sequence: null,
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
          fallback_credit: null,
          inference_geo: null,
          iterations: null,
          output_tokens_details: null,
          speed: null,
        },
      },
    };

    const parsed = parseMessage(message, '', '');

    expect(parsed.responseText).toBe('typed text');
  });
});

describe('parseMessage / accumulated-not-delta contract', () => {
  test('a caller can derive deltas by slicing successive results', () => {
    const chunks = ['The ', 'door ', 'creaks.'];
    let response = '';
    const deltas: string[] = [];

    for (const chunk of chunks) {
      const parsed = parseMessage(
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }),
        response,
        '',
      );
      deltas.push(parsed.responseText.slice(response.length));
      response = parsed.responseText;
    }

    expect(response).toBe('The door creaks.');
    expect(deltas).toEqual(chunks);
  });
});
