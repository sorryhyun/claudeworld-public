/**
 * `Options.agents` — the sub-agent definitions the `Task` tool dispatches to.
 *
 * The bug these guard against is silent by construction: every agent already
 * carries `Task` in its tool list, so a missing `Options.agents` produces no
 * error, no log line and no failing request — only a designer that never runs
 * and a world that never grows a location. The assertions below therefore care
 * about the *join* points — which roles get definitions, and whether the tool a
 * definition names is one the parent's `subagents` server actually serves.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetSettings } from '@/config/settings'
import { optionsFingerprint } from '@/sdk/agent/options-builder'
import {
  buildSubagentDefinition,
  buildSubagentDefinitions,
  buildSubagentDefinitionsForRole,
  clearSubagentDefinitionCache,
  isSubagentParentRole,
  SUBAGENT_TYPES,
} from '@/sdk/agent/subagent-definitions'
import { qualifiedToolName } from '@/sdk/tools/definitions'
import { LORE_CONTRIBUTION_TOOL, SUBAGENT_TOOLS, SUBAGENT_TOOL_NAMES } from '@/sdk/tools/subagent'

/** Everything the `subagents` server offers when every ServerDeps entry is wired. */
const ALL_SUBAGENT_TOOLS: string[] = [
  ...Object.values(SUBAGENT_TOOL_NAMES),
  LORE_CONTRIBUTION_TOOL,
]

describe('buildSubagentDefinitionsForRole (real agents/ tree)', () => {
  test('the Action Manager gets the three in-game designers', () => {
    expect(Object.keys(buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS) ?? {}).sort()).toEqual([
      'character_designer',
      'item_designer',
      'location_designer',
    ])
  })

  test('onboarding adds the detailed character designer', () => {
    expect(Object.keys(buildSubagentDefinitionsForRole('onboarding', ALL_SUBAGENT_TOOLS) ?? {}).sort()).toEqual([
      'character_designer',
      'detailed_character_designer',
      'item_designer',
      'location_designer',
    ])
  })

  test('a character gets none — and undefined, not an empty object', () => {
    // `buildAgentOptions` only assigns `agents` when truthy, so `undefined`
    // keeps the key out of the options entirely rather than sending `{}`.
    expect(buildSubagentDefinitionsForRole('character', ALL_SUBAGENT_TOOLS)).toBeUndefined()
    expect(buildSubagentDefinitionsForRole('subagent', ALL_SUBAGENT_TOOLS)).toBeUndefined()
    expect(isSubagentParentRole('character')).toBe(false)
    expect(isSubagentParentRole('action_manager')).toBe(true)
  })

  test('repeated calls hit the mtime cache and return the same object', () => {
    const first = buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)
    expect(buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)).toBe(first)
  })

  test('a designer whose persist tool is not served this turn is dropped', () => {
    // `buildToolSets` gates `persist_item` on `ServerDeps.items`; a caller
    // wired without it must not be handed an `item_designer` restricted to a
    // tool that will not answer.
    const served = ALL_SUBAGENT_TOOLS.filter((name) => name !== 'mcp__subagents__persist_item')
    expect(Object.keys(buildSubagentDefinitionsForRole('action_manager', served) ?? {}).sort()).toEqual([
      'character_designer',
      'location_designer',
    ])
  })

  test('with no persist tools served, the role gets no definitions at all', () => {
    expect(buildSubagentDefinitionsForRole('action_manager', [])).toBeUndefined()
    // Onboarding keeps the one designer that inherits the parent's tools.
    expect(Object.keys(buildSubagentDefinitionsForRole('onboarding', []) ?? {})).toEqual([
      'detailed_character_designer',
    ])
  })

  test('the cache does not answer one tool set with another’s definitions', () => {
    const served = ALL_SUBAGENT_TOOLS.filter((name) => name !== 'mcp__subagents__persist_item')
    expect(buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)).not.toBe(
      buildSubagentDefinitionsForRole('action_manager', served),
    )
    expect(
      buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)?.item_designer,
    ).toBeDefined()
  })
})

/** Opening of the generated lore paragraph. Matched on the *generated* wording
 * rather than its heading, because `characteristics.md` names the same tool and
 * a heading match would pass from the identity text alone. */
const LORE_PARAGRAPH = "You may also write into the world's shared lore"

describe('buildSubagentDefinition (real agents/ tree)', () => {
  test('a designer names its persist tool and inherits the parent model', () => {
    const item = buildSubagentDefinition('item_designer')
    // Both, in that order: restricting `tools` at all cuts the designer off from
    // the parent's set, so the lore tool has to be named or it is unreachable.
    expect(item.tools).toEqual(['mcp__subagents__persist_item', LORE_CONTRIBUTION_TOOL])
    expect(item.model).toBe('inherit')
    expect(item.description).toContain('Invoke to design a new item template')
    expect(item.prompt).toContain('You are Item Designer,')
    expect(item.prompt).toContain('## Identity')
    expect(item.prompt).toContain('## Guidelines')
    expect(item.prompt).toContain('You MUST use the `mcp__subagents__persist_item` tool')
    expect(item.prompt).toContain(LORE_PARAGRAPH)
  })

  test('a turn that does not serve the lore tool neither grants nor mentions it', () => {
    const item = buildSubagentDefinition('item_designer', false)
    expect(item.tools).toEqual(['mcp__subagents__persist_item'])
    expect(item.prompt).not.toContain(LORE_PARAGRAPH)
  })

  test('the lore grant is part of the cache key, not a shared object', () => {
    // Same role, same designers, different served set: answering the second call
    // from the first's entry would hand a designer a tool the turn cannot serve.
    const withLore = buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)
    const withoutLore = buildSubagentDefinitionsForRole(
      'action_manager',
      Object.values(SUBAGENT_TOOL_NAMES),
    )
    expect(withLore).not.toBe(withoutLore)
    expect(withLore?.item_designer?.tools).toContain(LORE_CONTRIBUTION_TOOL)
    expect(withoutLore?.item_designer?.tools).toEqual(['mcp__subagents__persist_item'])
  })

  test('the detailed character designer inherits the parent tool set instead', () => {
    // Python's `SUBAGENT_TOOL_NAMES` has no entry for it, so `tools` is omitted
    // — "inherit all tools from parent" in SDK terms — and the prompt asks for
    // prose rather than a persist call.
    const detailed = buildSubagentDefinition('detailed_character_designer')
    expect(detailed.tools).toBeUndefined()
    expect(detailed.prompt).toContain('Provide your results as a clear, structured text response')
    expect(detailed.prompt).not.toContain('You MUST use the')
  })

  test('every named persist tool is one the subagents server actually serves', () => {
    // The failure this catches is a rename on one side only: the definition
    // would restrict the sub-agent to a tool that does not exist, leaving it
    // with no tools at all and no diagnostic.
    const served = new Set(
      Object.values(SUBAGENT_TOOLS).map((tool) => qualifiedToolName('subagents', tool.name)),
    )
    for (const definition of Object.values(buildSubagentDefinitions())) {
      for (const tool of definition.tools ?? []) expect(served.has(tool)).toBe(true)
    }
    expect(
      new Set<string>([...Object.values(SUBAGENT_TOOL_NAMES), LORE_CONTRIBUTION_TOOL]),
    ).toEqual(served)
  })

  test('every declared type is buildable', () => {
    for (const type of SUBAGENT_TYPES) {
      const definition = buildSubagentDefinition(type)
      expect(definition.description.length).toBeGreaterThan(0)
      expect(definition.prompt.length).toBeGreaterThan(0)
    }
  })
})

describe('buildSubagentDefinition (synthetic agents tree)', () => {
  const previousRoot = process.env.CLAUDEWORLD_ROOT
  let root: string

  const itemDesignerDir = (): string =>
    join(root, 'agents', 'group_subagent', 'Item_Designer')

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-subagent-'))
    // `agents/` and `backend/` are the project-root markers; the env var
    // bypasses discovery but the settings still expect the tree to be there.
    mkdirSync(join(root, 'backend'), { recursive: true })
    mkdirSync(itemDesignerDir(), { recursive: true })
    process.env.CLAUDEWORLD_ROOT = root
    resetSettings()
    clearSubagentDefinitionCache()
  })

  afterEach(() => {
    clearSubagentDefinitionCache()
  })

  afterAll(() => {
    if (previousRoot === undefined) delete process.env.CLAUDEWORLD_ROOT
    else process.env.CLAUDEWORLD_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
    resetSettings()
    clearSubagentDefinitionCache()
  })

  test('a missing folder degrades to a generic prompt rather than throwing', () => {
    // A half-installed `agents/` tree must cost one weak designer, not a turn.
    const character = buildSubagentDefinition('character_designer')
    expect(character.description).toBe('Sub-agent for character designer')
    expect(character.prompt).toContain('A specialized Character Designer for ClaudeWorld TRPG.')
    expect(character.prompt).toContain('Follow the task instructions carefully')
  })

  test('an edit to characteristics.md lands on the next call', () => {
    writeFileSync(join(itemDesignerDir(), 'characteristics.md'), 'Designs blades.', 'utf-8')
    expect(buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)?.item_designer?.prompt).toContain(
      'Designs blades.',
    )

    writeFileSync(join(itemDesignerDir(), 'characteristics.md'), 'Designs potions.', 'utf-8')
    const after = buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)?.item_designer?.prompt
    expect(after).toContain('Designs potions.')
    expect(after).not.toContain('Designs blades.')
  })

  test('creating a previously absent identity file also invalidates the cache', () => {
    // Absent files carry no mtime entry, so their creation has to change the
    // map rather than leave it identical.
    writeFileSync(join(itemDesignerDir(), 'characteristics.md'), 'Designs potions.', 'utf-8')
    expect(buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)?.item_designer?.description).toBe(
      'Sub-agent for item designer',
    )

    writeFileSync(join(itemDesignerDir(), 'description.md'), 'Invoke for potions.', 'utf-8')
    expect(buildSubagentDefinitionsForRole('action_manager', ALL_SUBAGENT_TOOLS)?.item_designer?.description).toBe(
      'Invoke for potions.',
    )
  })
})

describe('optionsFingerprint covers sub-agent content', () => {
  const base = {
    systemPrompt: 'S',
    mcpServers: {},
    toolNames: ['mcp__subagents__persist_item'],
  }

  const withAgents = (prompt: string) => ({
    ...base,
    agents: {
      item_designer: { description: 'd', prompt, model: 'inherit' },
    },
  })

  test('an edited sub-agent prompt evicts the warm session', () => {
    // Hashing only `Object.keys(agents)` would make these two identical, and a
    // warm session would go on dispatching `Task` to the stale prompt forever.
    expect(optionsFingerprint(withAgents('one'))).not.toBe(
      optionsFingerprint(withAgents('two')),
    )
  })

  test('identical definitions hash identically', () => {
    expect(optionsFingerprint(withAgents('one'))).toBe(optionsFingerprint(withAgents('one')))
    // No definitions and an empty map are the same options and hash the same,
    // which is what makes returning `undefined` for a character safe.
    expect(optionsFingerprint(base)).toBe(optionsFingerprint({ ...base, agents: {} }))
  })
})
