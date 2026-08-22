/**
 * `AgentDefinition`s for the SDK-native `Task` sub-agents.
 *
 * Port of `backend/sdk/agent/task_subagent_definitions.py`.
 *
 * Every agent is handed `Task`/`TaskOutput` (`options-builder.ts`), built-in
 * agents are switched off (`CLAUDE_CODE_DISABLE_BUILTIN_AGENTS`) and
 * `settingSources: []` blocks filesystem agent discovery — so `Options.agents`
 * is the *only* way a sub-agent can exist. Without this module `Task` has
 * nothing to dispatch to, which is exactly the state Phase 1 of the SDK
 * modernization plan found the backend in.
 *
 * The identities live on disk under `agents/group_subagent/<Folder>/` and the
 * parent-side callbacks they persist through are the `mcp__subagents__persist_*`
 * tools that `handlers/servers.ts` already attaches to the Action Manager and
 * the Onboarding Manager. This file is the missing join between the two.
 *
 * ## Only Task-tool sub-agents belong here
 *
 * Agents invoked directly as room members (the Chat Summarizer, the characters)
 * get their identity through `parseAgentConfig` + `buildSystemPrompt` and a turn
 * of their own. Adding one here would give it a second, divergent prompt.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getSettings } from '../../config/settings'
import { getLogger } from '../../infrastructure/logging/logger'
import { SUBAGENT_TOOL_NAMES } from '../tools/subagent'

const logger = getLogger('SubagentDefinitions')

/**
 * The sub-agent types the `Task` tool may be asked for.
 *
 * World Seed Generator is deliberately absent: it was merged into the
 * Onboarding Manager, which now writes the seed through its own
 * `draft_world`/`persist_world` tools (see `tape/gameplay-tape.ts`).
 */
export const SUBAGENT_TYPES = [
  'item_designer',
  'character_designer',
  'location_designer',
  'detailed_character_designer',
] as const

export type SubagentType = (typeof SUBAGENT_TYPES)[number]

/** Folder under `agents/group_subagent/`. Case matters on Linux. */
const SUBAGENT_FOLDERS: Record<SubagentType, string> = {
  item_designer: 'Item_Designer',
  character_designer: 'Character_Designer',
  location_designer: 'Location_Designer',
  detailed_character_designer: 'detailed_character_designer',
}

/** Human-readable names, used in the prompt's opening line. */
const SUBAGENT_DISPLAY_NAMES: Record<SubagentType, string> = {
  item_designer: 'Item Designer',
  character_designer: 'Character Designer',
  location_designer: 'Location Designer',
  detailed_character_designer: 'Detailed Character Designer',
}

/** The files whose contents — and mtimes — make up a sub-agent's identity. */
const IDENTITY_FILES = ['in_a_nutshell.md', 'characteristics.md', 'description.md'] as const

/**
 * Which sub-agents a parent may dispatch to.
 *
 * Python keys this by agent *name* (`Action_Manager`, `Onboarding_Manager`);
 * this keys it by the {@link ServerRole} `turn.ts` has already computed from
 * those same names, so the tool set and the sub-agent set cannot disagree about
 * which kind of agent is running. The Onboarding Manager gets the fourth
 * designer because a world being created is where deep NPCs are worth the
 * tokens; mid-game the Action Manager wants the cheap three.
 */
const SUBAGENTS_BY_ROLE = {
  action_manager: ['item_designer', 'character_designer', 'location_designer'],
  onboarding: [
    'item_designer',
    'character_designer',
    'location_designer',
    'detailed_character_designer',
  ],
} as const satisfies Record<string, readonly SubagentType[]>

/** Roles that may invoke `Task` sub-agents. */
export type SubagentParentRole = keyof typeof SUBAGENTS_BY_ROLE

export function isSubagentParentRole(role: string): role is SubagentParentRole {
  return role in SUBAGENTS_BY_ROLE
}

// ============================================================================
// Filesystem
// ============================================================================

function subagentDir(type: SubagentType): string {
  return join(getSettings().paths.agentsDir, 'group_subagent', SUBAGENT_FOLDERS[type])
}

function readIdentityFile(dir: string, filename: string): string {
  try {
    return readFileSync(join(dir, filename), 'utf-8').trim()
  } catch {
    return ''
  }
}

/**
 * Mtimes of every identity file backing `types`, keyed by absolute path.
 *
 * Absent files are simply left out, so creating one later changes the map and
 * invalidates the cache. The path is part of the key, which is what makes the
 * cache also survive a settings change that moves `agentsDir` — the whole map
 * differs, so nothing stale can match.
 */
function identityMtimes(types: readonly SubagentType[]): Record<string, number> {
  const mtimes: Record<string, number> = {}
  for (const type of types) {
    const dir = subagentDir(type)
    for (const filename of IDENTITY_FILES) {
      const path = join(dir, filename)
      try {
        mtimes[path] = statSync(path).mtimeMs
      } catch {
        // Missing file: no entry, so its later creation is a change.
      }
    }
  }
  return mtimes
}

// ============================================================================
// Definition building
// ============================================================================

/**
 * The sub-agent's system prompt.
 *
 * Mirrors Python's `_build_subagent_prompt` heading for heading. The output
 * instruction is the load-bearing half: a sub-agent's prose return value is
 * discarded by the parent's tape, so a designer that does not call its persist
 * tool has done nothing at all.
 */
function buildSubagentPrompt(
  type: SubagentType,
  identity: string,
  characteristics: string,
  persistToolName: string | undefined,
): string {
  const displayName = SUBAGENT_DISPLAY_NAMES[type]

  let prompt = `You are ${displayName}, a specialized sub-agent in the ClaudeWorld TRPG system.

## Identity
${identity || `A specialized ${displayName} for ClaudeWorld TRPG.`}

## Guidelines
${characteristics || 'Follow the task instructions carefully and provide accurate results.'}`

  if (persistToolName) {
    prompt += `

## Output Instructions
You MUST use the \`${persistToolName}\` tool to persist your results. Do not return anything else or follow-up like 'I'll...', just use the tool.`
  } else {
    prompt += `

## Output Instructions
Provide your results as a clear, structured text response. Your output will be returned to the parent agent via the Task tool result.`
  }

  return prompt
}

/**
 * The qualified tool this sub-agent persists through, or `undefined`.
 *
 * `detailed_character_designer` has none, so it gets `tools: undefined` —
 * "inherit the parent's tools" in SDK terms — and the prose-output instruction.
 * That is Python's behaviour exactly; note that its group config nominates
 * `create_comprehensive_character`, which no parent role currently serves, so
 * today it is effectively a prose designer in both backends.
 */
export function persistToolFor(type: SubagentType): string | undefined {
  return type in SUBAGENT_TOOL_NAMES
    ? SUBAGENT_TOOL_NAMES[type as keyof typeof SUBAGENT_TOOL_NAMES]
    : undefined
}

/**
 * Build one sub-agent definition, reading its identity off disk.
 *
 * A missing folder is not an error: the prompt falls back to the generic text
 * above and the sub-agent still works, which is what keeps a half-installed
 * `agents/` tree from taking down a turn.
 */
export function buildSubagentDefinition(type: SubagentType): AgentDefinition {
  const dir = subagentDir(type)
  const identity = readIdentityFile(dir, 'in_a_nutshell.md')
  const characteristics = readIdentityFile(dir, 'characteristics.md')
  const description = readIdentityFile(dir, 'description.md')
  const persistToolName = persistToolFor(type)

  const definition: AgentDefinition = {
    description: description || `Sub-agent for ${type.replaceAll('_', ' ')}`,
    prompt: buildSubagentPrompt(type, identity, characteristics, persistToolName),
    // 'inherit' rather than an explicit id: a sub-agent must follow the
    // `USE_SONNET` flip with its parent, or an Opus turn silently spawns Sonnet
    // designers.
    model: 'inherit',
  }

  if (persistToolName) definition.tools = [persistToolName]

  return definition
}

/** Every sub-agent definition, unfiltered. Mostly useful to tests and the spike. */
export function buildSubagentDefinitions(): Record<string, AgentDefinition> {
  return Object.fromEntries(
    SUBAGENT_TYPES.map((type) => [type, buildSubagentDefinition(type)]),
  )
}

// ============================================================================
// Per-role cache
// ============================================================================

interface CacheEntry {
  mtimes: Record<string, number>
  definitions: Record<string, AgentDefinition>
}

/** Keyed by role *and* the surviving type list — see `availableTools` below. */
const cache = new Map<string, CacheEntry>()

function sameMtimes(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/**
 * Sub-agent definitions for one parent role, or `undefined` when the role has
 * none this turn.
 *
 * `availableTools` is this turn's qualified allow-list — the same
 * `servers.toolNames` handed to `Options.tools` — and is **required**, not
 * optional, because the failure it prevents is silent in the other direction
 * too. `buildToolSets` gates each persist tool on an optional `ServerDeps`
 * entry, so a caller wired without `items` serves no `persist_item`; an
 * `item_designer` definition restricted to it would then be dispatched with a
 * tool that does not exist, leaving the sub-agent no tools at all and its
 * design discarded as prose. Dropping the designer instead means `Task` reports
 * an unknown `subagent_type`, which is at least legible.
 *
 * `undefined` and not `{}`: `buildAgentOptions` only assigns `agents` when the
 * input is truthy, so this keeps the key out of the options object entirely
 * rather than handing the CLI an empty agent map.
 *
 * Cached on file mtimes for the same reason `yaml-config.ts` is — editing
 * `characteristics.md` must land on the next turn without a restart — and
 * re-stat'ing four small files per turn is cheaper than the prompt it builds.
 */
export function buildSubagentDefinitionsForRole(
  role: string,
  availableTools: readonly string[],
): Record<string, AgentDefinition> | undefined {
  if (!isSubagentParentRole(role)) return undefined

  const served = new Set(availableTools)
  const types = SUBAGENTS_BY_ROLE[role].filter((type) => {
    const tool = persistToolFor(type)
    // A designer that inherits the parent's tools has nothing to check.
    return tool === undefined || served.has(tool)
  })
  if (types.length === 0) return undefined

  // The surviving list is part of the key: two turns of the same role can be
  // served different tool sets, and the entry cached for one must not answer
  // for the other.
  const cacheKey = `${role}|${types.join(',')}`
  const mtimes = identityMtimes(types)

  const cached = cache.get(cacheKey)
  if (cached && sameMtimes(cached.mtimes, mtimes)) return cached.definitions

  const definitions = Object.fromEntries(
    types.map((type) => [type, buildSubagentDefinition(type)]),
  )
  cache.set(cacheKey, { mtimes, definitions })
  logger.debug(
    `Built ${Object.keys(definitions).length} sub-agent definitions for role ${role}`,
  )
  return definitions
}

/** Drop every cached definition. Tests and `resetSettings` callers want this. */
export function clearSubagentDefinitionCache(): void {
  cache.clear()
}
