/**
 * Logging, latency instrumentation and the agent debug log.
 *
 * The Python side has no unit tests for any of this. It is tested here because
 * two of the three are *formats* rather than behaviour — `latency.log` lines
 * and the application log line — and a format that both backends must produce
 * identically is exactly the kind of thing that drifts unnoticed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatMessageForDebug } from '../infrastructure/logging/agent-log'
import { getLogger, setLogSink, setupLogging, type LogLevel } from '../infrastructure/logging/logger'
import { formatLogLine, isPerfLoggingEnabled, PerfLogger } from '../infrastructure/logging/perf'
import { createTurnTelemetry } from '../infrastructure/logging/turn-telemetry'
import type { TurnEvent } from '../sdk/agent/turn-runner'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function captureLogs(): string[] {
  const lines: string[] = []
  const restore = setLogSink((line) => lines.push(line))
  cleanups.push(restore)
  return lines
}

describe('application logger', () => {
  test('renders Python\'s line format', () => {
    const lines = captureLogs()
    setupLogging({ debugMode: true })
    lines.length = 0

    getLogger('AppFactory').info('🚀 Application startup...')

    // `%(asctime)s | %(levelname)-8s | %(name)s | %(message)s`
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| INFO {4} \| AppFactory \| 🚀 Application startup\.\.\.$/,
    )
  })

  test('pads every level name to eight characters', () => {
    const lines = captureLogs()
    setupLogging({ level: 'debug' })
    lines.length = 0

    const logger = getLogger('T')
    logger.debug('d')
    logger.info('i')
    logger.warning('w')
    logger.error('e')

    for (const line of lines) {
      expect(line.split(' | ')[1]).toHaveLength(8)
    }
  })

  test('DEBUG_AGENTS=false silences everything below WARNING', () => {
    const lines = captureLogs()
    setupLogging({ debugMode: false })
    lines.length = 0

    const logger = getLogger('T')
    logger.debug('hidden')
    logger.info('hidden')
    logger.warning('shown')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('shown')
  })

  test('DEBUG_AGENTS=true lets INFO through', () => {
    const lines = captureLogs()
    setupLogging({ debugMode: true })
    lines.length = 0

    getLogger('T').info('shown')

    expect(lines).toHaveLength(1)
  })

  test('returns the same logger for the same name', () => {
    expect(getLogger('Same')).toBe(getLogger('Same'))
  })

  test('exception() appends the stack', () => {
    const lines = captureLogs()
    setupLogging({ level: 'error' as LogLevel })
    lines.length = 0

    getLogger('T').exception('while doing the thing', new Error('boom'))

    expect(lines[0]).toContain('while doing the thing')
    expect(lines[0]).toContain('boom')
  })
})

describe('latency.log line format', () => {
  const startTime = new Date(2026, 7, 21, 14, 3, 11, 42)

  test('matches the Python layout', () => {
    const line = formatLogLine({
      phase: 'sdk_response',
      agentName: 'Narrator',
      roomId: 12,
      durationMs: 1234.5,
      startTime,
      endTime: startTime,
    })

    // phase left-justified to 30, duration right-justified in 8 with 2 decimals
    expect(line).toBe('2026-08-21 14:03:11.042 | sdk_response                   [Narrator] room=12 |  1234.50ms')
  })

  test('omits the agent and room when absent', () => {
    const line = formatLogLine({ phase: 'tape_cell', durationMs: 7, startTime, endTime: startTime })

    expect(line).toBe('2026-08-21 14:03:11.042 | tape_cell                      |     7.00ms')
  })

  test('appends extra fields as key=value', () => {
    const line = formatLogLine({
      phase: 'tool_call',
      durationMs: 1,
      startTime,
      endTime: startTime,
      extra: { success: true, tool: 'narration' },
    })

    // The duration is right-justified in eight columns, so the pipe is not adjacent.
    expect(line).toEndWith('|     1.00ms success=true tool=narration')
  })
})

describe('PerfLogger', () => {
  test('writes nothing when disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-perf-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'latency.log')

    const perf = new PerfLogger(false, path)
    await perf.track('phase', {}, async () => 'result')
    perf.log('other', 5)

    expect(() => readFileSync(path, 'utf-8')).toThrow()
  })

  test('records timings and a session summary when enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-perf-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'latency.log')

    const perf = new PerfLogger(true, path)
    const result = await perf.track('sdk_response', { agentName: 'Narrator', roomId: 3 }, async () => {
      await Bun.sleep(5)
      return 'value'
    })
    perf.writeSummary()

    expect(result).toBe('value')
    const contents = readFileSync(path, 'utf-8')
    expect(contents).toContain('Performance Logging Session Started')
    expect(contents).toContain('sdk_response')
    expect(contents).toContain('[Narrator] room=3')
    expect(contents).toContain('Session Summary')

    const stats = perf.getSummary().phases?.sdk_response
    expect(stats?.count).toBe(1)
    expect(stats?.minMs).toBeGreaterThan(0)
  })

  test('records the timing even when the tracked block throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-perf-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'latency.log')

    const perf = new PerfLogger(true, path)
    await expect(
      perf.track('failing', {}, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(readFileSync(path, 'utf-8')).toContain('failing')
    expect(perf.getSummary().totalEntries).toBe(1)
  })

  test('brackets an interaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-perf-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'latency.log')

    const perf = new PerfLogger(true, path)
    perf.logInteractionStart(3, 'go north')
    perf.logInteractionEnd(3, 1500, 4)

    const contents = readFileSync(path, 'utf-8')
    expect(contents).toContain('--- Interaction #1 | Room 3 ---')
    expect(contents).toContain('msg_len=8')
    expect(contents).toContain('INTERACTION_COMPLETE')
    expect(contents).toContain('agents=4')
  })

  test.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['', false],
    [undefined, false],
  ])('PERF_LOG=%s enables logging: %s', (value, expected) => {
    expect(isPerfLoggingEnabled({ PERF_LOG: value })).toBe(expected)
  })
})

describe('formatMessageForDebug', () => {
  test('renders indented JSON', () => {
    const output = formatMessageForDebug({ type: 'assistant', text: 'hello' })

    expect(JSON.parse(output)).toEqual({ type: 'assistant', text: 'hello' })
    expect(output).toContain('\n  ')
  })

  test('truncates long strings and says by how much', () => {
    const output = formatMessageForDebug({ text: 'x'.repeat(1200) })

    expect(output).toContain('(truncated, total 1200 chars)')
    expect(output.length).toBeLessThan(1200)
  })

  test('drops thinking signatures', () => {
    // Hundreds of opaque characters that bury everything printed around them.
    const output = formatMessageForDebug({ thinking: 'considering', signature: 'A'.repeat(300) })

    expect(output).toContain('considering')
    expect(output).not.toContain('AAA')
  })

  test('survives a cycle instead of throwing', () => {
    const message: Record<string, unknown> = { type: 'assistant' }
    message.self = message

    expect(formatMessageForDebug(message)).toContain('[circular]')
  })
})

describe('turn telemetry adapter', () => {
  function perfIn(dir: string): PerfLogger {
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return new PerfLogger(true, join(dir, 'latency.log'))
  }

  function streamEnd(tempId: string, overrides: Partial<Extract<TurnEvent, { type: 'stream_end' }>> = {}) {
    return {
      type: 'stream_end' as const,
      tempId,
      responseText: 'narrated',
      thinkingText: '',
      narrationText: '',
      sessionId: 'sess-1',
      memoryEntries: [],
      anthropicCalls: [],
      skipped: false,
      structuredOutput: undefined,
      usage: undefined,
      interrupted: false,
      ...overrides,
    }
  }

  test('times each agent from stream_start to stream_end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-telemetry-'))
    const perf = perfIn(dir)
    const telemetry = createTurnTelemetry({ roomId: 4, perf })

    telemetry.onEvent({ name: 'Narrator' }, { type: 'stream_start', tempId: 't1' })
    telemetry.onEvent({ name: 'Narrator' }, streamEnd('t1'))

    const stats = perf.getSummary().phases?.sdk_response
    expect(stats?.count).toBe(1)
    expect(readFileSync(join(dir, 'latency.log'), 'utf-8')).toContain('[Narrator] room=4')
  })

  test('ignores a stream_end with no matching start', () => {
    // A partially-consumed stream must not produce a timing measured from zero,
    // which would land as a multi-decade duration in the phase averages.
    const perf = perfIn(mkdtempSync(join(tmpdir(), 'cw-telemetry-')))
    const telemetry = createTurnTelemetry({ roomId: 4, perf })

    telemetry.onEvent({ name: 'Narrator' }, streamEnd('orphan'))

    expect(perf.getSummary().totalEntries).toBe(0)
  })

  test('records only the hook event that carries a duration', () => {
    const perf = perfIn(mkdtempSync(join(tmpdir(), 'cw-telemetry-')))
    const telemetry = createTurnTelemetry({ roomId: 4, perf })

    telemetry.onTelemetry({ kind: 'tool_used', agentName: 'A', roomId: 4, toolName: 'narration' })
    telemetry.onTelemetry({
      kind: 'subagent_completed',
      agentName: 'A',
      roomId: 4,
      subagentType: 'item_designer',
      durationMs: 250,
      matched: true,
    })

    const summary = perf.getSummary()
    expect(summary.totalEntries).toBe(1)
    expect(summary.phases?.subagent?.totalMs).toBe(250)
  })

  test('brackets an interaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-telemetry-'))
    const perf = perfIn(dir)
    const telemetry = createTurnTelemetry({ roomId: 4, perf })

    telemetry.interaction('go north')(3)

    const contents = readFileSync(join(dir, 'latency.log'), 'utf-8')
    expect(contents).toContain('--- Interaction #1 | Room 4 ---')
    expect(contents).toContain('agents=3')
  })
})
