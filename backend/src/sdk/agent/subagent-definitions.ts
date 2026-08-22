/**
 * `AgentDefinition`s for the SDK-native `Task` sub-agents. Built-in agents are off
 * and `settingSources: []` blocks filesystem discovery, so `Options.agents` is the
 * *only* way a sub-agent can exist. **Only Task-tool sub-agents belong here** —
 * agents invoked directly as room members get their identity through
 * `parseAgentConfig` + `buildSystemPrompt`, and adding one here would give it a
 * second, divergent prompt.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getSettings } from '../../config/settings'
import { getLogger } from '../../infrastructure/logging/logger'
import { SUBAGENT_TOOL_NAMES } from '../tools/subagent'

const logger = getLogger('SubagentDefinitions')

// World Seed Generator is absent: merged into the Onboarding Manager, which
// writes the seed through its own `draft_world`/`persist_world`.
export const SUBAGENT_TYPES = [
  'item_designer',
  'character_designer',
  'location_designer',
  'detailed_character_designer',
] as const

export type SubagentType = (typeof SUBAGENT_TYPES)[number]

const SUBAGENT_FOLDERS: Record<SubagentType, string> = {
  item_designer: 'Item_Designer',
  character_designer: 'Character_Designer',
  location_designer: 'Location_Designer',
  detailed_character_designer: 'detailed_character_designer',
}

const SUBAGENT_DISPLAY_NAMES: Record<SubagentType, string> = {
  item_designer: 'Item Designer',
  character_designer: 'Character Designer',
  location_designer: 'Location Designer',
  detailed_character_designer: 'Detailed Character Designer',
}

/** Contents *and* mtimes: these back the cache key below. */
const IDENTITY_FILES = ['in_a_nutshell.md', 'characteristics.md', 'description.md'] as const

// Keyed by the `ServerRole` `turn.ts` already computed, so the tool set and the
// sub-agent set cannot disagree about which agent is running.
const SUBAGENTS_BY_ROLE = {
  action_manager: ['item_designer', 'character_designer', 'location_designer'],
  onboarding: [
    'item_designer',
    'character_designer',
    'location_designer',
    'detailed_character_designer',
  ],
} as const satisfies Record<string, readonly SubagentType[]>

export type SubagentParentRole = keyof typeof SUBAGENTS_BY_ROLE

export function isSubagentParentRole(role: string): role is SubagentParentRole {
  return role in SUBAGENTS_BY_ROLE
}

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

// The output instruction is load-bearing: a sub-agent's prose return is discarded,
// so a designer that skips its persist tool did nothing.
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

/** `undefined` reads to the SDK as "inherit the parent's tools". */
export function persistToolFor(type: SubagentType): string | undefined {
  return type in SUBAGENT_TOOL_NAMES
    ? SUBAGENT_TOOL_NAMES[type as keyof typeof SUBAGENT_TOOL_NAMES]
    : undefined
}

/** A missing folder is not an error: the prompt falls back to generic text. */
export function buildSubagentDefinition(type: SubagentType): AgentDefinition {
  const dir = subagentDir(type)
  const identity = readIdentityFile(dir, 'in_a_nutshell.md')
  const characteristics = readIdentityFile(dir, 'characteristics.md')
  const description = readIdentityFile(dir, 'description.md')
  const persistToolName = persistToolFor(type)

  const definition: AgentDefinition = {
    description: description || `Sub-agent for ${type.replaceAll('_', ' ')}`,
    prompt: buildSubagentPrompt(type, identity, characteristics, persistToolName),
    // 'inherit', not an explicit id: a sub-agent must follow the `USE_SONNET`
    // flip with its parent, or an Opus turn silently spawns Sonnet designers.
    model: 'inherit',
  }

  if (persistToolName) definition.tools = [persistToolName]

  return definition
}

export function buildSubagentDefinitions(): Record<string, AgentDefinition> {
  return Object.fromEntries(
    SUBAGENT_TYPES.map((type) => [type, buildSubagentDefinition(type)]),
  )
}

interface CacheEntry {
  mtimes: Record<string, number>
  definitions: Record<string, AgentDefinition>
}

const cache = new Map<string, CacheEntry>()

function sameMtimes(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/** `undefined`, not `{}`, when the role has no sub-agents this turn —
 * `buildAgentOptions` only assigns `agents` for a truthy input.
 *
 * `availableTools` is this turn's qualified allow-list and is **required**: a
 * designer restricted to a persist tool the turn does not serve is dispatched with
 * no tools at all and its design discarded as prose, whereas dropping the designer
 * makes `Task` report an unknown `subagent_type`. Cached on mtimes, so editing
 * `characteristics.md` lands on the next turn without a restart. */
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

  // The surviving list is part of the key: two turns of one role can be served
  // different tool sets.
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

export function clearSubagentDefinitionCache(): void {
  cache.clear()
}
