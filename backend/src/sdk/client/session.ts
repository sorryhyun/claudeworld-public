import { query, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../../lib/async-queue'
import { createInputChannel, type InputChannel } from './input-channel'

/**
 * One long-lived Claude Code session per (room, agent). `query()` given an
 * async iterable as its prompt runs the CLI in streaming-input mode: one
 * subprocess, one control channel, N turns. Three details are load-bearing:
 * **manual `stream.next()`, never `for await`** (a `break` calls `.return()`
 * and tears the session down); **never call `Query.streamInput()`** (despite
 * the name it ends the CLI's stdin); and **a background pump, not
 * consumer-driven reads**, because dispatched sub-agents call MCP tools after
 * the parent turn's `result` and an undrained stream cannot serve `tools/call`.
 */

export const STREAMING_IDLE_TIMEOUT_MS = 120_000

export interface SessionKey {
  roomId: number
  agentId: number
}

export function sessionKeyOf({ roomId, agentId }: SessionKey): string {
  return `room_${roomId}_agent_${agentId}`
}

/** The inverse of {@link sessionKeyOf}; a malformed key is skipped, not thrown. */
export function parseSessionKey(key: string): SessionKey | null {
  const match = /^room_(\d+)_agent_(\d+)$/.exec(key)
  if (!match) return null
  return { roomId: Number(match[1]), agentId: Number(match[2]) }
}

export interface TurnOptions {
  /** Aborts the turn. Interrupt uses this; it does not tear the session down. */
  signal?: AbortSignal
  idleTimeoutMs?: number
}

export class AgentSession {
  private readonly stream: Query
  private readonly channel: InputChannel
  private readonly abortController: AbortController
  private pumpTask: Promise<void> | null = null

  private currentTurn: AsyncQueue<SDKMessage> | null = null

  private closed = false
  private pumpEnded = false

  sessionId: string | null = null
  turnsProcessed = 0
  busy = false

  constructor(
    readonly key: string,
    /** The SDK bakes options in at `query()` time; a change forces a reopen. */
    readonly fingerprint: string,
    readonly openedWithResume: string | undefined,
    options: Options,
  ) {
    this.abortController = options.abortController ?? new AbortController()
    this.channel = createInputChannel()
    this.stream = query({
      // `SDKUserMessage` requires fields a caller cannot know; partial user
      // messages are what the wire format expects, so the cast is deliberate.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prompt: this.channel.iterable as AsyncIterable<any>,
      options: { ...options, abortController: this.abortController },
    })
    this.startPump()
  }

  /**
   * Drain the SDK stream for the life of the session. Messages arriving while
   * no turn is open are discarded, not buffered — buffering leaks a stale
   * `text` block into the next turn. The read keeps the channel alive.
   */
  private startPump(): void {
    this.pumpTask = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.stream.next()
          if (done) break
          this.currentTurn?.push(value)
        }
      } catch (error) {
        if (!this.closed && !isAbortError(error)) {
          this.pumpError = error
        }
      } finally {
        this.pumpEnded = true
        this.currentTurn?.end()
      }
    })()
  }

  private pumpError: unknown = null

  /** True once the CLI subprocess has exited; the session cannot serve turns. */
  get isDead(): boolean {
    return this.closed || this.pumpEnded
  }

  /** Yields raw SDK messages until `result`; the stream stays open after. */
  async *runTurn(content: unknown, opts: TurnOptions = {}): AsyncGenerator<SDKMessage> {
    if (this.isDead) throw new SessionDeadError(this.key, this.pumpError)
    if (this.busy) throw new Error(`Session ${this.key} is already running a turn`)

    const idleTimeoutMs = opts.idleTimeoutMs ?? STREAMING_IDLE_TIMEOUT_MS
    const turn = new AsyncQueue<SDKMessage>()
    this.currentTurn = turn
    this.busy = true
    this.turnsProcessed++

    try {
      this.channel.push({ type: 'user', message: { role: 'user', content } })

      for (;;) {
        const message = await withIdleDeadline(turn.next(opts.signal), idleTimeoutMs, this.key)
        if (message === null) {
          // The pump ended mid-turn: the subprocess exited without a result.
          throw new SessionDeadError(this.key, this.pumpError)
        }

        // Track the session id from every message so a reopen can resume, and
        // so the persisted `room_agent_sessions` row stays accurate.
        const sid = (message as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) this.sessionId = sid

        yield message

        if ((message as { type?: unknown }).type === 'result') return
      }
    } finally {
      this.busy = false
      this.currentTurn = null
    }
  }

  /**
   * Interrupt keeps the session, error kills it, so interrupting does not cost
   * the warm subprocess. `still_queued` names messages the CLI will still run.
   */
  async interrupt(timeoutMs = 2000): Promise<{ stillQueued: string[] }> {
    try {
      const receipt = await withDeadline(this.stream.interrupt(), timeoutMs)
      return { stillQueued: receipt?.still_queued ?? [] }
    } catch {
      // Undeliverable means the process is gone or wedged; teardown either way.
      return { stillQueued: [] }
    }
  }

  /** Tear the session down. Conversation context survives via `resume`. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.currentTurn?.end()
    this.channel.close()
    this.abortController.abort()
    try {
      await this.stream.return(undefined)
    } catch {
      // The process is dying; nothing here is recoverable or worth reporting.
    }
    await this.pumpTask?.catch(() => {})
  }
}

export class SessionDeadError extends Error {
  constructor(key: string, readonly cause: unknown) {
    super(`Claude session ${key} ended without producing a result`)
    this.name = 'SessionDeadError'
  }
}

export class IdleTimeoutError extends Error {
  constructor(key: string, ms: number) {
    super(`Timed out after ${ms}ms waiting for a response from ${key}`)
    this.name = 'IdleTimeoutError'
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withIdleDeadline<T>(promise: Promise<T>, ms: number, key: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IdleTimeoutError(key, ms)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
