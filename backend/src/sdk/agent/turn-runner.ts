import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { NarrationStreamExtractor } from '@/sdk/client/narration-extractor'
import { parseMessage, type ParsedUsage } from '@/sdk/client/stream-parser'
import { IdleTimeoutError, SessionDeadError, type AgentSession } from '@/sdk/client/session'
import type { SessionPool } from '@/sdk/client/session-pool'
import { buildAgentOptions, optionsFingerprint, type AgentOptionsInput } from './options-builder'

/** Runs one agent turn as a stream of events: `stream_start`, deltas, then
 * exactly one `stream_end`. Every accumulator is scoped to the turn rather than to
 * a long-lived manager, which keeps one turn's text out of the next. */

export type TurnEvent =
  | { type: 'stream_start'; tempId: string }
  | { type: 'content_delta'; tempId: string; delta: string }
  | { type: 'thinking_delta'; tempId: string; delta: string }
  | { type: 'narration_delta'; tempId: string; delta: string }
  | {
      type: 'stream_end'
      tempId: string
      responseText: string | null
      thinkingText: string
      narrationText: string
      sessionId: string | null
      memoryEntries: string[]
      anthropicCalls: string[]
      skipped: boolean
      structuredOutput: unknown
      usage: ParsedUsage | undefined
      /** Set when the turn ended by interrupt/abort rather than a result. */
      interrupted: boolean
      /** Set when the turn ended in an error; the session has been evicted. */
      error?: string
    }

export interface TurnRequest {
  roomId: number
  agentId: number
  agentName: string
  /** Message content: a string, or Anthropic content blocks for image turns. */
  content: unknown
  options: AgentOptionsInput
  /** Suppresses `content_delta` broadcast to clients — the NPC reaction cell and
   * the Action Manager, whose prose the player never sees. The events are still
   * yielded to the orchestrator, which needs the text. */
  hidden?: boolean
  signal?: AbortSignal
  /** Sink for the anthropic-guideline hook's captures. */
  anthropicCalls?: string[]
}

let tempCounter = 0

export class TurnRunner {
  constructor(private readonly pool: SessionPool) {}

  async *run(request: TurnRequest): AsyncGenerator<TurnEvent> {
    const tempId = `temp_room_${request.roomId}_agent_${request.agentId}_${(tempCounter++).toString(36)}`
    yield { type: 'stream_start', tempId }

    const fingerprint = optionsFingerprint(request.options)
    const sdkOptions = buildAgentOptions(request.options)

    let responseText = ''
    let thinkingText = ''
    let narrationText = ''
    let sessionId: string | null = request.options.resume ?? null
    let skipUsed = false
    let structuredOutput: unknown = undefined
    let usage: ParsedUsage | undefined
    const memoryEntries: string[] = []
    const anthropicCalls = request.anthropicCalls ?? []

    // Extracted from the *partial* JSON of the narration tool call, so the player
    // sees prose while the model is still writing it.
    let narrationExtractor: NarrationStreamExtractor | null = null

    let session: AgentSession | undefined
    try {
      session = await this.pool.acquire(
        { roomId: request.roomId, agentId: request.agentId },
        sdkOptions,
        fingerprint,
      )

      for await (const message of session.runTurn(request.content, { signal: request.signal })) {
        const parsed = parseMessage(message as SDKMessage, responseText, thinkingText)

        // The parser returns accumulated text, so a delta is the new tail.
        const contentDelta = parsed.responseText.slice(responseText.length)
        const thinkingDelta = parsed.thinkingText.slice(thinkingText.length)
        responseText = parsed.responseText
        thinkingText = parsed.thinkingText

        if (parsed.sessionId) sessionId = parsed.sessionId
        if (parsed.skipUsed) skipUsed = true
        if (parsed.memoryEntries.length) memoryEntries.push(...parsed.memoryEntries)
        if (parsed.anthropicCalls.length) anthropicCalls.push(...parsed.anthropicCalls)
        if (parsed.structuredOutput !== undefined) structuredOutput = parsed.structuredOutput
        if (parsed.usage) usage = parsed.usage

        if (parsed.toolStartName?.endsWith('narration')) {
          narrationExtractor = new NarrationStreamExtractor()
        }
        if (narrationExtractor && parsed.toolInputDelta !== undefined) {
          const delta = narrationExtractor.feed(parsed.toolInputDelta)
          if (delta) {
            narrationText += delta
            yield { type: 'narration_delta', tempId, delta }
          }
        }
        if (parsed.contentBlockStopped) narrationExtractor = null

        if (contentDelta) yield { type: 'content_delta', tempId, delta: contentDelta }
        if (thinkingDelta) yield { type: 'thinking_delta', tempId, delta: thinkingDelta }
      }

      yield {
        type: 'stream_end',
        tempId,
        // A turn that called `skip` chose not to speak; its text is scratch work.
        responseText: skipUsed ? null : responseText || null,
        thinkingText,
        narrationText,
        sessionId,
        memoryEntries,
        anthropicCalls,
        skipped: skipUsed,
        structuredOutput,
        usage,
        interrupted: false,
      }
    } catch (error) {
      if (isInterrupt(error, request.signal)) {
        // Interrupting is normal, so the session stays warm and whatever was
        // written is kept — the caller persists it as a partial response.
        yield {
          type: 'stream_end',
          tempId,
          responseText: responseText || null,
          thinkingText,
          narrationText,
          sessionId,
          memoryEntries,
          anthropicCalls,
          skipped: true,
          structuredOutput: undefined,
          usage,
          interrupted: true,
        }
        return
      }

      // Any other failure leaves the CLI in an unknown state: discard the session,
      // and the next turn reopens with `resume`.
      await this.pool.evictKey({ roomId: request.roomId, agentId: request.agentId })
      yield {
        type: 'stream_end',
        tempId,
        responseText: null,
        thinkingText,
        narrationText,
        sessionId,
        memoryEntries,
        anthropicCalls,
        skipped: false,
        structuredOutput: undefined,
        usage,
        interrupted: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

// A typed question — an abort we requested, a `DOMException` from `AbortSignal`,
// or the SDK's own AbortError — rather than a substring search of the error
// message, which breaks silently when the SDK rewords one.
function isInterrupt(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  // A dead session mid-turn after an interrupt request looks the same from here;
  // an idle timeout does not — that is a genuine failure.
  if (error instanceof IdleTimeoutError) return false
  if (error instanceof SessionDeadError) return false
  return false
}
