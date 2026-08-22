/**
 * Character agents inside a world — `worlds/{name}/agents/`.
 *
 * Every method here writes, so the suite builds a world from scratch in a temp
 * directory rather than copying the checked-in fixture: what these tests care
 * about is the agent subtree, and `WorldService.createWorld` already guarantees
 * the rest of the world exists around it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentFilesystemService } from '../services/agent-filesystem-service'
import { WorldService } from '../services/world-service'

const WORLD = 'testworld'

let worldsDir: string
let service: AgentFilesystemService

function agentsDir(...parts: string[]): string {
  return join(worldsDir, WORLD, 'agents', ...parts)
}

/** Write a character folder directly, bypassing the service under test. */
function seedAgent(name: string, files: Record<string, string>): void {
  mkdirSync(agentsDir(name), { recursive: true })
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(agentsDir(name, filename), content, 'utf-8')
  }
}

beforeEach(() => {
  worldsDir = mkdtempSync(join(tmpdir(), 'cw-world-agents-'))
  new WorldService(worldsDir).createWorld(WORLD, 'admin')
  service = new AgentFilesystemService(worldsDir)
})

afterEach(() => {
  rmSync(worldsDir, { recursive: true, force: true })
})

// ============================================================================
// createAgent
// ============================================================================

describe('createAgent', () => {
  test('writes both identity files verbatim', () => {
    service.createAgent(WORLD, 'Old_Miller', 'The miller.', '## Role\nMiller\n')

    expect(readFileSync(agentsDir('Old_Miller', 'in_a_nutshell.md'), 'utf-8')).toBe('The miller.')
    expect(readFileSync(agentsDir('Old_Miller', 'characteristics.md'), 'utf-8')).toBe('## Role\nMiller\n')
  })

  test('empty identity files are still written, so the folder counts as an agent', () => {
    service.createAgent(WORLD, 'Blank', '', '')

    expect(existsSync(agentsDir('Blank', 'in_a_nutshell.md'))).toBe(true)
    expect(service.listWorldAgents(WORLD)).toEqual(['Blank'])
  })

  test('copies a profile picture, keeping its extension', () => {
    const source = join(worldsDir, 'source-avatar.webp')
    writeFileSync(source, 'image bytes', 'utf-8')

    service.createAgent(WORLD, 'Old_Miller', 'The miller.', 'gruff', source)

    expect(readFileSync(agentsDir('Old_Miller', 'profile.webp'), 'utf-8')).toBe('image bytes')
  })

  test('a profile picture path that does not exist is ignored, not fatal', () => {
    service.createAgent(WORLD, 'Old_Miller', 'The miller.', 'gruff', join(worldsDir, 'nope.png'))

    expect(readdirSync(agentsDir('Old_Miller')).sort()).toEqual([
      'characteristics.md',
      'in_a_nutshell.md',
    ])
  })

  test('creating over an existing character replaces its files', () => {
    service.createAgent(WORLD, 'Old_Miller', 'first', 'first')
    service.createAgent(WORLD, 'Old_Miller', 'second', 'second')

    expect(readFileSync(agentsDir('Old_Miller', 'in_a_nutshell.md'), 'utf-8')).toBe('second')
  })

  test('a world whose agents/ directory is missing still gets one', () => {
    rmSync(agentsDir(), { recursive: true, force: true })

    service.createAgent(WORLD, 'Old_Miller', 'The miller.', 'gruff')

    expect(existsSync(agentsDir('Old_Miller', 'in_a_nutshell.md'))).toBe(true)
  })
})

// ============================================================================
// Listing
// ============================================================================

describe('listWorldAgents', () => {
  test('lists folders holding at least one identity file, sorted', () => {
    seedAgent('Zelda', { 'in_a_nutshell.md': 'z' })
    seedAgent('Apple', { 'characteristics.md': 'a' })
    seedAgent('Middle', { 'in_a_nutshell.md': 'm', 'characteristics.md': 'm' })

    expect(service.listWorldAgents(WORLD)).toEqual(['Apple', 'Middle', 'Zelda'])
  })

  test('skips folders with no identity file and loose files', () => {
    seedAgent('Real', { 'in_a_nutshell.md': 'r' })
    mkdirSync(agentsDir('EmptyFolder'), { recursive: true })
    seedAgent('OnlyNotes', { 'notes.md': 'not an identity file' })
    writeFileSync(agentsDir('stray.md'), 'loose file', 'utf-8')

    expect(service.listWorldAgents(WORLD)).toEqual(['Real'])
  })

  test('underscore-prefixed folders are internal and never listed', () => {
    seedAgent('Real', { 'in_a_nutshell.md': 'r' })
    seedAgent(join('_archived', 'Ghost_20260101_000000'), { 'in_a_nutshell.md': 'g' })

    expect(service.listWorldAgents(WORLD)).toEqual(['Real'])
  })

  test('a world with no agents/ directory lists nothing rather than throwing', () => {
    rmSync(agentsDir(), { recursive: true, force: true })

    expect(service.listWorldAgents(WORLD)).toEqual([])
    expect(service.listWorldAgents('no-such-world')).toEqual([])
  })
})

// ============================================================================
// Details
// ============================================================================

describe('getAgentDetails', () => {
  test('trims the nutshell and returns an absolute profile path', () => {
    seedAgent('Old_Miller', {
      'in_a_nutshell.md': '  The miller of the old mill.  \n\n',
      'profile.png': 'x',
    })

    const details = service.getAgentDetails(WORLD, 'Old_Miller')

    expect(details).toEqual({
      name: 'Old_Miller',
      folderName: 'Old_Miller',
      inANutshell: 'The miller of the old mill.',
      profilePic: agentsDir('Old_Miller', 'profile.png'),
    })
  })

  test('name and folderName are the same string — the docstring promise is unimplemented', () => {
    seedAgent('Old_Miller', { 'in_a_nutshell.md': 'x' })

    const details = service.getAgentDetails(WORLD, 'Old_Miller')

    expect(details?.name).toBe(details?.folderName)
    expect(details?.name).toBe('Old_Miller')
  })

  test('a character with no nutshell and no picture reports empties, not null', () => {
    seedAgent('Sparse', { 'characteristics.md': 'gruff' })

    expect(service.getAgentDetails(WORLD, 'Sparse')).toEqual({
      name: 'Sparse',
      folderName: 'Sparse',
      inANutshell: '',
      profilePic: null,
    })
  })

  test('conventional picture names win over an arbitrary image', () => {
    seedAgent('Old_Miller', { 'in_a_nutshell.md': 'x', 'aaa-screenshot.png': 'x', 'avatar.jpg': 'x' })

    expect(service.getAgentDetails(WORLD, 'Old_Miller')?.profilePic).toBe(
      agentsDir('Old_Miller', 'avatar.jpg'),
    )
  })

  test('a missing character is null', () => {
    expect(service.getAgentDetails(WORLD, 'Nobody')).toBeNull()
    expect(service.getAgentDetails('no-such-world', 'Nobody')).toBeNull()
  })
})

describe('listWorldAgentsWithDetails', () => {
  test('resolves every listed character, in listing order', () => {
    seedAgent('Zelda', { 'in_a_nutshell.md': 'the second' })
    seedAgent('Apple', { 'in_a_nutshell.md': 'the first' })

    expect(service.listWorldAgentsWithDetails(WORLD).map((a) => [a.name, a.inANutshell])).toEqual([
      ['Apple', 'the first'],
      ['Zelda', 'the second'],
    ])
  })

  test('an empty world yields an empty list', () => {
    expect(service.listWorldAgentsWithDetails(WORLD)).toEqual([])
  })
})

// ============================================================================
// archiveAgent
// ============================================================================

describe('archiveAgent', () => {
  test('moves the folder under _archived with a UTC timestamp suffix', () => {
    seedAgent('Old_Miller', { 'in_a_nutshell.md': 'The miller.', 'recent_events.md': 'died' })

    expect(service.archiveAgent(WORLD, 'Old_Miller')).toBe(true)

    expect(existsSync(agentsDir('Old_Miller'))).toBe(false)
    const archived = readdirSync(agentsDir('_archived'))
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatch(/^Old_Miller_\d{8}_\d{6}$/)
    // The character's files survive the move — archiving is not deletion.
    expect(readFileSync(agentsDir('_archived', archived[0] ?? '', 'recent_events.md'), 'utf-8')).toBe('died')
  })

  test('an archived character stops being listed', () => {
    seedAgent('Old_Miller', { 'in_a_nutshell.md': 'The miller.' })
    seedAgent('Baker', { 'in_a_nutshell.md': 'The baker.' })

    service.archiveAgent(WORLD, 'Old_Miller')

    expect(service.listWorldAgents(WORLD)).toEqual(['Baker'])
  })

  test('a missing character is a false, not a throw', () => {
    expect(service.archiveAgent(WORLD, 'Nobody')).toBe(false)
    expect(existsSync(agentsDir('_archived'))).toBe(false)
  })

  test('the archive directory is created on first use and reused after', () => {
    seedAgent('One', { 'in_a_nutshell.md': '1' })
    seedAgent('Two', { 'in_a_nutshell.md': '2' })

    expect(service.archiveAgent(WORLD, 'One')).toBe(true)
    expect(service.archiveAgent(WORLD, 'Two')).toBe(true)

    expect(readdirSync(agentsDir('_archived'))).toHaveLength(2)
  })
})
