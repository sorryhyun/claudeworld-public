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

import { getSettings } from '@/config/settings'
import { getLogger } from '@/infrastructure/logging/logger'
import { LORE_CONTRIBUTION_TOOL, SUBAGENT_TOOL_NAMES } from '@/sdk/tools/subagent'

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
  loreToolName: string | undefined,
  settingsBrief: string,
): string {
  const displayName = SUBAGENT_DISPLAY_NAMES[type]

  let prompt = `You are ${displayName}, a specialized sub-agent in the ClaudeWorld TRPG system.

## Identity
${identity || `A specialized ${displayName} for ClaudeWorld TRPG.`}

## Guidelines
${characteristics || 'Follow the task instructions carefully and provide accurate results.'}`

  // Above the output instructions on purpose: it constrains *what* is written,
  // and a designer that reads the persist instruction first tends to treat the
  // tool call as the whole job. Empty for a turn with no world — a chat room has
  // no language to write in.
  if (settingsBrief) prompt += `\n\n${settingsBrief}`

  if (persistToolName) {
    prompt += `

## Output Instructions
You MUST use the \`${persistToolName}\` tool to persist your results. Do not return anything else or follow-up like 'I'll...', just use the tool.`
  } else {
    prompt += `

## Output Instructions
Provide your results as a clear, structured text response. Your output will be returned to the parent agent via the Task tool result.`
  }

  // Stated separately from the persist instruction on purpose: the persist call
  // is mandatory, this one is a judgement the designer makes about its own work.
  if (loreToolName) {
    prompt += `

## Extending the World
You may also write into the world's shared lore with \`${loreToolName}\`, under a
title of your choosing. Use it when your design establishes something the rest of
the world must honour afterwards — a faction, a custom, a history, the reason a
place is the way it is — and skip it when the design stands on its own. Do not
restate the design itself there; your persist tool already stores it. Calling it
again with the same title rewrites that section rather than adding a second.`
  }

  return prompt
}

/** `undefined` reads to the SDK as "inherit the parent's tools". */
export function persistToolFor(type: SubagentType): string | undefined {
  return type in SUBAGENT_TOOL_NAMES
    ? SUBAGENT_TOOL_NAMES[type as keyof typeof SUBAGENT_TOOL_NAMES]
    : undefined
}

/** A missing folder is not an error: the prompt falls back to generic text.
 *
 * `settingsBrief` is the world's ground rules, rendered by
 * `domain/world-settings.ts` — the language every player-visible string is
 * written in, above all. It is passed in rather than read here because this
 * module knows nothing about which world a turn is for; `orchestration/turn.ts`
 * holds that. Empty is legitimate: a chat room has no world.
 *
 * `withLoreTool` is the turn's answer to "is `add_world_lore` served" — the same
 * gate the persist tools go through. A designer restricted to a tool the turn
 * does not serve is dispatched with a tool that never answers, so the grant and
 * the prompt paragraph move together. Restricting `tools` at all is why this has
 * to be explicit: a designer with a persist tool no longer inherits the parent's
 * set, so it cannot reach the lore tool unless it is named here. */
export function buildSubagentDefinition(
  type: SubagentType,
  withLoreTool = true,
  settingsBrief = '',
): AgentDefinition {
  const dir = subagentDir(type)
  const identity = readIdentityFile(dir, 'in_a_nutshell.md')
  const characteristics = readIdentityFile(dir, 'characteristics.md')
  const description = readIdentityFile(dir, 'description.md')
  const persistToolName = persistToolFor(type)
  // A designer with no persist tool inherits the parent's whole set, the lore
  // tool included; naming it would *narrow* that rather than widen it.
  const loreToolName = persistToolName && withLoreTool ? LORE_CONTRIBUTION_TOOL : undefined

  const definition: AgentDefinition = {
    description: description || `Sub-agent for ${type.replaceAll('_', ' ')}`,
    prompt: buildSubagentPrompt(
      type,
      identity,
      characteristics,
      persistToolName,
      loreToolName,
      settingsBrief,
    ),
    // 'inherit', not an explicit id: a sub-agent must follow the `USE_SONNET`
    // flip with its parent, or an Opus turn silently spawns Sonnet designers.
    model: 'inherit',
  }

  if (persistToolName) {
    definition.tools = loreToolName ? [persistToolName, loreToolName] : [persistToolName]
  }

  return definition
}

export function buildSubagentDefinitions(settingsBrief = ''): Record<string, AgentDefinition> {
  return Object.fromEntries(
    SUBAGENT_TYPES.map((type) => [type, buildSubagentDefinition(type, true, settingsBrief)]),
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
 * `characteristics.md` lands on the next turn without a restart.
 *
 * `settingsBrief` is this world's ground rules — see
 * {@link buildSubagentDefinition}. It is part of the cache key rather than the
 * mtime map because it is rendered, not read from a file: a world whose language
 * changed mid-onboarding must not be answered with the previous language's
 * definitions. */
export function buildSubagentDefinitionsForRole(
  role: string,
  availableTools: readonly string[],
  settingsBrief = '',
): Record<string, AgentDefinition> | undefined {
  if (!isSubagentParentRole(role)) return undefined

  const served = new Set(availableTools)
  const types = SUBAGENTS_BY_ROLE[role].filter((type) => {
    const tool = persistToolFor(type)
    // A designer that inherits the parent's tools has nothing to check.
    return tool === undefined || served.has(tool)
  })
  if (types.length === 0) return undefined

  // Gated on `ServerDeps.worlds` in `buildToolSets`, so a turn without a world
  // service serves the persist tools and not this one.
  const withLoreTool = served.has(LORE_CONTRIBUTION_TOOL)

  // The surviving list is part of the key: two turns of one role can be served
  // different tool sets. So is the lore grant, for the same reason, and so is the
  // brief — hashed rather than embedded, since it is a paragraph and this key is
  // built on every turn.
  const cacheKey =
    `${role}|${types.join(',')}|${withLoreTool ? 'lore' : 'nolore'}` +
    `|${settingsBrief ? Bun.hash(settingsBrief).toString(16) : 'nobrief'}`
  const mtimes = identityMtimes(types)

  const cached = cache.get(cacheKey)
  if (cached && sameMtimes(cached.mtimes, mtimes)) return cached.definitions

  const definitions = Object.fromEntries(
    types.map((type) => [type, buildSubagentDefinition(type, withLoreTool, settingsBrief)]),
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
