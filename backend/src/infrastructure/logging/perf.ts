/**
 * Latency instrumentation for gameplay bottleneck analysis.
 *
 * Ported from `backend/infrastructure/logging/perf_logger.py`. Enabled with
 * `PERF_LOG=true` (or `make dev-perf`); output is appended to `latency.log` in
 * the project root, in a format identical to the Python one so existing eyeball
 * habits and any `grep`/`awk` over that file keep working.
 *
 * What is deliberately *not* ported: `@track_perf` / `@track_interaction`. Those
 * decorators exist to recover `room_id` and `agent_name` out of a wrapped
 * function's bound arguments via `inspect.signature`, which has no TypeScript
 * equivalent and no need for one — every call site here already holds the
 * context and can pass it to {@link PerfLogger.track} directly.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { getSettings } from '../../config/settings'
import { getLogger } from './logger'

const logger = getLogger('PerfLogger')

export interface TimingContext {
  agentName?: string | null
  roomId?: number | null
  /** Free-form fields appended as `key=value` to the log line. */
  extra?: Record<string, unknown>
}

export interface TimingEntry extends TimingContext {
  phase: string
  durationMs: number
  startTime: Date
  endTime: Date
}

/** `%Y-%m-%d %H:%M:%S.%f`[:-3] — millisecond precision, local time. */
function formatTimestamp(when: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.` +
    `${pad(when.getMilliseconds(), 3)}`
  )
}

/**
 * Render one entry exactly as `TimingEntry.to_log_line()` does.
 *
 * The falsy-`room_id` check is copied rather than corrected: Python writes
 * `if self.room_id`, so room 0 is omitted from the line. Room ids are
 * autoincrement primary keys starting at 1, so this never fires in practice,
 * and matching the format matters more than fixing a branch that cannot run.
 */
export function formatLogLine(entry: TimingEntry): string {
  const timestamp = formatTimestamp(entry.startTime)
  const agent = entry.agentName ? ` [${entry.agentName}]` : ''
  const room = entry.roomId ? ` room=${entry.roomId}` : ''
  const extraPairs = Object.entries(entry.extra ?? {}).map(([k, v]) => `${k}=${String(v)}`)
  const extra = extraPairs.length > 0 ? ` ${extraPairs.join(' ')}` : ''

  const phase = entry.phase.padEnd(30)
  const duration = entry.durationMs.toFixed(2).padStart(8)

  return `${timestamp} | ${phase}${agent}${room} | ${duration}ms${extra}`
}

export interface PhaseStats {
  count: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
}

export interface PerfSummary {
  totalEntries: number
  sessionDurationS?: number
  interactions?: number
  phases?: Record<string, PhaseStats>
}

export class PerfLogger {
  readonly enabled: boolean

  private readonly logPath: string
  private readonly entries: TimingEntry[] = []
  private readonly sessionStart = new Date()
  private interactionCount = 0

  constructor(enabled: boolean, logPath: string) {
    this.enabled = enabled
    this.logPath = logPath
    if (this.enabled) this.writeSessionHeader()
  }

  /**
   * Append raw text to `latency.log`.
   *
   * Python guards every write with an `asyncio.Lock` because its writes are
   * `await`ed and two coroutines could interleave between open and write. A
   * synchronous append cannot be interleaved by anything on this runtime, so
   * the lock has no work to do and is not reproduced — the same reasoning that
   * removed `serialized_write` from the database layer.
   */
  private append(text: string): void {
    try {
      appendFileSync(this.logPath, text, 'utf-8')
    } catch (error) {
      // Instrumentation must never take down the thing it is measuring.
      logger.warning(`Failed to write ${this.logPath}: ${String(error)}`)
    }
  }

  private writeSessionHeader(): void {
    const bar = '='.repeat(80)
    this.append(`\n${bar}\nPerformance Logging Session Started: ${this.sessionStart.toISOString()}\n${bar}\n\n`)
  }

  private record(entry: TimingEntry): void {
    this.entries.push(entry)
    const line = formatLogLine(entry)
    this.append(`${line}\n`)
    logger.info(`⏱️  ${line}`)
  }

  /**
   * Time `fn` and record it.
   *
   * Python exposes this as an `async with` block; a callback is the closest
   * thing that still guarantees the timer stops on the throwing path.
   */
  async track<T>(phase: string, context: TimingContext, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn()

    const startTime = new Date()
    const startPerf = performance.now()
    try {
      return await fn()
    } finally {
      this.record({
        phase,
        ...context,
        durationMs: performance.now() - startPerf,
        startTime,
        endTime: new Date(),
      })
    }
  }

  /** Record a duration measured elsewhere. */
  log(phase: string, durationMs: number, context: TimingContext = {}): void {
    if (!this.enabled) return
    const now = new Date()
    this.record({ phase, ...context, durationMs, startTime: now, endTime: now })
  }

  /** Mark the start of a user interaction (one submitted action). */
  logInteractionStart(roomId: number, userMessage: string): void {
    if (!this.enabled) return
    this.interactionCount += 1
    const timestamp = formatTimestamp(new Date())
    this.append(
      `\n--- Interaction #${this.interactionCount} | Room ${roomId} ---\n` +
        `${timestamp} | USER_ACTION                    | msg_len=${userMessage.length}\n`,
    )
  }

  /** Mark the end of a user interaction, once every agent has responded. */
  logInteractionEnd(_roomId: number, totalDurationMs: number, agentCount: number): void {
    if (!this.enabled) return
    const timestamp = formatTimestamp(new Date())
    this.append(
      `${timestamp} | INTERACTION_COMPLETE           | ${totalDurationMs.toFixed(2).padStart(8)}ms | agents=${agentCount}\n` +
        `--- End Interaction #${this.interactionCount} ---\n\n`,
    )
  }

  getSummary(): PerfSummary {
    if (this.entries.length === 0) return { totalEntries: 0 }

    const byPhase = new Map<string, number[]>()
    for (const entry of this.entries) {
      const durations = byPhase.get(entry.phase)
      if (durations) durations.push(entry.durationMs)
      else byPhase.set(entry.phase, [entry.durationMs])
    }

    const phases: Record<string, PhaseStats> = {}
    for (const [phase, durations] of byPhase) {
      const totalMs = durations.reduce((a, b) => a + b, 0)
      phases[phase] = {
        count: durations.length,
        totalMs,
        avgMs: totalMs / durations.length,
        minMs: Math.min(...durations),
        maxMs: Math.max(...durations),
      }
    }

    return {
      totalEntries: this.entries.length,
      sessionDurationS: (Date.now() - this.sessionStart.getTime()) / 1000,
      interactions: this.interactionCount,
      phases,
    }
  }

  writeSummary(): void {
    if (!this.enabled) return

    const summary = this.getSummary()
    const bar = '='.repeat(80)
    const lines = [
      `\n${bar}`,
      'Session Summary',
      bar,
      `Total entries: ${summary.totalEntries}`,
      `Session duration: ${(summary.sessionDurationS ?? 0).toFixed(2)}s`,
      `Total interactions: ${summary.interactions ?? 0}`,
      '',
      'Phase Breakdown:',
    ]

    for (const [phase, stats] of Object.entries(summary.phases ?? {})) {
      lines.push(
        `  ${phase}:`,
        `    count: ${stats.count}`,
        `    total: ${stats.totalMs.toFixed(2)}ms`,
        `    avg: ${stats.avgMs.toFixed(2)}ms`,
        `    min: ${stats.minMs.toFixed(2)}ms`,
        `    max: ${stats.maxMs.toFixed(2)}ms`,
      )
    }

    lines.push(bar, '', '')
    this.append(lines.join('\n'))
  }
}

/**
 * Whether `PERF_LOG` asks for instrumentation.
 *
 * Read from the process env, not from `settings.ts`, because Python reads it
 * the same way — `core/settings.py` never declares it — and the accepted values
 * (`true`/`1`/`yes`) differ from the `== "true"` that pydantic fields use.
 */
export function isPerfLoggingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['true', '1', 'yes'].includes((env.PERF_LOG ?? '').trim().toLowerCase())
}

let instance: PerfLogger | null = null

export function getPerfLogger(): PerfLogger {
  if (instance === null) {
    instance = new PerfLogger(isPerfLoggingEnabled(), join(getSettings().paths.projectRoot, 'latency.log'))
  }
  return instance
}

/** Drop the singleton so the next {@link getPerfLogger} re-reads the environment. */
export function resetPerfLogger(): void {
  instance = null
}
