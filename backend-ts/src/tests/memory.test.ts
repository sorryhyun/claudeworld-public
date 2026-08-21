import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getMemoryBySubtitle, getMemorySubtitles, parseLongTermMemory } from '../sdk/parsing/memory'

let dir: string
let memoryFile: string

const MEMORY_FIXTURE = [
  'This preamble sits before any heading and must be discarded.',
  '',
  '## [첫 만남]',
  '프리렌은 힘멜을 처음 만났다.',
  '',
  '그 날은 맑았다.',
  '',
  '## [수련]',
  'Content with a plain ## heading inside:',
  '## Not a memory heading',
  '',
  '## [empty]',
].join('\n')

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-memory-'))
  memoryFile = join(dir, 'consolidated_memory.md')
  writeFileSync(memoryFile, MEMORY_FIXTURE, 'utf-8')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseLongTermMemory', () => {
  test('keys by subtitle, in file order', () => {
    expect(Object.keys(parseLongTermMemory(memoryFile))).toEqual(['첫 만남', '수련', 'empty'])
  })

  test('accumulates content until the next subtitle heading, trimmed', () => {
    expect(parseLongTermMemory(memoryFile)['첫 만남']).toBe(
      '프리렌은 힘멜을 처음 만났다.\n\n그 날은 맑았다.',
    )
  })

  test('a ## heading without brackets is content, not a new memory', () => {
    expect(parseLongTermMemory(memoryFile)['수련']).toBe(
      'Content with a plain ## heading inside:\n## Not a memory heading',
    )
  })

  test('a trailing subtitle with no body yields an empty string', () => {
    expect(parseLongTermMemory(memoryFile).empty).toBe('')
  })

  test('text before the first subtitle is dropped', () => {
    expect(JSON.stringify(parseLongTermMemory(memoryFile))).not.toContain('preamble')
  })

  test('missing file yields an empty index rather than throwing', () => {
    expect(parseLongTermMemory(join(dir, 'nope.md'))).toEqual({})
  })

  test('tolerates whitespace between ## and the bracket', () => {
    const file = join(dir, 'spaced.md')
    writeFileSync(file, '##   [spaced]\nbody', 'utf-8')
    expect(parseLongTermMemory(file)).toEqual({ spaced: 'body' })
  })
})

describe('subtitle accessors', () => {
  test('getMemorySubtitles returns the keys', () => {
    expect(getMemorySubtitles(memoryFile)).toEqual(['첫 만남', '수련', 'empty'])
  })

  test('getMemoryBySubtitle looks one up, or returns null', () => {
    expect(getMemoryBySubtitle(memoryFile, '수련')).toContain('plain ## heading')
    expect(getMemoryBySubtitle(memoryFile, 'absent')).toBeNull()
  })
})
