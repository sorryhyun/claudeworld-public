import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetSettings } from '../config/settings'
import {
  hasContent,
  listAvailableConfigs,
  parseAgentConfig,
  type AgentConfigData,
} from '../sdk/parsing/agent-config'
import {
  buildRuntimeSystemPrompt,
  buildSystemPrompt,
  toSystemPromptMarkdown,
} from '../services/prompt-builder'

const ACTION_MANAGER_PATH = 'agents/group_gameplay/Action_Manager'

describe('listAvailableConfigs (real agents/ tree)', () => {
  const configs = listAvailableConfigs()

  test('finds the gameplay system agents and strips the group_ prefix', () => {
    expect(configs.Action_Manager).toEqual({ path: ACTION_MANAGER_PATH, group: 'gameplay' })
    expect(configs.Onboarding_Manager?.group).toBe('gameplay')
    expect(configs.Chat_Summarizer?.group).toBe('gameplay')
  })

  test('finds agents in other groups', () => {
    expect(configs.Character_Designer?.group).toBe('subagent')
    expect(configs.Item_Designer?.group).toBe('subagent')
  })

  test('does not treat a group folder itself as an agent', () => {
    expect(configs.group_gameplay).toBeUndefined()
    expect(configs.gameplay).toBeUndefined()
  })
})

describe('parseAgentConfig (real agents/ tree)', () => {
  test('reads the markdown sections of Action_Manager via a project-relative path', () => {
    const config = parseAgentConfig(ACTION_MANAGER_PATH)
    expect(config).not.toBeNull()
    expect(config?.inANutshell).toContain('Action Manager')
    expect(config?.characteristics?.length).toBeGreaterThan(0)
    expect(config?.recentEvents).not.toBeNull()
    expect(hasContent(config as AgentConfigData)).toBe(true)
  })

  test('has no memory index when consolidated_memory.md is absent', () => {
    const config = parseAgentConfig(ACTION_MANAGER_PATH)
    expect(config?.longTermMemoryIndex).toBeNull()
    expect(config?.longTermMemorySubtitles).toBeNull()
  })

  test('returns null for a folder that does not exist', () => {
    expect(parseAgentConfig('agents/does_not_exist')).toBeNull()
  })
})

describe('parseAgentConfig (synthetic folder)', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-agent-'))
    const agentDir = join(dir, '테스트')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'in_a_nutshell.md'), '  nutshell text\n\n', 'utf-8')
    writeFileSync(join(agentDir, 'characteristics.md'), 'traits', 'utf-8')
    writeFileSync(
      join(agentDir, 'consolidated_memory.md'),
      '## [one]\nfirst\n\n## [two]\nsecond\n',
      'utf-8',
    )
    writeFileSync(join(agentDir, 'config.yaml'), 'home_location: 시장\n', 'utf-8')
    writeFileSync(join(agentDir, 'screenshot.png'), '', 'utf-8')
    writeFileSync(join(agentDir, 'profile.webp'), '', 'utf-8')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    resetSettings()
  })

  test('absolute paths are used as-is, sections are trimmed', () => {
    const config = parseAgentConfig(join(dir, '테스트'))
    expect(config?.inANutshell).toBe('nutshell text')
  })

  test('builds the quoted, comma-joined subtitle list for prompt injection', () => {
    const config = parseAgentConfig(join(dir, '테스트'))
    expect(config?.longTermMemorySubtitles).toBe("'one', 'two'")
    expect(config?.longTermMemoryIndex?.two).toBe('second')
  })

  test('reads home_location from config.yaml', () => {
    expect(parseAgentConfig(join(dir, '테스트'))?.homeLocation).toBe('시장')
  })

  test('prefers a conventional profile filename over any other image', () => {
    expect(parseAgentConfig(join(dir, '테스트'))?.profilePic).toBe('profile.webp')
  })
})

describe('toSystemPromptMarkdown', () => {
  const full = {
    inANutshell: 'N',
    characteristics: 'C',
    recentEvents: 'R',
    longTermMemorySubtitles: "'m1'",
  }

  test('emits sections in order with the Korean memory-index heading', () => {
    expect(toSystemPromptMarkdown('프리렌', full)).toBe(
      "\n\n## 프리렌 in a nutshell\n\nN\n\n## 프리렌's characteristics\n\nC\n\n## 프리렌's recent events\n\nR\n\n## 프리렌이 가진 기억 index\n\n'm1'",
    )
  })

  test('skips empty sections', () => {
    expect(toSystemPromptMarkdown('A', { ...full, characteristics: '', recentEvents: null })).toBe(
      "\n\n## A in a nutshell\n\nN\n\n## A이 가진 기억 index\n\n'm1'",
    )
  })

  test('returns an empty string when nothing is configured', () => {
    expect(
      toSystemPromptMarkdown('A', {
        inANutshell: null,
        characteristics: null,
        recentEvents: null,
        longTermMemorySubtitles: null,
      }),
    ).toBe('')
  })
})

describe('buildSystemPrompt (real guidelines_3rd.yaml)', () => {
  const empty = {
    inANutshell: null,
    characteristics: null,
    recentEvents: null,
    longTermMemorySubtitles: null,
  }

  test('Action_Manager gets system_prompt_AM', () => {
    expect(buildSystemPrompt('Action_Manager', empty)).toStartWith(
      'You are simulating the world of multi-agent roleplay platform',
    )
  })

  test('Onboarding_Manager gets system_prompt_OM', () => {
    expect(buildSystemPrompt('Onboarding_Manager', empty)).toStartWith(
      'You are embodying Onboarding Manager',
    )
  })

  test('a character agent gets the active_system_prompt with its name substituted', () => {
    const prompt = buildSystemPrompt('프리렌', empty)
    expect(prompt).toContain('embodying the character 프리렌')
    expect(prompt).not.toContain('{agent_name}')
  })

  test('the character sheet is appended after the base prompt', () => {
    const prompt = buildSystemPrompt('프리렌', { ...empty, inANutshell: '엘프 마법사' })
    expect(prompt).toEndWith('\n\n## 프리렌 in a nutshell\n\n엘프 마법사')
  })

  test('runtime lore is injected between the guidelines and the character sheet', () => {
    const prompt = buildRuntimeSystemPrompt('프리렌', { ...empty, inANutshell: 'N' }, '  숲의 나라  ')
    expect(prompt).toContain('\n\n# World Lore\n\n숲의 나라\n\n## 프리렌 in a nutshell\n\nN')
    expect(prompt.indexOf('# World Lore')).toBeLessThan(prompt.indexOf('in a nutshell'))
  })

  test('omitting lore leaves the prompt identical to the stored one', () => {
    expect(buildRuntimeSystemPrompt('프리렌', empty)).toBe(buildSystemPrompt('프리렌', empty))
  })
})
