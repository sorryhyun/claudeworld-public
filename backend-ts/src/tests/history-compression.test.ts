/**
 * History compression.
 *
 * The summarizer is a stub in every test here, which is the whole reason
 * `HistoryCompressionService` takes one: the parsing, batching and file
 * rewriting is what can silently lose a player's history, and none of it needs
 * a model. What the stub *is* asked to prove is that it received exactly the
 * text the real summarizer would have — hence the assertions on the recorded
 * requests rather than only on the output.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgent } from '../crud/agents'
import { openDb, type Db } from '../db'
import { applyMigrations, loadMigrations } from '../db/migrate'
import { AgentConfigService } from '../services/agent-config-service'
import {
  BATCH_SIZE,
  HistoryCompressionService,
  buildSummarizerPrompt,
  formatBatchForSummarizer,
  groupTurnsIntoBatches,
  parseHistoryIntoTurns,
  type SummarizeRequest,
  type TurnEntry,
} from '../services/history-compression-service'
import { WorldService } from '../services/world-service'

const migrations = loadMigrations()

const WORLD = 'mythos'

// ============================================================================
// Parsing — no fixtures, no database
// ============================================================================

describe('parseHistoryIntoTurns', () => {
  const HISTORY = `# World History

## Turn 1 - tavern
Met the innkeeper.
Bought a room.

## Turn 4 - road
Walked north.
`

  test('splits on the turn headings and keeps the bodies', () => {
    expect(parseHistoryIntoTurns(HISTORY)).toEqual([
      { turnNumber: 1, location: 'tavern', content: 'Met the innkeeper.\nBought a room.' },
      { turnNumber: 4, location: 'road', content: 'Walked north.' },
    ])
  })

  test('the file title is dropped rather than folded into the first turn', () => {
    expect(parseHistoryIntoTurns(HISTORY)[0]?.content).not.toContain('World History')
  })

  test('turn numbers are not assumed contiguous', () => {
    // Entries are written on travel, not every turn, so gaps are normal.
    expect(parseHistoryIntoTurns(HISTORY).map((t) => t.turnNumber)).toEqual([1, 4])
  })

  test('a location name containing a dash survives intact', () => {
    const turns = parseHistoryIntoTurns('## Turn 2 - the half-sunken - docks\nSaw a ship.\n')
    expect(turns[0]?.location).toBe('the half-sunken - docks')
  })

  test('a non-ASCII location name survives intact', () => {
    expect(parseHistoryIntoTurns('## Turn 3 - 마법의 숲\n숲에 들어갔다.\n')[0]).toEqual({
      turnNumber: 3,
      location: '마법의 숲',
      content: '숲에 들어갔다.',
    })
  })

  test('a headingless file yields nothing rather than one giant entry', () => {
    expect(parseHistoryIntoTurns('# World History\n\nsomething unstructured\n')).toEqual([])
    expect(parseHistoryIntoTurns('')).toEqual([])
  })

  test('a heading that is not at the start of a line is not a heading', () => {
    expect(parseHistoryIntoTurns('text ## Turn 1 - tavern\nbody\n')).toEqual([])
  })

  test('an empty body is kept as an empty string', () => {
    expect(parseHistoryIntoTurns('## Turn 1 - tavern\n\n## Turn 2 - road\nx\n')[0]?.content).toBe('')
  })
})

describe('groupTurnsIntoBatches', () => {
  const turns = (n: number): TurnEntry[] =>
    Array.from({ length: n }, (_, i) => ({ turnNumber: i + 1, location: 'x', content: 'y' }))

  test('chunks in order at the default batch size', () => {
    const batches = groupTurnsIntoBatches(turns(6))

    expect(BATCH_SIZE).toBe(3)
    expect(batches).toHaveLength(2)
    expect(batches[0]!.map((t) => t.turnNumber)).toEqual([1, 2, 3])
    expect(batches[1]!.map((t) => t.turnNumber)).toEqual([4, 5, 6])
  })

  test('the last batch is short rather than padded or merged', () => {
    const batches = groupTurnsIntoBatches(turns(7))

    expect(batches).toHaveLength(3)
    expect(batches[2]!.map((t) => t.turnNumber)).toEqual([7])
  })

  test('no turns means no batches', () => {
    expect(groupTurnsIntoBatches([])).toEqual([])
  })

  test('a batch size of 1 gives one section per turn', () => {
    expect(groupTurnsIntoBatches(turns(3), 1)).toHaveLength(3)
  })

  test('a non-positive batch size is rejected instead of looping forever', () => {
    expect(() => groupTurnsIntoBatches(turns(3), 0)).toThrow(RangeError)
    expect(() => groupTurnsIntoBatches(turns(3), -1)).toThrow(RangeError)
    expect(() => groupTurnsIntoBatches(turns(3), 1.5)).toThrow(RangeError)
  })
})

describe('formatBatchForSummarizer', () => {
  test('round-trips back into the form it was parsed from', () => {
    const source = '## Turn 1 - tavern\nMet the innkeeper.\n\n## Turn 2 - road\nWalked north.\n'
    const formatted = formatBatchForSummarizer(parseHistoryIntoTurns(source))

    expect(formatted).toBe(
      '## Turn 1 - tavern\nMet the innkeeper.\n\n## Turn 2 - road\nWalked north.\n',
    )
    // …and parses back to the same entries.
    expect(parseHistoryIntoTurns(formatted)).toEqual(parseHistoryIntoTurns(source))
  })

  test('an empty batch renders as an empty string', () => {
    expect(formatBatchForSummarizer([])).toBe('')
  })
})

describe('buildSummarizerPrompt', () => {
  test('wraps the batch in the output-format instruction', () => {
    const prompt = buildSummarizerPrompt('## Turn 1 - tavern\nMet the innkeeper.\n')

    expect(prompt).toContain('## Turn Entries to Compress')
    expect(prompt).toContain('Met the innkeeper.')
    expect(prompt).toContain('## [meaningful_subtitle_here]')
  })
})

// ============================================================================
// compressHistory — real files, real rows, stub model
// ============================================================================

describe('compressHistory', () => {
  let dir: string
  let worldsDir: string
  let db: Db
  let worlds: WorldService
  let requests: SummarizeRequest[]

  /** Build a service whose summarizer returns `reply(i)` for the i-th batch. */
  function serviceReturning(
    reply: (index: number, request: SummarizeRequest) => string | null,
  ): HistoryCompressionService {
    let index = 0
    return new HistoryCompressionService(
      (request) => {
        requests.push(request)
        return Promise.resolve(reply(index++, request))
      },
      worldsDir,
      new AgentConfigService(dir),
    )
  }

  function seedSummarizerAgent(): void {
    mkdirSync(join(dir, 'agents', 'group_gameplay', 'History_Summarizer'), { recursive: true })
    writeFileSync(
      join(dir, 'agents', 'group_gameplay', 'History_Summarizer', 'in_a_nutshell.md'),
      'History_Summarizer condenses a world log.',
      'utf-8',
    )
    createAgent(db, {
      name: 'History_Summarizer',
      systemPrompt: 'stale prompt from the database',
      group: 'gameplay',
      configFile: 'agents/group_gameplay/History_Summarizer',
    })
  }

  function writeHistory(turnCount: number): void {
    const body = Array.from(
      { length: turnCount },
      (_, i) => `## Turn ${i + 1} - place${i + 1}\nSomething happened (${i + 1}).\n`,
    ).join('\n')
    writeFileSync(join(worldsDir, WORLD, 'history.md'), `# World History\n\n${body}`, 'utf-8')
  }

  function readWorldFile(name: string): string {
    return readFileSync(join(worldsDir, WORLD, name), 'utf-8')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-history-'))
    worldsDir = join(dir, 'worlds')
    mkdirSync(worldsDir, { recursive: true })

    const raw = new Database(join(dir, 'test.db'), { create: true, strict: true })
    try {
      applyMigrations(raw, migrations)
    } finally {
      raw.close()
    }
    db = openDb({ path: join(dir, 'test.db') })

    worlds = new WorldService(worldsDir)
    worlds.createWorld(WORLD, 'admin')
    requests = []
  })

  afterEach(() => {
    db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a fresh world has nothing to compress', async () => {
    seedSummarizerAgent()

    const result = await serviceReturning(() => 'x').compressHistory(db, WORLD)

    expect(result).toEqual({
      success: true,
      turns_compressed: 0,
      sections_created: 0,
      message: 'No history to compress',
    })
    expect(requests).toEqual([])
  })

  test('a history with content but no turn headings is left alone', async () => {
    seedSummarizerAgent()
    writeFileSync(join(worldsDir, WORLD, 'history.md'), '# World History\n\nfree text\n', 'utf-8')

    const result = await serviceReturning(() => 'x').compressHistory(db, WORLD)

    expect(result.message).toBe('No turn entries found in history')
    expect(readWorldFile('history.md')).toContain('free text')
  })

  test('compresses in batches, writes the sections and clears history.md', async () => {
    seedSummarizerAgent()
    writeHistory(4)

    const result = await serviceReturning((i) => `## [section ${i}]\nSummary ${i}.`)
      .compressHistory(db, WORLD)

    expect(result).toEqual({
      success: true,
      turns_compressed: 4,
      sections_created: 2,
      message: 'Compressed 4 turns into 2 sections',
    })

    expect(readWorldFile('consolidated_history.md')).toBe(
      '## [section 0]\nSummary 0.\n\n## [section 1]\nSummary 1.',
    )
    expect(readWorldFile('history.md')).toBe('# World History\n\n')
  })

  test('the cleared history.md is visible to the next read, not served from cache', async () => {
    seedSummarizerAgent()
    writeHistory(3)
    // Warm the mtime cache with the pre-compression content.
    expect(worlds.loadHistory(WORLD)).toContain('Turn 1')

    const service = serviceReturning(() => '## [s]\nx')
    await service.compressHistory(db, WORLD)

    // A second run must see the emptied file. Same-millisecond writes are
    // exactly the case the explicit invalidation exists for.
    expect((await service.compressHistory(db, WORLD)).message).toBe('No history to compress')
  })

  test('the sections it produces are readable back through WorldService', async () => {
    seedSummarizerAgent()
    writeHistory(2)

    await serviceReturning(() => '## [the long road]\nThey walked.').compressHistory(db, WORLD)

    expect(worlds.getHistorySubtitles(WORLD)).toEqual(['the long road'])
    expect(worlds.getHistoryBySubtitle(WORLD, 'the long road')).toBe('They walked.')
  })

  test('appending to an existing file leaves exactly one blank line', async () => {
    seedSummarizerAgent()
    writeFileSync(
      join(worldsDir, WORLD, 'consolidated_history.md'),
      '## [earlier]\nBefore all this.\n\n\n',
      'utf-8',
    )
    writeHistory(1)

    await serviceReturning(() => '## [later]\nAnd then.').compressHistory(db, WORLD)

    expect(readWorldFile('consolidated_history.md')).toBe(
      '## [earlier]\nBefore all this.\n\n## [later]\nAnd then.',
    )
  })

  test('the summarizer is handed the batch verbatim and a filesystem-built prompt', async () => {
    seedSummarizerAgent()
    writeHistory(2)

    await serviceReturning(() => '## [s]\nx').compressHistory(db, WORLD)

    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.agent.name).toBe('History_Summarizer')
    expect(request.roomId).toBe(0)
    expect(request.userMessage).toContain('## Turn 1 - place1')
    expect(request.userMessage).toContain('## Turn 2 - place2')
    // Rebuilt from `agents/…/in_a_nutshell.md`, not read from the stale column.
    expect(request.systemPrompt).toContain('History_Summarizer condenses a world log.')
    expect(request.systemPrompt).not.toContain('stale prompt from the database')
  })

  test('an explicit batch size changes how many sections are produced', async () => {
    seedSummarizerAgent()
    writeHistory(4)

    const result = await serviceReturning((i) => `## [s${i}]\nx`).compressHistory(db, WORLD, 1)

    expect(result.sections_created).toBe(4)
    expect(requests).toHaveLength(4)
  })

  test('no summarizer agent in the database means nothing is compressed', async () => {
    writeHistory(3)

    const result = await serviceReturning(() => '## [s]\nx').compressHistory(db, WORLD)

    expect(result).toEqual({
      success: false,
      turns_compressed: 0,
      sections_created: 0,
      message: 'Failed to generate any compressed sections',
    })
    // The whole point of the failure path: the history survives.
    expect(readWorldFile('history.md')).toContain('## Turn 1 - place1')
    expect(existsSync(join(worldsDir, WORLD, 'consolidated_history.md'))).toBe(false)
  })

  test('an agent of the same name outside the gameplay group is not the summarizer', async () => {
    createAgent(db, { name: 'History_Summarizer', systemPrompt: 'x', worldName: WORLD })
    writeHistory(3)

    expect((await serviceReturning(() => '## [s]\nx').compressHistory(db, WORLD)).success).toBe(
      false,
    )
  })

  test('a batch whose summary fails is skipped — and its turns are lost', async () => {
    seedSummarizerAgent()
    writeHistory(6)

    const result = await serviceReturning((i) => (i === 0 ? null : `## [s${i}]\nx`))
      .compressHistory(db, WORLD)

    expect(result.success).toBe(true)
    expect(result.sections_created).toBe(1)
    // Reported as all six turns compressed, and `history.md` is cleared anyway:
    // the three turns in the failed batch are gone for good. Python does the
    // same, and it is reproduced here so the behaviour is pinned rather than
    // rediscovered.
    expect(result.turns_compressed).toBe(6)
    expect(readWorldFile('history.md')).toBe('# World History\n\n')
    expect(readWorldFile('consolidated_history.md')).toBe('## [s1]\nx')
  })

  test('a throwing summarizer costs its batch, not the run', async () => {
    seedSummarizerAgent()
    writeHistory(6)

    const result = await serviceReturning((i) => {
      if (i === 0) throw new Error('model unavailable')
      return `## [s${i}]\nx`
    }).compressHistory(db, WORLD)

    expect(result.success).toBe(true)
    expect(result.sections_created).toBe(1)
  })

  test('an all-whitespace summary counts as a failure', async () => {
    seedSummarizerAgent()
    writeHistory(3)

    expect((await serviceReturning(() => '   \n ').compressHistory(db, WORLD)).success).toBe(false)
  })
})
