import { query, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../../lib/async-queue'
import { createInputChannel, type InputChannel } from './input-channel'

/**
 * One long-lived Claude Code session per (room, agent).
 *
 * The migration plan flagged this as the go/no-go risk: the TS SDK has no
 * `ClaudeSDKClient`, so the assumption was that persistent sessions had to
 * become one-shot `query()` calls with `resume`. That assumption is wrong.
 * `query()` accepts an *async iterable* as its prompt, and when given one the
 * CLI runs in streaming-input mode: a single subprocess, a single open control
 * channel, and N turns pushed in over the life of the process. That is
 * structurally what `ClaudeSDKClient` wraps, so the Python client pool is a
 * translation rather than a redesign.
 *
 * Three details are load-bearing and were each learned the hard way upstream:
 *
 * 1. **Manual `stream.next()`, never `for await`.** A `for await` that `break`s
 *    calls `.return()` on the generator and tears the session down. The turn has
 *    to end at the `result` message while the stream stays alive.
 *
 * 2. **Never call `Query.streamInput()`.** Despite the name, it drains the
 *    iterable it is handed and then ends the CLI's stdin — which kills a session
 *    meant to serve later turns. Messages go into our own channel instead.
 *
 * 3. **A background pump, not consumer-driven reads.** Sub-agents spawned via
 *    `Task` can still call in-process MCP tools *after* the parent turn's
 *    `result`. Python needed a pump for exactly this: if nobody drains the
 *    stream between turns, the CLI cannot service `tools/call` and the sub-agent
 *    falls back to hallucinating tool syntax as text. The pump here runs for the
 *    life of the session and routes messages to whichever turn is currently open.
 */

/** Per-turn read deadline. Ported from Python's STREAMING_IDLE_TIMEOUT. */
export const STREAMING_IDLE_TIMEOUT_MS = 120_000

export interface SessionKey {
  roomId: number
  agentId: number
}

/** Python used a frozen dataclass as a dict key; JS Maps key by reference, so
 *  the canonical key is the string form Python already had. */
export function sessionKeyOf({ roomId, agentId }: SessionKey): string {
  return `room_${roomId}_agent_${agentId}`
}

/**
 * The inverse of {@link sessionKeyOf}, returning `null` for anything else.
 *
 * Python's `TaskIdentifier.parse` exists, in its own words, to replace "fragile
 * string parsing of 'room_X_agent_Y' format" — and then raises on a malformed
 * key. Every caller here is walking the pool's own keys, where a malformed one
 * would be this module's bug rather than the caller's input, so it degrades
 * instead: a key that does not parse is skipped, not thrown over.
 */
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

  /** The open turn's queue, or null while idle. */
  private currentTurn: AsyncQueue<SDKMessage> | null = null

  private closed = false
  private pumpEnded = false

  /** Latest session id seen on the wire; persisted by the caller per turn. */
  sessionId: string | null = null
  turnsProcessed = 0
  busy = false

  constructor(
    readonly key: string,
    /**
     * Identity of the options this stream was opened with. The SDK bakes
     * options in at `query()` time and mutating them later is a no-op, so a
     * change here means the session must be reopened rather than reused.
     */
    readonly fingerprint: string,
    /** The session id this stream resumed, or undefined if opened fresh. */
    readonly openedWithResume: string | undefined,
    options: Options,
  ) {
    this.abortController = options.abortController ?? new AbortController()
    this.channel = createInputChannel()
    this.stream = query({
      // The SDK types the prompt as AsyncIterable<SDKUserMessage>, but the full
      // SDKUserMessage requires fields (parent_tool_use_id, session_id) that a
      // caller cannot know. Partial user messages are what the wire format
      // actually expects, so the cast is deliberate.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prompt: this.channel.iterable as AsyncIterable<any>,
      options: { ...options, abortController: this.abortController },
    })
    this.startPump()
  }

  /**
   * Drain the SDK stream for the life of the session.
   *
   * Messages arriving while no turn is open are discarded rather than buffered.
   * Python buffered them, and the consumer then parsed them at the *start* of
   * the next turn with empty accumulators — so a stale `text` block was appended
   * to the next turn's response and a stale session id could be adopted. The
   * discard is the fix; the read itself is what matters, because reading is what
   * keeps the control channel alive.
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

  /**
   * Run one turn, yielding raw SDK messages until the terminal `result`.
   *
   * The stream stays open afterwards. `content` is either a plain string or an
   * Anthropic content-block array (text + image blocks).
   */
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

        // Track the session id from every message so a reopen can resume, unless
        // the caller has pinned one. This is what makes the DB-persisted
        // room_agent_sessions row stay accurate.
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
   * Ask the CLI to stop the in-flight turn.
   *
   * Interrupt deliberately does NOT close the session — Python's invariant is
   * "interrupt keeps the session, error kills it", because the player
   * interrupting their own turn should not cost the warm subprocess.
   *
   * The receipt matters: `still_queued` names messages the CLI kept and will
   * still run. Discarding it is how a turn comes to be reported as stopped while
   * the CLI keeps working.
   */
  async interrupt(timeoutMs = 2000): Promise<{ stillQueued: string[] }> {
    try {
      const receipt = await withDeadline(this.stream.interrupt(), timeoutMs)
      return { stillQueued: receipt?.still_queued ?? [] }
    } catch {
      // An interrupt that cannot be delivered means the process is already gone
      // or wedged; the caller's next move is teardown either way.
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
