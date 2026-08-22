/**
 * Writes to the repo-level `agents/` tree.
 *
 * Every test runs against a throwaway project root, because every method here
 * writes: the real `agents/` tree is checked in and hand-edited, and a suite
 * that appends a memory to it would be editing a developer's character.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentConfigService } from '../services/agent-config-service'

let projectRoot: string
let service: AgentConfigService

/** Folder path relative to the project root — the `config_file` column's form. */
const AGENT_CONFIG_FILE = join('agents', 'Kris')

function agentFolder(...parts: string[]): string {
  return join(projectRoot, 'agents', ...parts)
}

function makeAgent(name: string, files: Record<string, string> = {}): string {
  const folder = agentFolder(name)
  mkdirSync(folder, { recursive: true })
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(folder, filename), content, 'utf-8')
  }
  return folder
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cw-agent-config-'))
  mkdirSync(join(projectRoot, 'agents'))
  service = new AgentConfigService(projectRoot)
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

// ============================================================================
// recent_events.md
// ============================================================================

describe('appendToRecentEvents', () => {
  test('stamps in-world time and zero-pads the clock', () => {
    makeAgent('Kris')

    expect(service.appendToRecentEvents(AGENT_CONFIG_FILE, 'Met the traveller', { day: 3, hour: 9, minute: 5 })).toBe(true)
    expect(readFileSync(agentFolder('Kris', 'recent_events.md'), 'utf-8')).toBe(
      '\n- [Day 3, 09:05] Met the traveller\n',
    )
  })

  test('appends to an existing file, blank line between entries', () => {
    makeAgent('Kris', { 'recent_events.md': '# Recent Events\n' })

    service.appendToRecentEvents(AGENT_CONFIG_FILE, 'first', { day: 1, hour: 0, minute: 0 })
    service.appendToRecentEvents(AGENT_CONFIG_FILE, 'second', { day: 1, hour: 12, minute: 30 })

    expect(readFileSync(agentFolder('Kris', 'recent_events.md'), 'utf-8')).toBe(
      '# Recent Events\n\n- [Day 1, 00:00] first\n\n- [Day 1, 12:30] second\n',
    )
  })

  test('falls back to the UTC calendar date with no game time', () => {
    makeAgent('Kris')
    const today = new Date().toISOString().slice(0, 10)

    service.appendToRecentEvents(AGENT_CONFIG_FILE, 'out of game', null)

    expect(readFileSync(agentFolder('Kris', 'recent_events.md'), 'utf-8')).toBe(`\n- [${today}] out of game\n`)
  })

  test('an empty game time is falsy in Python, so it takes the date branch too', () => {
    makeAgent('Kris')
    const today = new Date().toISOString().slice(0, 10)

    service.appendToRecentEvents(AGENT_CONFIG_FILE, 'no clock', {})

    expect(readFileSync(agentFolder('Kris', 'recent_events.md'), 'utf-8')).toBe(`\n- [${today}] no clock\n`)
  })

  test('a partial game time defaults day 1, 00:00', () => {
    makeAgent('Kris')

    service.appendToRecentEvents(AGENT_CONFIG_FILE, 'partial', { hour: 7 })

    expect(readFileSync(agentFolder('Kris', 'recent_events.md'), 'utf-8')).toBe('\n- [Day 1, 07:00] partial\n')
  })

  test('an empty config_file is refused rather than resolved to the project root', () => {
    expect(service.appendToRecentEvents('', 'nowhere')).toBe(false)
    expect(service.appendToRecentEvents(null, 'nowhere')).toBe(false)
    expect(existsSync(join(projectRoot, 'recent_events.md'))).toBe(false)
  })

  test('a config path that is not a directory creates nothing', () => {
    writeFileSync(agentFolder('not-a-folder'), 'i am a file', 'utf-8')

    expect(service.appendToRecentEvents(join('agents', 'not-a-folder'), 'nope')).toBe(false)
    expect(service.appendToRecentEvents(join('agents', 'missing'), 'nope')).toBe(false)
    expect(existsSync(agentFolder('missing'))).toBe(false)
  })

  test('grouped agents are addressed by their full config_file path', () => {
    makeAgent(join('group_steinsgate', 'Kris'))

    expect(
      service.appendToRecentEvents(join('agents', 'group_steinsgate', 'Kris'), 'grouped', {
        day: 2,
        hour: 1,
        minute: 2,
      }),
    ).toBe(true)
    expect(readFileSync(agentFolder('group_steinsgate', 'Kris', 'recent_events.md'), 'utf-8')).toBe(
      '\n- [Day 2, 01:02] grouped\n',
    )
  })
})

// ============================================================================
// loadAgentConfig
// ============================================================================

describe('loadAgentConfig', () => {
  test('reads the folder relative to this service, not to global settings', () => {
    makeAgent('Kris', {
      'in_a_nutshell.md': 'Kris is a physicist.\n',
      'characteristics.md': 'Blunt, brilliant.\n',
      'profile.png': 'x',
    })

    const config = service.loadAgentConfig(AGENT_CONFIG_FILE)

    expect(config?.inANutshell).toBe('Kris is a physicist.')
    expect(config?.characteristics).toBe('Blunt, brilliant.')
    expect(config?.profilePic).toBe('profile.png')
  })

  test('missing folders and empty paths return null instead of throwing', () => {
    expect(service.loadAgentConfig(join('agents', 'ghost'))).toBeNull()
    expect(service.loadAgentConfig('')).toBeNull()
    expect(service.loadAgentConfig(null)).toBeNull()
  })
})

// ============================================================================
// profile.*
// ============================================================================

describe('saveBase64ProfilePic', () => {
  /** `aGVsbG8=` is "hello"; nothing on this path decodes the image itself. */
  const PNG_URL = 'data:image/png;base64,aGVsbG8='

  test('writes the decoded bytes through unmodified', () => {
    expect(service.saveBase64ProfilePic('Kris', PNG_URL)).toBe(true)
    expect(readFileSync(agentFolder('Kris', 'profile.png'), 'utf-8')).toBe('hello')
  })

  test('creates the agent folder when the agent is new', () => {
    service.saveBase64ProfilePic('Newcomer', PNG_URL)
    expect(existsSync(agentFolder('Newcomer', 'profile.png'))).toBe(true)
  })

  test('jpeg and jpg both land on .jpg, unknown subtypes on .png', () => {
    service.saveBase64ProfilePic('A', 'data:image/jpeg;base64,aGVsbG8=')
    service.saveBase64ProfilePic('B', 'data:image/jpg;base64,aGVsbG8=')
    service.saveBase64ProfilePic('C', 'data:image/tiff;base64,aGVsbG8=')

    expect(readdirSync(agentFolder('A'))).toEqual(['profile.jpg'])
    expect(readdirSync(agentFolder('B'))).toEqual(['profile.jpg'])
    expect(readdirSync(agentFolder('C'))).toEqual(['profile.png'])
  })

  test('replaces every other profile.* but leaves the rest of the folder alone', () => {
    makeAgent('Kris', {
      'profile.jpg': 'old jpeg',
      'profile.webp': 'old webp',
      'avatar.png': 'a different picture',
      'in_a_nutshell.md': 'Kris is a physicist.',
    })

    expect(service.saveBase64ProfilePic('Kris', PNG_URL)).toBe(true)

    expect(readdirSync(agentFolder('Kris')).sort()).toEqual([
      'avatar.png',
      'in_a_nutshell.md',
      'profile.png',
    ])
  })

  test('re-uploading the same extension overwrites in place', () => {
    makeAgent('Kris', { 'profile.png': 'old' })

    expect(service.saveBase64ProfilePic('Kris', PNG_URL)).toBe(true)
    expect(readFileSync(agentFolder('Kris', 'profile.png'), 'utf-8')).toBe('hello')
  })

  test('a non-data-URL is refused and writes nothing', () => {
    expect(service.saveBase64ProfilePic('Kris', 'https://example.com/pic.png')).toBe(false)
    expect(service.saveBase64ProfilePic('Kris', 'data:image/png;base64,')).toBe(false)
    expect(service.saveBase64ProfilePic('Kris', 'aGVsbG8=')).toBe(false)
    expect(existsSync(agentFolder('Kris'))).toBe(false)
  })

  test('a payload that decodes to nothing is refused rather than written empty', () => {
    // Buffer.from drops what it cannot decode instead of throwing the way
    // Python's b64decode does, so this is the guard that stands in for it.
    expect(service.saveBase64ProfilePic('Kris', 'data:image/png;base64,!!!')).toBe(false)
    expect(existsSync(agentFolder('Kris'))).toBe(false)
  })

  test('svg+xml is unreachable — the \\w+ subtype pattern rejects the plus', () => {
    // Landmine, reproduced from Python: the extension map has an `svg+xml`
    // entry that no data URL can ever reach.
    expect(service.saveBase64ProfilePic('Kris', 'data:image/svg+xml;base64,aGVsbG8=')).toBe(false)
    expect(service.saveBase64ProfilePic('Kris', 'data:image/svg;base64,aGVsbG8=')).toBe(true)
    expect(readdirSync(agentFolder('Kris'))).toEqual(['profile.svg'])
  })

  test('a grouped agent gets a stray top-level folder, as in Python', () => {
    makeAgent(join('group_steinsgate', 'Kris'), { 'in_a_nutshell.md': 'Kris is a physicist.' })

    expect(service.saveBase64ProfilePic('Kris', PNG_URL)).toBe(true)

    expect(existsSync(agentFolder('Kris', 'profile.png'))).toBe(true)
    expect(existsSync(agentFolder('group_steinsgate', 'Kris', 'profile.png'))).toBe(false)
  })
})
