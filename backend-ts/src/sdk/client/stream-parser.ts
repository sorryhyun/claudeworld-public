/**
 * Parses Claude Agent SDK streaming messages into a flat, accumulated snapshot.
 *
 * Port of `backend/sdk/client/stream_parser.py`.
 *
 * `parseMessage` is stateless: the caller owns the accumulators and passes them
 * back in on every message. The returned `responseText` / `thinkingText` are the
 * FULL accumulated strings (previous + this message's delta), so a caller that
 * wants a delta slices it off the previous value.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Token accounting lifted off the `result` message.
 *
 * Normalized to the four wire field names the perf logger reads, with 0 for
 * anything the CLI omitted (Python read these off the raw usage dict with
 * `.get(..., 0)` at the call site).
 */
export interface ParsedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Structured result of parsing a single SDK stream message. */
export interface ParsedStreamMessage {
  /** Accumulated response text (previous + this message's delta). */
  responseText: string;
  /** Accumulated thinking text (previous + this message's delta). */
  thinkingText: string;
  /** Session id if this message carried one, else undefined. */
  sessionId: string | undefined;
  /** True if a `*__skip` tool was called in this message. */
  skipUsed: boolean;
  /** New memory entries from `*__memorize` calls in this message. */
  memoryEntries: string[];
  /** New situations from `*__anthropic` calls in this message. */
  anthropicCalls: string[];
  /** Structured output payload from a `result` message, if any. */
  structuredOutput: unknown;
  /** Token usage from a `result` message, if any. */
  usage: ParsedUsage | undefined;
  /** Tool name from a `content_block_start` of type `tool_use`. */
  toolStartName: string | undefined;
  /** Partial JSON from an `input_json_delta`; `''` is meaningful, undefined means "no delta". */
  toolInputDelta: string | undefined;
  /** True if this message was a `content_block_stop` event. */
  contentBlockStopped: boolean;
  /** Convenience: skip, memorize or anthropic was used in this message. */
  hasToolUsage: boolean;
}

/**
 * What `parseMessage` accepts.
 *
 * The union with `Record<string, unknown>` is deliberate: this code runs against
 * whatever CLI/SDK version happens to be installed, so every field is narrowed
 * structurally rather than by matching the `SDKMessage` union exhaustively. An
 * unseen message subtype falls through to "nothing extracted" instead of
 * crashing, and hand-built fixtures need no casts.
 */
export type ParsableMessage = SDKMessage | Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface ParsedFields {
  responseText: string;
  thinkingText: string;
  sessionId?: string | undefined;
  skipUsed?: boolean;
  memoryEntries?: string[];
  anthropicCalls?: string[];
  structuredOutput?: unknown;
  usage?: ParsedUsage | undefined;
  toolStartName?: string | undefined;
  toolInputDelta?: string | undefined;
  contentBlockStopped?: boolean;
}

function finalize(fields: ParsedFields): ParsedStreamMessage {
  const skipUsed = fields.skipUsed ?? false;
  const memoryEntries = fields.memoryEntries ?? [];
  const anthropicCalls = fields.anthropicCalls ?? [];
  return {
    responseText: fields.responseText,
    thinkingText: fields.thinkingText,
    sessionId: fields.sessionId,
    skipUsed,
    memoryEntries,
    anthropicCalls,
    structuredOutput: fields.structuredOutput,
    usage: fields.usage,
    toolStartName: fields.toolStartName,
    toolInputDelta: fields.toolInputDelta,
    contentBlockStopped: fields.contentBlockStopped ?? false,
    hasToolUsage: skipUsed || memoryEntries.length > 0 || anthropicCalls.length > 0,
  };
}

/**
 * Parse one `stream_event` message (an `SDKPartialAssistantMessage`, emitted only
 * when the query was started with `includePartialMessages: true`).
 *
 * `event` is a raw Anthropic Messages API streaming event.
 */
function parseStreamEvent(
  message: Record<string, unknown>,
  currentResponse: string,
  currentThinking: string,
): ParsedStreamMessage {
  const event = asRecord(message.event) ?? {};
  const eventType = asString(event.type);

  let contentDelta = '';
  let thinkingDelta = '';
  let toolStartName: string | undefined;
  let toolInputDelta: string | undefined;
  let contentBlockStopped = false;

  if (eventType === 'content_block_delta') {
    const delta = asRecord(event.delta) ?? {};
    const deltaType = asString(delta.type) ?? '';

    if (deltaType === 'text_delta') {
      contentDelta = asString(delta.text) ?? '';
    } else if (deltaType === 'thinking_delta') {
      thinkingDelta = asString(delta.thinking) ?? '';
    } else if (deltaType === 'input_json_delta') {
      // '' rather than undefined: callers distinguish "no tool input this
      // message" (undefined) from "an empty fragment" (''), and the SDK does
      // emit empty `partial_json` fragments.
      toolInputDelta = asString(delta.partial_json) ?? '';
    }
  } else if (eventType === 'content_block_start') {
    const contentBlock = asRecord(event.content_block) ?? {};
    if (asString(contentBlock.type) === 'tool_use') {
      toolStartName = asString(contentBlock.name) ?? '';
    }
  } else if (eventType === 'content_block_stop') {
    contentBlockStopped = true;
  }

  const sessionId = asString(message.session_id);

  return finalize({
    responseText: currentResponse + contentDelta,
    thinkingText: currentThinking + thinkingDelta,
    // Only report the session id before any response text exists. Every
    // stream_event carries it, so reporting it unconditionally would make the
    // caller re-assign the session on every token.
    sessionId: sessionId && !currentResponse ? sessionId : undefined,
    toolStartName,
    toolInputDelta,
    contentBlockStopped,
  });
}

/**
 * Parse a streaming message from the Claude Agent SDK.
 *
 * @param message - Any SDK message; unrecognized shapes yield an inert result.
 * @param currentResponse - Response text accumulated so far.
 * @param currentThinking - Thinking text accumulated so far.
 */
export function parseMessage(
  message: ParsableMessage,
  currentResponse: string,
  currentThinking: string,
): ParsedStreamMessage {
  const record = asRecord(message);
  if (!record) {
    return finalize({ responseText: currentResponse, thinkingText: currentThinking });
  }

  const messageType = asString(record.type);

  if (messageType === 'stream_event') {
    return parseStreamEvent(record, currentResponse, currentThinking);
  }

  let contentDelta = '';
  let thinkingDelta = '';
  let sessionId: string | undefined;
  let skipUsed = false;
  const memoryEntries: string[] = [];
  const anthropicCalls: string[] = [];
  let structuredOutput: unknown;
  let usage: ParsedUsage | undefined;

  if (messageType === 'result') {
    const rawUsage = asRecord(record.usage);
    // An empty usage object counts as "no usage", matching the Python truthiness check.
    if (rawUsage && Object.keys(rawUsage).length > 0) {
      usage = {
        input_tokens: asCount(rawUsage.input_tokens),
        output_tokens: asCount(rawUsage.output_tokens),
        cache_creation_input_tokens: asCount(rawUsage.cache_creation_input_tokens),
        cache_read_input_tokens: asCount(rawUsage.cache_read_input_tokens),
      };
    }
    if (record.structured_output !== undefined && record.structured_output !== null) {
      structuredOutput = record.structured_output;
    }
  }

  if (messageType === 'system') {
    // The TS SDK puts session_id at the top level; the Python SDK nested it
    // under `data`. Check both so either CLI shape is handled.
    sessionId = asString(record.session_id) ?? asString(asRecord(record.data)?.session_id);
  }

  if (messageType === 'assistant') {
    // TS SDK: blocks live on `message.message.content` (an Anthropic Message).
    // Python SDK: they live on `message.content`.
    const content =
      asArray(asRecord(record.message)?.content) ?? asArray(record.content) ?? [];

    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (!block) continue;
      const blockType = asString(block.type);

      if (blockType === 'tool_use') {
        // Tools are namespaced per agent (`<agent>__skip`), so match by suffix.
        const name = asString(block.name) ?? '';
        const input = asRecord(block.input) ?? {};

        if (name.endsWith('__skip')) {
          skipUsed = true;
        } else if (name.endsWith('__memorize')) {
          const memoryEntry = asString(input.memory_entry) ?? '';
          if (memoryEntry) memoryEntries.push(memoryEntry);
        } else if (name.endsWith('__anthropic')) {
          const situation = asString(input.situation) ?? '';
          if (situation) anthropicCalls.push(situation);
        }
      } else if (blockType === 'thinking') {
        // Load-bearing: an assistant message's thinking block holds the WHOLE
        // turn's thinking, not an increment. If stream_event deltas already
        // accumulated it, appending here would emit it twice.
        if (!currentThinking) thinkingDelta += asString(block.thinking) ?? '';
      } else if (blockType === 'text') {
        // Same rule as thinking: assistant/result text blocks carry the complete
        // turn text, so they are only used when nothing was streamed.
        if (!currentResponse) contentDelta += asString(block.text) ?? '';
      }
    }
  }

  return finalize({
    responseText: currentResponse + contentDelta,
    thinkingText: currentThinking + thinkingDelta,
    sessionId,
    skipUsed,
    memoryEntries,
    anthropicCalls,
    structuredOutput,
    usage,
  });
}
