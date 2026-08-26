/**
 * The declaration layer: `src/sdk/tools/`.
 *
 * Two concerns, and they are separable from every handler. First the *schemas*,
 * where the coercions Python grew `mode="before"` validators for live — the
 * model hands these fields JSON strings and bare names often enough that each
 * one is a recorded incident. Second the *registry*, which is what makes
 * `group_config.yaml`'s tool overrides reach the model at all.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { PROJECT_ROOT_ENV_VAR } from '@/config/paths'
import { resetSettings } from '@/config/settings'
import { clearConfigCache } from '@/sdk/loaders/yaml-config'
import { ACTION_MANAGER_TOOLS, changeStatTool, formatDiceRoll, rollDice } from '@/sdk/tools/gameplay'
import { travelTool } from '@/sdk/tools/location'
import { UNIMPLEMENTED_ITEM_TOOLS } from '@/sdk/tools/item'
import { persistLocationDesignTool } from '@/sdk/tools/subagent'
import {
  getToolNamesByGroup,
  getToolResponse,
  isReadOnlyTool,
  isToolEnabled,
  resolveTool,
  TOOL_GROUPS,
  getToolsByGroup,
} from '@/sdk/tools/registry'

/** Parse one field of a tool's schema in isolation. */
function parseField(schema: z.ZodRawShape, field: string, value: unknown): unknown {
  const parsed = z.object(schema).parse({ ...requiredsFor(schema, field), [field]: value })
  return (parsed as Record<string, unknown>)[field]
}

/**
 * Minimal filler for the *other* required fields of a schema, so a single
 * field can be exercised without restating the whole call.
 */
function requiredsFor(schema: z.ZodRawShape, except: string): Record<string, unknown> {
  const filler: Record<string, unknown> = {}
  for (const key of Object.keys(schema)) {
    if (key === except) continue
    const result = z.object({ [key]: schema[key]! }).safeParse({})
    // Only fields with no default need filling; a string is accepted by every
    // required field these tools declare.
    if (!result.success) filler[key] = 'x'.repeat(200)
  }
  return filler
}

// ============================================================================
// Schema coercions
// ============================================================================

describe('travel.bring_characters', () => {
  test('accepts a real list', () => {
    expect(parseField(travelTool.inputSchema, 'bring_characters', ['Marn', ' Elias '])).toEqual([
      'Marn',
      'Elias',
    ])
  })

  test('accepts the JSON-string form Claude emits', () => {
    expect(parseField(travelTool.inputSchema, 'bring_characters', '["유나-7", "Marn"]')).toEqual([
      '유나-7',
      'Marn',
    ])
  })

  test('accepts a single bare name', () => {
    expect(parseField(travelTool.inputSchema, 'bring_characters', 'Marn')).toEqual(['Marn'])
  })

  test('degrades a malformed JSON list to empty rather than failing the call', () => {
    // Failing here would lose the narration, the suggestions and the history
    // entry that travel writes alongside the move.
    expect(parseField(travelTool.inputSchema, 'bring_characters', '[unterminated]')).toEqual([])
  })

  test('a string that only *starts* like a list is treated as one bare name', () => {
    // Python gates the JSON attempt on both brackets and falls through to the
    // single-name branch otherwise, so this is a name and not a parse failure.
    expect(parseField(travelTool.inputSchema, 'bring_characters', '["unterminated')).toEqual([
      '["unterminated',
    ])
  })

  test('drops falsy entries and defaults to empty', () => {
    expect(parseField(travelTool.inputSchema, 'bring_characters', ['Marn', '', null])).toEqual([
      'Marn',
    ])
    expect(parseField(travelTool.inputSchema, 'bring_characters', undefined)).toEqual([])
  })
})

describe('change_stat list fields', () => {
  test("parses the '[]' string Claude sends for an empty list", () => {
    expect(parseField(changeStatTool.inputSchema, 'stat_changes', '[]')).toEqual([])
  })

  test('parses a JSON-string list of objects', () => {
    expect(
      parseField(changeStatTool.inputSchema, 'inventory_changes', '[{"action":"add","item_id":"a"}]'),
    ).toEqual([{ action: 'add', item_id: 'a' }])
  })

  test('drops a JSON scalar that is not a list', () => {
    expect(parseField(changeStatTool.inputSchema, 'stat_changes', '"nope"')).toEqual([])
  })
})

describe('persist_location_design.adjacent_to', () => {
  test('wraps a bare string into a one-element list', () => {
    expect(parseField(persistLocationDesignTool.inputSchema, 'adjacent_to', 'town_square')).toEqual([
      'town_square',
    ])
  })

  test('defaults to null, which the handler reads as "no neighbours"', () => {
    expect(parseField(persistLocationDesignTool.inputSchema, 'adjacent_to', undefined)).toBeNull()
  })
})

describe('required text fields', () => {
  test('reject whitespace-only values', () => {
    expect(() => z.object(travelTool.inputSchema).parse({ destination: '   ' })).toThrow()
  })
})

// ============================================================================
// Dice
// ============================================================================

describe('roll_the_dice', () => {
  test('the weights select each bucket at its boundary', () => {
    expect(rollDice(() => 0)).toBe('very_lucky')
    expect(rollDice(() => 0.03)).toBe('lucky')
    expect(rollDice(() => 0.5)).toBe('nothing_happened')
    expect(rollDice(() => 0.95)).toBe('bad_luck')
    expect(rollDice(() => 0.995)).toBe('worst_day_of_game')
    // Only reachable if random() returns exactly 1.
    expect(rollDice(() => 1)).toBe('worst_day_of_game')
  })

  test('formats the bucket with the sentence the model needs', () => {
    const text = formatDiceRoll('nothing_happened')
    expect(text).toStartWith('**Dice Roll Result:** `nothing_happened`')
    expect(text).toContain('Standard outcome')
  })
})

// ============================================================================
// The catalogue
// ============================================================================

describe('ACTION_MANAGER_TOOLS', () => {
  test('is core + item + location, matching gameplay.py', () => {
    expect(Object.keys(ACTION_MANAGER_TOOLS).sort()).toEqual(
      [
        'advance_time',
        'await_reactions',
        'change_stat',
        'delete_character',
        'equip_item',
        'inject_memory',
        'list_characters',
        'list_equipment',
        'list_inventory',
        'list_locations',
        'list_world_item',
        'move_character',
        'narration',
        'recall_history',
        'remove_character',
        'roll_the_dice',
        'set_flag',
        'suggest_options',
        'travel',
        'unequip_item',
        'use_item',
      ].sort(),
    )
  })

  test('the item tools Python never implemented are declared but unimplemented', () => {
    // Pinned so that writing handlers for these becomes a deliberate act rather
    // than something that drifts in — see `tools/item.ts`.
    for (const name of UNIMPLEMENTED_ITEM_TOOLS) {
      expect(ACTION_MANAGER_TOOLS).toHaveProperty(name)
    }
  })
})

describe('getToolNamesByGroup', () => {
  test('qualifies every name with its server', () => {
    const names = getToolNamesByGroup('action')
    expect(names).toContain('mcp__action__skip')
    expect(names).toContain('mcp__action__memorize')
    expect(names).toContain('mcp__action__recall')
  })

  test('covers every declared group and nothing else', () => {
    for (const group of TOOL_GROUPS) expect(getToolNamesByGroup(group).length).toBeGreaterThan(0)
    expect(getToolNamesByGroup('character_design')).toEqual([])
    expect(getToolNamesByGroup('nonsense')).toEqual([])
  })
})

describe('isReadOnlyTool', () => {
  /**
   * The whole read-only set, spelled out.
   *
   * A list rather than a spot check because the failure mode is silent and
   * one-directional: `readOnlyHint` becomes `isConcurrencySafe()` in Claude
   * Code, so a mutation wrongly marked here is licensed to run in parallel with
   * anything else in the turn, and nothing reports it. Adding a tool that
   * belongs on this list fails here too, which is the cheap half — the point is
   * that the decision gets made rather than defaulted.
   */
  const READ_ONLY = [
    // Waits rather than reads, but it changes nothing and the point of the flag
    // is that the CLI may run it alongside another call.
    'await_reactions',
    'list_characters',
    'list_inventory',
    'list_locations',
    'list_world_item',
    'read_lore_guidelines',
    'recall',
    'recall_history',
    'world_status',
  ]

  test('is exactly the query tools', () => {
    const marked = TOOL_GROUPS.flatMap((group) => Object.keys(getToolsByGroup(group)))
      .filter(isReadOnlyTool)
      .sort()
    expect([...new Set(marked)]).toEqual(READ_ONLY)
  })

  test('the writers are not marked', () => {
    for (const name of ['memorize', 'narration', 'change_stat', 'travel', 'persist_item']) {
      expect(isReadOnlyTool(name)).toBe(false)
    }
  })

  test('an unknown tool is not read-only, and does not warn', () => {
    // `character_design`'s tools are deliberately outside the catalogue, so
    // this path runs on every turn that builds that namespace.
    expect(isReadOnlyTool('create_comprehensive_character')).toBe(false)
    expect(isReadOnlyTool('no_such_tool')).toBe(false)
  })
})

describe('isToolEnabled', () => {
  test('returns the caller default for an unknown tool', () => {
    expect(isToolEnabled('no_such_tool')).toBe(false)
    expect(isToolEnabled('no_such_tool', true)).toBe(true)
  })

  test('is true for a declared tool', () => {
    expect(isToolEnabled('narration')).toBe(true)
  })
})

describe('resolveTool without a group', () => {
  test('returns the declaration verbatim', () => {
    const resolved = resolveTool('recall')
    expect(resolved?.response).toBe('{memory_content}')
  })

  test('returns null for a name that does not exist', () => {
    expect(resolveTool('no_such_tool')).toBeNull()
  })
})

describe('getToolResponse', () => {
  test('fills placeholders', () => {
    expect(getToolResponse('suggest_options', null, { action_1: 'Run', action_2: 'Hide' })).toBe(
      '**Suggested Actions:**\n1. Run\n2. Hide',
    )
  })

  test('leaves an unsupplied placeholder in place rather than throwing', () => {
    expect(getToolResponse('suggest_options', null, { action_1: 'Run' })).toContain('{action_2}')
  })

  test('has a sentinel for an unknown tool', () => {
    expect(getToolResponse('no_such_tool', null)).toBe('Tool response not configured.')
  })
})

// ============================================================================
// group_config.yaml overrides
// ============================================================================

describe('group config overrides', () => {
  let root: string
  const originalRoot = process.env[PROJECT_ROOT_ENV_VAR]

  /** Write a `group_config.yaml` for `group_<name>` under the temp root. */
  function writeGroupConfig(name: string, body: string): void {
    const dir = join(root, 'agents', `group_${name}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'group_config.yaml'), body, 'utf-8')
    clearConfigCache()
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-groupcfg-'))
    mkdirSync(join(root, 'agents'), { recursive: true })
    process.env[PROJECT_ROOT_ENV_VAR] = root
    resetSettings()
    clearConfigCache()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  afterAll(() => {
    // Restore the real repo root; later suites read `agents/` and the YAML config.
    if (originalRoot === undefined) delete process.env[PROJECT_ROOT_ENV_VAR]
    else process.env[PROJECT_ROOT_ENV_VAR] = originalRoot
    resetSettings()
    clearConfigCache()
  })

  test('the flat `tools:` form documented in CLAUDE.md overrides a response', () => {
    writeGroupConfig(
      '슈타게',
      'tools:\n  skip:\n    response: "This character chooses to remain silent."\n',
    )
    expect(resolveTool('skip', '슈타게')?.response).toBe(
      'This character chooses to remain silent.',
    )
  })

  test('the group-keyed form overrides a description', () => {
    writeGroupConfig('trpg', 'action:\n  memorize:\n    description: "Write it down."\n')
    expect(resolveTool('memorize', 'trpg')?.description).toBe('Write it down.')
  })

  test('the group-keyed form wins when both are present', () => {
    writeGroupConfig(
      'trpg',
      'action:\n  skip:\n    response: "keyed"\ntools:\n  skip:\n    response: "flat"\n',
    )
    expect(resolveTool('skip', 'trpg')?.response).toBe('keyed')
  })

  test('an `enabled: false` override withdraws the tool', () => {
    writeGroupConfig('trpg', 'tools:\n  skip:\n    enabled: false\n')
    expect(resolveTool('skip', 'trpg')).toBeNull()
  })

  test('the `group_` prefix is stripped before the lookup', () => {
    // The `agents.group` column stores the folder name; not stripping it makes
    // every override silently miss.
    writeGroupConfig('trpg', 'tools:\n  skip:\n    response: "quiet"\n')
    expect(resolveTool('skip', 'group_trpg')?.response).toBe('quiet')
  })

  test('an override naming an unknown tool is ignored', () => {
    writeGroupConfig('trpg', 'tools:\n  no_such_tool:\n    response: "x"\n')
    expect(resolveTool('skip', 'trpg')?.response).toBe(
      'You have decided to skip this message. You will not respond.',
    )
  })

  test('a group with no config file leaves the declaration alone', () => {
    expect(resolveTool('skip', 'unknown_group')?.response).toBe(
      'You have decided to skip this message. You will not respond.',
    )
  })

  test('isToolEnabled ignores group overrides, as Python does', () => {
    // Deliberate asymmetry: `_build_allowed_tools` reads the *base* config, so a
    // group cannot desynchronise the allow-list from the servers this way.
    writeGroupConfig('trpg', 'tools:\n  skip:\n    enabled: false\n')
    expect(isToolEnabled('skip')).toBe(true)
  })
})
