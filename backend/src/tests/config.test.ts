import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { createProjectPaths, resolveProjectRoot } from '../config/paths'
import {
  AGENT_TOOL_NAMES,
  createSettings,
  getCorsOrigins,
  getPriorityAgentNames,
  getSettings,
  isGuestLoginEnabled,
  loadDotEnv,
  parseDotEnv,
  SKIP_DOTENV_ENV_VAR,
  type EnvRecord,
} from '../config/settings'
import { getAgentToolConfig, getExtremeTraits, getGroupConfig } from '../sdk/loaders/group-config'
import { getBaseSystemPrompt, isActionManager, isOnboardingManager } from '../sdk/loaders/guidelines'
import { clearConfigCache, getCachedConfig, loadYamlFile } from '../sdk/loaders/yaml-config'

describe('paths', () => {
  const paths = createProjectPaths()

  test('the discovered root holds the agents/ and backend/ trees', () => {
    // Identify the root by what it contains, never by its name: a checkout
    // cloned to any other directory -- `claudeworld/`, `work/cw`, a worktree
    // under `.git/` -- is the same repository, and asserting the basename
    // failed there while discovery had in fact worked perfectly.
    expect(existsSync(paths.agentsDir)).toBe(true)
    expect(existsSync(paths.backendDir)).toBe(true)

    // What the basename check was reaching for: that the walk stopped on the
    // repository root and not on some ancestor that happens to hold `agents/`
    // and `backend/` too. Reaching this very file back through the resolved
    // root pins that exactly, and survives a rename.
    expect(join(paths.projectRoot, 'backend', 'src', 'tests', 'config.test.ts')).toBe(
      import.meta.path,
    )
  })

  test('configDir is a top-level data tree, beside backend/ rather than inside it', () => {
    expect(paths.backendDir).toBe(join(paths.projectRoot, 'backend'))
    expect(paths.configDir).toBe(join(paths.projectRoot, 'config'))
  })

  test('every SDK config path resolves to a file that exists', () => {
    expect(existsSync(paths.guidelinesConfigPath)).toBe(true)
    expect(existsSync(paths.localizationConfigPath)).toBe(true)
    expect(existsSync(paths.loreGuidelinesConfigPath)).toBe(true)
    expect(existsSync(paths.conversationContextConfigPath)).toBe(true)
  })

  test('guidelinesConfigPath follows GUIDELINES_FILE', () => {
    expect(basename(paths.guidelinesConfigPath)).toBe('guidelines_3rd.yaml')
    expect(basename(createProjectPaths({ guidelinesFile: 'other' }).guidelinesConfigPath)).toBe(
      'other.yaml',
    )
  })

  test('debug.yaml sits in the config dir with the rest of the editable YAML', () => {
    expect(paths.debugConfigPath).toBe(join(paths.configDir, 'debug.yaml'))
    expect(existsSync(paths.debugConfigPath)).toBe(true)
  })

  test('CLAUDEWORLD_ROOT overrides discovery', () => {
    expect(resolveProjectRoot({ CLAUDEWORLD_ROOT: '/srv/claudeworld' })).toBe('/srv/claudeworld')
  })
})

describe('settings parsing', () => {
  const withEnv = (env: EnvRecord) => createSettings(env)

  test('defaults match core/settings.py', () => {
    const s = withEnv({})
    expect(s.userName).toBe('User')
    expect(s.guidelinesFile).toBe('guidelines_3rd')
    expect(s.enableGuestLogin).toBe(true)
    expect(s.useSonnet).toBe(false)
    expect(s.debugAgents).toBe(false)
    expect(s.maxConcurrentRooms).toBe(5)
    expect(s.enableCliTracing).toBe(false)
    expect(s.imageWebpQuality).toBe(85)
    expect(s.imageConvertToWebp).toBe(true)
    expect(s.apiKeyHash).toBeNull()
    expect(s.jwtSecret).toBeNull()
    expect(s.claudeApiKey).toBeNull()
  })

  test('booleans accept only a case-insensitive "true"', () => {
    expect(withEnv({ USE_SONNET: 'true' }).useSonnet).toBe(true)
    expect(withEnv({ USE_SONNET: 'TRUE' }).useSonnet).toBe(true)
    expect(withEnv({ USE_SONNET: ' True ' }).useSonnet).toBe(true)
    // Deliberately faithful to pydantic: 1/yes/on are NOT truthy here.
    expect(withEnv({ USE_SONNET: '1' }).useSonnet).toBe(false)
    expect(withEnv({ USE_SONNET: 'yes' }).useSonnet).toBe(false)
    expect(withEnv({ IMAGE_CONVERT_TO_WEBP: 'false' }).imageConvertToWebp).toBe(false)
    expect(withEnv({ ENABLE_GUEST_LOGIN: 'no' }).enableGuestLogin).toBe(false)
  })

  test('integers fall back on garbage', () => {
    expect(withEnv({ MAX_CONCURRENT_ROOMS: '12' }).maxConcurrentRooms).toBe(12)
    expect(withEnv({ MAX_CONCURRENT_ROOMS: 'abc' }).maxConcurrentRooms).toBe(5)
    expect(withEnv({ IMAGE_WEBP_QUALITY: '60' }).imageWebpQuality).toBe(60)
  })

  test('string settings keep their exact env var names', () => {
    const s = withEnv({
      API_KEY_HASH: 'hash',
      JWT_SECRET: 'secret',
      GUEST_PASSWORD_HASH: 'guest',
      USER_NAME: '케이',
      CLI_TRACE_OUTPUT: '/tmp/trace.log',
      CLAUDE_API_KEY: 'sk-ant-x',
      DATABASE_URL: 'sqlite+aiosqlite:///../claudeworld.db',
      GUIDELINES_FILE: 'guidelines_3rd',
    })
    expect(s.apiKeyHash).toBe('hash')
    expect(s.jwtSecret).toBe('secret')
    expect(s.guestPasswordHash).toBe('guest')
    expect(s.userName).toBe('케이')
    expect(s.cliTraceOutput).toBe('/tmp/trace.log')
    expect(s.claudeApiKey).toBe('sk-ant-x')
    expect(s.databaseUrl).toBe('sqlite+aiosqlite:///../claudeworld.db')
  })

  test('PRIORITY_AGENTS splits, trims and drops blanks', () => {
    expect(getPriorityAgentNames(withEnv({ PRIORITY_AGENTS: ' 프리렌 , 히메,, ' }))).toEqual([
      '프리렌',
      '히메',
    ])
    expect(getPriorityAgentNames(withEnv({}))).toEqual([])
  })

  test('guest login accepts the wider set on the auth path only', () => {
    const s = withEnv({})
    for (const value of ['1', 'true', 'YES', 'on']) {
      expect(isGuestLoginEnabled({ ENABLE_GUEST_LOGIN: value }, s)).toBe(true)
    }
    expect(isGuestLoginEnabled({ ENABLE_GUEST_LOGIN: 'off' }, s)).toBe(false)
    // Unset falls through to the settings field.
    expect(isGuestLoginEnabled({}, s)).toBe(true)
    expect(isGuestLoginEnabled({}, withEnv({ ENABLE_GUEST_LOGIN: 'false' }))).toBe(false)
  })

  test('CORS origins include localhost plus the configured URLs', () => {
    const origins = getCorsOrigins(
      withEnv({ FRONTEND_URL: 'https://app.example', VERCEL_URL: 'x.vercel.app' }),
    )
    expect(origins).toContain('http://localhost:5173')
    expect(origins).toContain('http://127.0.0.1:5174')
    expect(origins).toContain('https://app.example')
    expect(origins).toContain('https://x.vercel.app')
  })

  test('the singleton exposes resolved paths', () => {
    expect(existsSync(getSettings().paths.guidelinesConfigPath)).toBe(true)
  })

  test('AGENT_TOOL_NAMES flattens the grouped map', () => {
    expect(AGENT_TOOL_NAMES.skip).toBe('mcp__action__skip')
    expect(AGENT_TOOL_NAMES.recall).toBe('mcp__action__recall')
    expect(AGENT_TOOL_NAMES.anthropic).toBe('mcp__guidelines__anthropic')
  })
})

describe('parseDotEnv', () => {
  test('handles comments, export, quotes and inline comments', () => {
    expect(
      parseDotEnv(
        [
          '# a comment',
          '',
          'PLAIN=value',
          'export EXPORTED=two',
          'QUOTED="a b"',
          "SINGLE='c d'",
          'INLINE=x  # trailing',
          'HASHY=a#b',
          'ESCAPED="line1\\nline2"',
          'not a pair',
          '=novalue',
        ].join('\n'),
      ),
    ).toEqual({
      PLAIN: 'value',
      EXPORTED: 'two',
      QUOTED: 'a b',
      SINGLE: 'c d',
      INLINE: 'x',
      HASHY: 'a#b',
      ESCAPED: 'line1\nline2',
    })
  })
})

describe('loadDotEnv', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-dotenv-'))
    writeFileSync(join(dir, '.env'), 'GUIDELINES_FILE=guidelines_custom\n', 'utf-8')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    process.env[SKIP_DOTENV_ENV_VAR] = '1'
  })

  test('a project root with no .env yields {}', () => {
    expect(loadDotEnv(mkdtempSync(join(tmpdir(), 'cw-noenv-')))).toEqual({})
  })

  test('the suite runs with .env hidden, so a developer file cannot change results', () => {
    // The preload sets this; without it, a `.env` carrying GUIDELINES_FILE
    // repoints paths.guidelinesConfigPath and takes the guidelines tests down
    // on a machine that has run `make setup`, while CI stays green.
    expect(process.env[SKIP_DOTENV_ENV_VAR]).toBeTruthy()
    expect(loadDotEnv(dir)).toEqual({})
  })

  test('nothing from a project-root .env survives in process.env', () => {
    // Bun auto-loads `.env` from the cwd, so a root-launched `bun test` used to
    // see the developer's settings even though `loadDotEnv` was hushed. The
    // preload deletes those entries again. Vacuous when there is no `.env`
    // (CI, a fresh clone) -- and that is exactly the state it pins.
    const path = join(getSettings().paths.projectRoot, '.env')
    const entries = existsSync(path) ? parseDotEnv(readFileSync(path, 'utf-8')) : {}
    for (const [key, value] of Object.entries(entries)) {
      expect({ key, value: process.env[key] }).not.toEqual({ key, value })
    }
  })

  test('the file is still read when the knob is unset -- production behaviour', () => {
    delete process.env[SKIP_DOTENV_ENV_VAR]
    try {
      expect(loadDotEnv(dir)).toEqual({ GUIDELINES_FILE: 'guidelines_custom' })
    } finally {
      process.env[SKIP_DOTENV_ENV_VAR] = '1'
    }
  })
})

describe('yaml-config cache', () => {
  let dir: string
  let file: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-yaml-'))
    file = join(dir, 'sample.yaml')
    writeFileSync(file, 'a: 1\n', 'utf-8')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    clearConfigCache()
  })

  test('reloads when the file mtime moves (the hot-reload contract)', () => {
    expect(getCachedConfig(file)).toEqual({ a: 1 })

    writeFileSync(file, 'a: 2\n', 'utf-8')
    // Touch explicitly: two writes inside one filesystem timestamp tick would
    // otherwise leave the mtime unchanged and make this test flaky.
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)

    expect(getCachedConfig(file)).toEqual({ a: 2 })
  })

  test('serves the cached parse while the mtime is unchanged', () => {
    const first = getCachedConfig(file)
    expect(getCachedConfig(file)).toBe(first)
  })

  test('forceReload bypasses the cache', () => {
    const first = getCachedConfig(file)
    expect(getCachedConfig(file, true)).not.toBe(first)
  })

  test('a missing file yields {} instead of throwing', () => {
    expect(loadYamlFile(join(dir, 'absent.yaml'))).toEqual({})
    expect(getCachedConfig(join(dir, 'absent.yaml'))).toEqual({})
  })

  test('malformed YAML and non-mapping documents yield {}', () => {
    const bad = join(dir, 'bad.yaml')
    writeFileSync(bad, 'a: [1, 2\n', 'utf-8')
    expect(loadYamlFile(bad)).toEqual({})

    const list = join(dir, 'list.yaml')
    writeFileSync(list, '- 1\n- 2\n', 'utf-8')
    expect(loadYamlFile(list)).toEqual({})

    const empty = join(dir, 'empty.yaml')
    writeFileSync(empty, '', 'utf-8')
    expect(loadYamlFile(empty)).toEqual({})
  })
})

describe('guidelines (real guidelines_3rd.yaml)', () => {
  test('agent-type detection is substring based on a normalized name', () => {
    expect(isActionManager('Action_Manager')).toBe(true)
    expect(isActionManager('action manager')).toBe(true)
    expect(isActionManager('TRPG_ActionManager')).toBe(true)
    expect(isActionManager('프리렌')).toBe(false)
    expect(isOnboardingManager('Onboarding_Manager')).toBe(true)
    expect(isOnboardingManager('Action_Manager')).toBe(false)
  })

  test('Action_Manager and Onboarding_Manager get their dedicated prompts', () => {
    expect(getBaseSystemPrompt('Action_Manager')).toStartWith('You are simulating the world')
    expect(getBaseSystemPrompt('Onboarding_Manager')).toStartWith('You are embodying Onboarding Manager')
  })

  test('everything else resolves through active_system_prompt', () => {
    const generic = getBaseSystemPrompt('프리렌')
    expect(generic).toContain('{agent_name}')
    expect(getBaseSystemPrompt()).toBe(generic)
    expect(getBaseSystemPrompt(null)).toBe(generic)
  })

  test('the prompt is trimmed', () => {
    const prompt = getBaseSystemPrompt('프리렌')
    expect(prompt).toBe(prompt.trim())
  })
})

describe('group-config (real agents/group_gameplay)', () => {
  test('loads the group-wide behaviour flags', () => {
    const config = getGroupConfig('gameplay')
    expect(config.interrupt_every_turn).toBe(false)
    expect(config.priority).toBe(5)
    expect(config.transparent).toBe(false)
    expect(config.can_see_system_messages).toBe(true)
  })

  test('an unknown group is empty, not an error', () => {
    expect(getGroupConfig('no_such_group')).toEqual({})
    expect(getGroupConfig('')).toEqual({})
    expect(getExtremeTraits('gameplay')).toEqual({})
  })

  test('per-agent lists extend the group-wide lists', () => {
    const config = getAgentToolConfig('gameplay', 'Action_Manager')
    // Group-wide disabled_tools carry over even though the agent lists none.
    expect(config.disabled_tools).toEqual(['memorize', 'recall', 'skip'])
    expect(config.enabled_tool_groups).toEqual(['action_manager', 'subagent'])
    expect(config.enabled_tools).toContain('narration')
    expect(config.enabled_tools).toContain('travel')
  })

  test('duplicates between the two levels are collapsed', () => {
    const config = getAgentToolConfig('gameplay', 'Onboarding_Manager')
    // "memorize" is disabled group-wide and again per-agent.
    expect(config.disabled_tools).toEqual(['memorize', 'recall', 'skip'])
    expect(config.enabled_tools).toContain('complete')
  })

  test('an explicit empty list still overrides nothing but is preserved', () => {
    const config = getAgentToolConfig('gameplay', 'Chat_Summarizer')
    expect(config.enabled_tools).toEqual([])
    expect(config.disabled_tools).toEqual(['memorize', 'recall', 'skip'])
  })

  test('an agent with no entry gets only the group-wide settings', () => {
    const config = getAgentToolConfig('gameplay', 'History_Summarizer')
    expect(config.disabled_tools).toEqual(['memorize', 'recall', 'skip'])
    expect(config.enabled_tools).toBeUndefined()
  })

  test('missing group or agent name yields {}', () => {
    expect(getAgentToolConfig('', 'Action_Manager')).toEqual({})
    expect(getAgentToolConfig('gameplay', '')).toEqual({})
  })
})
