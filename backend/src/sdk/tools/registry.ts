import { getGroupConfig } from '../loaders/group-config'
import { ACTION_TOOLS } from './action'
import { formatTemplate, qualifiedToolName, type ToolDefinition } from './definitions'
import { ACTION_MANAGER_TOOLS } from './gameplay'
import { GUIDELINE_TOOLS } from './guideline'
import { ONBOARDING_TOOLS } from './onboarding'
import { SUBAGENT_TOOLS } from './subagent'
import { getLogger } from '../../infrastructure/logging/logger'

/**
 * The tool catalogue and the `group_config.yaml` override path over it. A tool's
 * *declaration* — description and response text — is data a world author can
 * override per agent group, so every handler must go through {@link resolveTool}
 * rather than reading a `ToolDefinition` directly, or the override mechanism
 * silently disappears. **`character_design` is deliberately not a group here**,
 * so its two tools cannot be overridden or disabled from a group config.
 */

const logger = getLogger('ToolRegistry')

/** Order matters: this is the catalogue lookup order. */
export const TOOL_GROUPS = [
  'action',
  'guidelines',
  'onboarding',
  'action_manager',
  'subagents',
] as const

export type ToolGroupName = (typeof TOOL_GROUPS)[number]

/** The group `character_design`'s tools would live in; named so the omission is
 * greppable. */
export const CHARACTER_DESIGN_GROUP = 'character_design'

const BASE_CATALOGUE: Readonly<Record<ToolGroupName, Record<string, ToolDefinition>>> = {
  action: ACTION_TOOLS,
  guidelines: GUIDELINE_TOOLS,
  onboarding: ONBOARDING_TOOLS,
  action_manager: ACTION_MANAGER_TOOLS,
  subagents: SUBAGENT_TOOLS,
}

/** Decoupled from the frozen base object. */
export interface ResolvedTool {
  name: string
  description: string
  response: string
  enabled: boolean
}

function toResolved(definition: ToolDefinition): ResolvedTool {
  return {
    name: definition.name,
    description: definition.description,
    response: definition.response ?? '',
    enabled: definition.enabled ?? true,
  }
}

function findInCatalogue(
  toolName: string,
): { group: ToolGroupName; definition: ToolDefinition } | null {
  for (const group of TOOL_GROUPS) {
    const tools = BASE_CATALOGUE[group]
    if (Object.hasOwn(tools, toolName)) {
      return { group, definition: tools[toolName]! }
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// Two layouts: the flat `tools:` form, and a group-keyed form that disambiguates
// a name appearing in two groups. Group-keyed wins.
function findOverride(
  groupConfig: Record<string, unknown>,
  group: ToolGroupName,
  toolName: string,
): Record<string, unknown> | null {
  const groupKeyed = asRecord(groupConfig[group])
  if (groupKeyed) {
    const override = asRecord(groupKeyed[toolName])
    if (override) return override
  }

  const hasGroupKeyedForm = TOOL_GROUPS.some((name) => asRecord(groupConfig[name]) !== null)
  if (hasGroupKeyedForm) return null

  const flat = asRecord(groupConfig.tools)
  return flat ? asRecord(flat[toolName]) : null
}

/** `null` means "do not offer this tool" — unknown name, or `enabled` false.
 * Handlers branch on that rather than on a separate {@link isToolEnabled} call.
 * @param toolName Short name, e.g. `recall` — never the `mcp__…` form.
 * @param groupName The agent's group, with or without its `group_` prefix. */
export function resolveTool(toolName: string, groupName?: string | null): ResolvedTool | null {
  const found = findInCatalogue(toolName)
  if (!found) {
    logger.warning(`Tool '${toolName}' not found in configuration`)
    return null
  }

  const resolved = toResolved(found.definition)

  if (groupName) {
    // The config lives at `agents/group_<name>/`, so the prefix must not be
    // doubled; stripping it here makes the lookup correct for either spelling.
    const lookupName = groupName.startsWith('group_') ? groupName.slice(6) : groupName
    const groupConfig = getGroupConfig(lookupName)
    const override = findOverride(groupConfig, found.group, toolName)

    if (override) {
      if (typeof override.description === 'string') resolved.description = override.description
      if (typeof override.response === 'string') resolved.response = override.response
      if (typeof override.enabled === 'boolean') resolved.enabled = override.enabled
    }
  }

  return resolved.enabled ? resolved : null
}

export function getToolResponse(
  toolName: string,
  groupName: string | null | undefined,
  values: Record<string, string | number> = {},
): string {
  const found = findInCatalogue(toolName)
  if (!found) return 'Tool response not configured.'
  const resolved = resolveTool(toolName, groupName) ?? toResolved(found.definition)
  return formatTemplate(resolved.response, values)
}

/** **Ignores group overrides**, which is load-bearing for
 * {@link getToolNamesByGroup}: were this group-aware, a group disabling a tool
 * would drop it from `allowedTools` *and* the server, and the two lists would
 * stop agreeing about what exists. */
export function isToolEnabled(toolName: string, defaultValue = false): boolean {
  const found = findInCatalogue(toolName)
  if (!found) return defaultValue
  return found.definition.enabled ?? true
}

/** Silent on an unknown name, unlike {@link resolveTool}: `character_design`'s
 * tools are absent on purpose. Group-blind, because a config that could flip this
 * would grant the CLI permission to run a mutation concurrently. */
export function isReadOnlyTool(toolName: string): boolean {
  return findInCatalogue(toolName)?.definition.readOnly === true
}

/** Qualified as `mcp__<server>__<tool>`. */
export function getToolNamesByGroup(group: string, enabledOnly = true): string[] {
  if (!(TOOL_GROUPS as readonly string[]).includes(group)) return []
  const tools = BASE_CATALOGUE[group as ToolGroupName]

  const names: string[] = []
  for (const toolName of Object.keys(tools)) {
    if (enabledOnly && !isToolEnabled(toolName)) continue
    // Derived rather than written down twice — see `definitions.ts`.
    names.push(qualifiedToolName(group, toolName))
  }
  return names
}

export function getToolsByGroup(group: string): Record<string, ToolDefinition> {
  if (!(TOOL_GROUPS as readonly string[]).includes(group)) return {}
  return BASE_CATALOGUE[group as ToolGroupName]
}
