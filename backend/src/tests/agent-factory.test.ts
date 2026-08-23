/**
 * Agent creation from config folders.
 *
 * The factory writes real rows, so the database is a throwaway built from the
 * Drizzle migrations, and the `agents/` tree is a throwaway too — the factory is
 * pointed at it through `AgentConfigService`, which is why that is a constructor
 * argument. The one thing that stays real is the *base* system prompt: it is
 * loaded from `config/guidelines_3rd.yaml`, which the test preload
 * pins the project root for.
 *
 * `resolveGroupSettings` reads the repo's real `group_config.yaml` files through
 * a module-level loader that takes no root argument, so those assertions are
 * written against the checked-in `group_gameplay` config.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgent } from '@/crud/agents'
import { openDb, type Db } from '@/db'
import { applyMigrations, loadMigrations } from '@/db/migrate'
import { agents } from '@/db/schema'
import { AgentConfigService } from '@/services/agent-config-service'
import {
  AgentFactory,
  mergeAgentConfigs,
  resolveGroupSettings,
} from '@/services/agent-factory'

const migrations = loadMigrations()

let dir: string
let db: Db
let factory: AgentFactory

/** Write an agent folder under the temp project root and return its path. */
function writeAgentFolder(
  relativePath: string,
  files: Record<string, string>,
): string {
  const folder = join(dir, relativePath)
  mkdirSync(folder, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(folder, name), content, 'utf-8')
  }
  return relativePath
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-factory-'))

  const raw = new Database(join(dir, 'test.db'), { create: true, strict: true })
  try {
    applyMigrations(raw, migrations)
  } finally {
    raw.close()
  }

  db = openDb({ path: join(dir, 'test.db') })
  factory = new AgentFactory(new AgentConfigService(dir))
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

// ============================================================================
// mergeAgentConfigs
// ============================================================================

describe('mergeAgentConfigs', () => {
  const fileConfig = {
    configFile: 'agents/Foo',
    inANutshell: 'from file',
    characteristics: 'file traits',
    recentEvents: 'file events',
    profilePic: 'profile.png',
    longTermMemoryIndex: { a: 'remembered' },
    longTermMemorySubtitles: "'a'",
    homeLocation: 'tavern',
  }

  test('provided values win over file values', () => {
    const merged = mergeAgentConfigs({ inANutshell: 'provided' }, fileConfig)

    expect(merged.inANutshell).toBe('provided')
    expect(merged.characteristics).toBe('file traits')
    expect(merged.recentEvents).toBe('file events')
    expect(merged.profilePic).toBe('profile.png')
  })

  test('a whitespace-only provided value falls back to the file', () => {
    const merged = mergeAgentConfigs({ inANutshell: '   \n ' }, fileConfig)
    expect(merged.inANutshell).toBe('from file')
  })

  test('both sides are trimmed', () => {
    const merged = mergeAgentConfigs({ characteristics: '  spaced  ' }, {
      ...fileConfig,
      recentEvents: '\n  padded\n',
    })

    expect(merged.characteristics).toBe('spaced')
    expect(merged.recentEvents).toBe('padded')
  })

  test('a missing file config leaves unprovided fields empty, not null', () => {
    const merged = mergeAgentConfigs({ inANutshell: 'only this' }, null)

    expect(merged.inANutshell).toBe('only this')
    expect(merged.characteristics).toBe('')
    expect(merged.profilePic).toBe('')
  })

  test('the memory index is dropped — the parity landmine', () => {
    // `AgentConfigData(**merged)` rebuilds from four keys only, so a merged
    // config never carries a memory index into the system prompt.
    const merged = mergeAgentConfigs({ inANutshell: 'x' }, fileConfig)

    expect(merged.longTermMemorySubtitles).toBeNull()
    expect(merged.longTermMemoryIndex).toBeNull()
    expect(merged.homeLocation).toBeNull()
    expect(merged.configFile).toBeNull()
  })
})

// ============================================================================
// resolveGroupSettings
// ============================================================================

describe('resolveGroupSettings', () => {
  test('an ungrouped agent gets the defaults', () => {
    expect(resolveGroupSettings('Nobody', null, [])).toEqual({
      interruptEveryTurn: false,
      priority: 0,
      transparent: false,
    })
  })

  test('the gameplay group config supplies all three flags', () => {
    // From the checked-in `agents/group_gameplay/group_config.yaml`.
    expect(resolveGroupSettings('Action_Manager', 'gameplay', [])).toEqual({
      interruptEveryTurn: false,
      priority: 5,
      transparent: false,
    })
  })

  test('an unknown group is not an error', () => {
    expect(resolveGroupSettings('Foo', 'no_such_group', []).priority).toBe(0)
  })

  test('PRIORITY_AGENTS ranks by position, first name highest', () => {
    const names = ['First', 'Second', 'Third']

    expect(resolveGroupSettings('First', null, names).priority).toBe(3)
    expect(resolveGroupSettings('Second', null, names).priority).toBe(2)
    expect(resolveGroupSettings('Third', null, names).priority).toBe(1)
  })

  test('PRIORITY_AGENTS overrides the group config', () => {
    const settings = resolveGroupSettings('Action_Manager', 'gameplay', ['Action_Manager'])

    expect(settings.priority).toBe(1)
    // …but only priority; the other two still come from the group.
    expect(settings.interruptEveryTurn).toBe(false)
  })

  test('a name absent from PRIORITY_AGENTS keeps its group priority', () => {
    expect(resolveGroupSettings('Action_Manager', 'gameplay', ['Someone_Else']).priority).toBe(5)
  })
})

// ============================================================================
// createFromConfig
// ============================================================================

describe('createFromConfig', () => {
  test('creates a row whose prompt carries the folder contents', () => {
    const configFile = writeAgentFolder('agents/Elara', {
      'in_a_nutshell.md': 'Elara is a wandering cartographer.',
      'characteristics.md': 'Elara is curious and blunt.',
    })

    const agent = factory.createFromConfig(db, { name: 'Elara', configFile })

    expect(agent.name).toBe('Elara')
    expect(agent.configFile).toBe('agents/Elara')
    expect(agent.inANutshell).toBe('Elara is a wandering cartographer.')
    expect(agent.characteristics).toBe('Elara is curious and blunt.')
    expect(agent.systemPrompt).toContain('## Elara in a nutshell')
    expect(agent.systemPrompt).toContain('Elara is a wandering cartographer.')
    expect(agent.systemPrompt).toContain("## Elara's characteristics")
    // The base prompt is prepended, not replaced.
    expect(agent.systemPrompt.indexOf('## Elara in a nutshell')).toBeGreaterThan(0)
  })

  test('an agent with no folder still gets a row and a base prompt', () => {
    const agent = factory.createFromConfig(db, { name: 'Ghost', configFile: 'agents/Ghost' })

    expect(agent.inANutshell).toBeNull()
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(agent.systemPrompt).not.toContain('## Ghost in a nutshell')
  })

  test('group flags land on the row', () => {
    writeAgentFolder('agents/group_gameplay/Action_Manager', { 'in_a_nutshell.md': 'AM.' })

    const agent = factory.createFromConfig(db, {
      name: 'Action_Manager',
      configFile: 'agents/group_gameplay/Action_Manager',
      group: 'gameplay',
    })

    expect(agent.group).toBe('gameplay')
    expect(agent.priority).toBe(5)
    expect(agent.interruptEveryTurn).toBe(false)
    expect(agent.transparent).toBe(false)
  })

  test('world_name is auto-detected from a worlds/ config path', () => {
    const configFile = writeAgentFolder('worlds/mythos/agents/Kael', {
      'in_a_nutshell.md': 'Kael guards the gate.',
    })

    expect(factory.createFromConfig(db, { name: 'Kael', configFile }).worldName).toBe('mythos')
  })

  test('an explicit world_name wins over the path', () => {
    const configFile = writeAgentFolder('worlds/mythos/agents/Kael', { 'in_a_nutshell.md': 'K.' })

    const agent = factory.createFromConfig(db, {
      name: 'Kael',
      configFile,
      worldName: 'elsewhere',
    })

    expect(agent.worldName).toBe('elsewhere')
  })

  test('a system agent path yields a NULL world_name', () => {
    writeAgentFolder('agents/Narrator', { 'in_a_nutshell.md': 'N.' })

    expect(
      factory.createFromConfig(db, { name: 'Narrator', configFile: 'agents/Narrator' }).worldName,
    ).toBeNull()
  })

  test('a second call updates the existing row instead of duplicating it', () => {
    const configFile = writeAgentFolder('worlds/mythos/agents/Kael', {
      'in_a_nutshell.md': 'Kael guards the gate.',
    })

    const first = factory.createFromConfig(db, { name: 'Kael', configFile })

    writeFileSync(join(dir, configFile, 'in_a_nutshell.md'), 'Kael abandoned his post.', 'utf-8')
    const second = factory.createFromConfig(db, { name: 'Kael', configFile })

    expect(second.id).toBe(first.id)
    expect(second.inANutshell).toBe('Kael abandoned his post.')
    expect(db.select().from(agents).where(eq(agents.name, 'Kael')).all()).toHaveLength(1)
  })

  test('an underscore/space spelling variant updates rather than twins', () => {
    writeAgentFolder('agents/Old_Man', { 'in_a_nutshell.md': 'He waits.' })
    const first = factory.createFromConfig(db, { name: 'Old_Man', configFile: 'agents/Old_Man' })

    const second = factory.createFromConfig(db, { name: 'Old Man', configFile: 'agents/Old Man' })

    expect(second.id).toBe(first.id)
    expect(db.select().from(agents).all()).toHaveLength(1)
  })

  test('a provided config overrides the folder', () => {
    const configFile = writeAgentFolder('agents/Elara', {
      'in_a_nutshell.md': 'from file',
      'characteristics.md': 'file traits',
    })

    const agent = factory.createFromConfig(db, {
      name: 'Elara',
      configFile,
      providedConfig: { inANutshell: 'from the request' },
    })

    expect(agent.inANutshell).toBe('from the request')
    expect(agent.characteristics).toBe('file traits')
  })

  test('a provided config drops the memory index from the stored prompt', () => {
    const configFile = writeAgentFolder('agents/Elara', {
      'in_a_nutshell.md': 'from file',
      'consolidated_memory.md': '## [the storm]\n\nIt rained for a week.\n',
    })

    const withoutProvided = factory.createFromConfig(db, { name: 'Elara', configFile })
    expect(withoutProvided.systemPrompt).toContain('기억 index')

    const withProvided = factory.createFromConfig(db, {
      name: 'Elara',
      configFile,
      providedConfig: { inANutshell: 'from the request' },
    })
    // Same row, prompt rebuilt — and the memory section is now gone.
    expect(withProvided.id).toBe(withoutProvided.id)
    expect(withProvided.systemPrompt).not.toContain('기억 index')
  })

  test('a profile picture is taken from the provided config first', () => {
    const configFile = writeAgentFolder('agents/Elara', {
      'in_a_nutshell.md': 'x',
      'profile.png': 'not really a png',
    })

    expect(factory.createFromConfig(db, { name: 'Elara', configFile }).profilePic).toBe(
      'profile.png',
    )

    const overridden = factory.createFromConfig(db, {
      name: 'Elara2',
      configFile,
      providedConfig: { profilePic: 'avatar.webp' },
    })
    expect(overridden.profilePic).toBe('avatar.webp')
  })
})

// ============================================================================
// reloadFromConfig
// ============================================================================

describe('reloadFromConfig', () => {
  test('rebuilds the row from the current files', () => {
    const configFile = writeAgentFolder('agents/Elara', { 'in_a_nutshell.md': 'before' })
    const agent = factory.createFromConfig(db, { name: 'Elara', configFile })

    writeFileSync(join(dir, configFile, 'in_a_nutshell.md'), 'after', 'utf-8')
    const reloaded = factory.reloadFromConfig(db, agent.id)

    expect(reloaded?.inANutshell).toBe('after')
    expect(reloaded?.systemPrompt).toContain('after')
    expect(reloaded?.systemPrompt).not.toContain('before')
  })

  test('the memory index survives a reload, unlike a merged create', () => {
    const configFile = writeAgentFolder('agents/Elara', {
      'in_a_nutshell.md': 'x',
      'consolidated_memory.md': '## [the storm]\n\nIt rained.\n',
    })
    const agent = factory.createFromConfig(db, {
      name: 'Elara',
      configFile,
      providedConfig: { inANutshell: 'provided' },
    })
    expect(agent.systemPrompt).not.toContain('기억 index')

    expect(factory.reloadFromConfig(db, agent.id)?.systemPrompt).toContain('기억 index')
  })

  test('null for an agent that does not exist', () => {
    expect(factory.reloadFromConfig(db, 4321)).toBeNull()
  })

  test('throws when the agent has no config file', () => {
    const configFile = writeAgentFolder('agents/Elara', { 'in_a_nutshell.md': 'x' })
    const agent = factory.createFromConfig(db, { name: 'Elara', configFile })
    db.update(agents).set({ configFile: null }).where(eq(agents.id, agent.id)).run()

    expect(() => factory.reloadFromConfig(db, agent.id)).toThrow(/does not have a config file/)
  })

  test('throws when the config folder is gone', () => {
    const configFile = writeAgentFolder('agents/Elara', { 'in_a_nutshell.md': 'x' })
    const agent = factory.createFromConfig(db, { name: 'Elara', configFile })
    rmSync(join(dir, configFile), { recursive: true, force: true })

    expect(() => factory.reloadFromConfig(db, agent.id)).toThrow(/Failed to load config/)
  })
})

// ============================================================================
// appendMemory
// ============================================================================

describe('appendMemory', () => {
  test('appends to recent_events.md and leaves the row alone', () => {
    const configFile = writeAgentFolder('agents/Elara', {
      'in_a_nutshell.md': 'x',
      'recent_events.md': '# Recent\n',
    })
    const agent = factory.createFromConfig(db, { name: 'Elara', configFile })

    const returned = factory.appendMemory(db, agent.id, 'Met a talking crow.')

    expect(returned?.id).toBe(agent.id)
    expect(readFileSync(join(dir, configFile, 'recent_events.md'), 'utf-8')).toContain(
      'Met a talking crow.',
    )
    // Filesystem-primary: the column still holds what it held at create time.
    expect(getAgent(db, agent.id)?.recentEvents).toBe(agent.recentEvents)
  })

  test('a second memory lands on its own line', () => {
    const configFile = writeAgentFolder('agents/Elara', { 'in_a_nutshell.md': 'x' })
    const agent = factory.createFromConfig(db, { name: 'Elara', configFile })

    factory.appendMemory(db, agent.id, 'first')
    factory.appendMemory(db, agent.id, 'second')

    const lines = readFileSync(join(dir, configFile, 'recent_events.md'), 'utf-8')
      .split('\n')
      .filter((line) => line.startsWith('- ['))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('first')
    expect(lines[1]).toContain('second')
  })

  test('null for an agent that does not exist', () => {
    expect(factory.appendMemory(db, 4321, 'x')).toBeNull()
  })

  test('an agent with no config file is returned unchanged', () => {
    const configFile = writeAgentFolder('agents/Elara', { 'in_a_nutshell.md': 'x' })
    const agent = factory.createFromConfig(db, { name: 'Elara', configFile })
    db.update(agents).set({ configFile: null }).where(eq(agents.id, agent.id)).run()

    expect(factory.appendMemory(db, agent.id, 'x')?.id).toBe(agent.id)
  })
})

// ============================================================================
// seedFromConfigs
// ============================================================================

describe('seedFromConfigs', () => {
  /**
   * Folder discovery reads the *process* project root, not the factory's, so
   * this necessarily runs against the repo's real `agents/` tree — which is the
   * behaviour the startup path has. The prompts it builds are thrown away with
   * the temp database.
   */
  test('seeds the real agent folders once and is then a no-op', () => {
    const created = factory.seedFromConfigs(db)

    expect(Object.keys(created).length).toBeGreaterThan(0)
    expect(created).toHaveProperty('Action_Manager')
    expect(created.Action_Manager?.group).toBe('gameplay')

    expect(factory.seedFromConfigs(db)).toEqual({})
    expect(db.select().from(agents).all()).toHaveLength(Object.keys(created).length)
  })

  test('an existing row suppresses seeding for that name', () => {
    writeAgentFolder('agents/Action_Manager', { 'in_a_nutshell.md': 'x' })
    const existing = factory.createFromConfig(db, {
      name: 'Action_Manager',
      configFile: 'agents/Action_Manager',
    })

    const created = factory.seedFromConfigs(db)

    expect(created).not.toHaveProperty('Action_Manager')
    expect(db.select().from(agents).where(eq(agents.name, 'Action_Manager')).all()).toEqual([
      expect.objectContaining({ id: existing.id }),
    ])
  })
})
