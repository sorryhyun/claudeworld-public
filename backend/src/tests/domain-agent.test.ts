import { describe, expect, test } from 'bun:test'

import {
  SYSTEM_AGENT_GROUPS,
  findTrpgAgents,
  getPresentCharacters,
  isActionManager,
  isChatSummarizer,
  isCharacterDesigner,
  isItemDesigner,
  isLocationDesigner,
  isOnboardingManager,
  isSystemAgent,
  matchesPatterns,
} from '@/domain/agent'

describe('role predicates', () => {
  // Each role gets the three spellings its pattern set covers, a real-world
  // prefixed name, and the near-miss that would fire under a looser rule.
  const cases: [string, (name: string) => boolean, string[], string[]][] = [
    [
      'action manager',
      isActionManager,
      ['Action_Manager', 'action manager', 'ActionManager', 'TRPG_Action_Manager'],
      ['Actions_Manager', 'Onboarding_Manager', 'Manager', '액션매니저'],
    ],
    [
      'onboarding manager',
      isOnboardingManager,
      ['Onboarding_Manager', 'onboarding manager', 'OnboardingManager'],
      ['Action_Manager', 'Onboarding', 'onboard_manager'],
    ],
    [
      'character designer',
      isCharacterDesigner,
      ['Character_Designer', 'character designer', 'CharacterDesigner'],
      ['Item_Designer', 'Character', 'Designer'],
    ],
    [
      'item designer',
      isItemDesigner,
      ['Item_Designer', 'item designer', 'ItemDesigner'],
      ['Location_Designer', 'Item', 'items_designer'],
    ],
    [
      'location designer',
      isLocationDesigner,
      ['Location_Designer', 'location designer', 'LocationDesigner'],
      ['Character_Designer', 'Location', 'locations_designer'],
    ],
    [
      'chat summarizer',
      isChatSummarizer,
      ['Chat_Summarizer', 'chat summarizer', 'ChatSummarizer'],
      ['Chat_Summariser', 'Summarizer', 'chatter_summarizer'],
    ],
  ]

  for (const [role, predicate, hits, misses] of cases) {
    test(`${role} matches its spellings and nothing near it`, () => {
      for (const name of hits) expect(predicate(name)).toBe(true)
      for (const name of misses) expect(predicate(name)).toBe(false)
    })
  }

  test('the six roles are mutually exclusive on canonical names', () => {
    const predicates = cases.map(([, p]) => p)
    for (const [, , hits] of cases) {
      for (const name of hits) {
        expect(predicates.filter((p) => p(name))).toHaveLength(1)
      }
    }
  })

  test('normalization is lowercase plus space-to-underscore, and substring', () => {
    expect(matchesPatterns('A B', ['a_b'])).toBe(true)
    expect(matchesPatterns('xxA_Bxx', ['a_b'])).toBe(true)
    expect(matchesPatterns('a-b', ['a_b'])).toBe(false)
    // Tabs are not spaces: only U+0020 is replaced, as in Python's `replace(" ", "_")`.
    expect(matchesPatterns('a\tb', ['a_b'])).toBe(false)
  })
})

describe('isSystemAgent', () => {
  test('group membership is authoritative', () => {
    expect(isSystemAgent({ name: '프리렌', group: 'gameplay' })).toBe(true)
    expect(isSystemAgent({ name: '프리렌', group: 'onboarding' })).toBe(true)
  })

  test('the Action Manager is caught by name even when ungrouped', () => {
    expect(isSystemAgent({ name: 'Action_Manager', group: null })).toBe(true)
    expect(isSystemAgent({ name: 'Action_Manager' })).toBe(true)
  })

  test('characters and sub-agents are not system agents', () => {
    expect(isSystemAgent({ name: '프리렌', group: null })).toBe(false)
    expect(isSystemAgent({ name: '크리스', group: '슈타게' })).toBe(false)
    // group_subagent is deliberately absent from SYSTEM_AGENT_GROUPS, and the
    // designers have no name-based fallback. Python behaves the same way.
    expect(isSystemAgent({ name: 'Item_Designer', group: 'subagent' })).toBe(false)
  })

  test('SYSTEM_AGENT_GROUPS holds exactly the two AgentGroup values', () => {
    expect([...SYSTEM_AGENT_GROUPS].sort()).toEqual(['gameplay', 'onboarding'])
  })
})

describe('getPresentCharacters', () => {
  const room = {
    agents: [
      { name: 'Action_Manager', group: 'gameplay' },
      { name: 'Onboarding_Manager', group: 'onboarding' },
      { name: '프리렌', group: null },
      { name: '슈타르크', group: '장송의프리렌' },
    ],
  }

  test('drops machinery and keeps roster order', () => {
    expect(getPresentCharacters(room)).toEqual(['프리렌', '슈타르크'])
  })

  test('a missing or empty room yields no characters', () => {
    expect(getPresentCharacters(null)).toEqual([])
    expect(getPresentCharacters(undefined)).toEqual([])
    expect(getPresentCharacters({ agents: [] })).toEqual([])
  })
})

describe('findTrpgAgents', () => {
  test('resolves a realistic roster', () => {
    const roster = [
      { id: 1, name: 'Onboarding_Manager' },
      { id: 2, name: 'Action_Manager' },
      { id: 3, name: 'Character_Designer' },
      { id: 4, name: 'Item_Designer' },
      { id: 5, name: 'Location_Designer' },
      { id: 6, name: 'Chat_Summarizer' },
      { id: 7, name: '프리렌' },
      { id: 8, name: '슈타르크' },
    ]

    expect(findTrpgAgents(roster)).toEqual({
      onboarding_manager: 1,
      action_manager: 2,
      character_designer: 3,
      item_designer: 4,
      location_designer: 5,
      chat_summarizer: 6,
    })
  })

  test('a cast with no system agents maps to nothing', () => {
    expect(findTrpgAgents([{ id: 7, name: '프리렌' }])).toEqual({})
  })

  test('later agents win a duplicated role, as dict assignment does', () => {
    const map = findTrpgAgents([
      { id: 2, name: 'Action_Manager' },
      { id: 9, name: 'TRPG_ActionManager' },
    ])
    expect(map.action_manager).toBe(9)
  })

  test('one agent fills at most one role', () => {
    // Onboarding is tested first in the else-if chain, so this name never
    // reaches the action-manager branch.
    const map = findTrpgAgents([{ id: 1, name: 'Onboarding_Manager_And_Action_Manager' }])
    expect(map).toEqual({ onboarding_manager: 1 })
  })
})
