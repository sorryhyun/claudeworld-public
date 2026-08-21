import { getGroupConfig } from '../loaders/group-config'
import { ACTION_TOOLS } from './action'
import { formatTemplate, qualifiedToolName, type ToolDefinition } from './definitions'
import { ACTION_MANAGER_TOOLS } from './gameplay'
import { GUIDELINE_TOOLS } from './guideline'
import { ONBOARDING_TOOLS } from './onboarding'
import { SUBAGENT_TOOLS } from './subagent'
import { getLogger } from '../../infrastructure/logging/logger'

/**
 * The tool catalogue, and the `group_config.yaml` override path over it.
 * Port of `sdk/loaders/tools.py` plus `yaml_loaders.py::merge_tool_configs`.
 *
 * Why this exists at all: a tool's *declaration* — description and response
 * text — is data a world author can override per agent group, while its
 * handler is fixed code. Python keeps the two apart by looking every
 * description and response up through `get_tool_description` /
 * `get_tool_response` at server-build time rather than reading the
 * `ToolDefinition` directly. Phase 0's handlers read the definitions directly
 * and so silently dropped the override mechanism; every handler now goes
 * through {@link resolveTool}.
 *
 * The documented example in `CLAUDE.md` is the one to keep working:
 *
 * ```yaml
 * tools:
 *   recall:
 *     response: "{memory_content}"
 *   skip:
 *     response: "This character chooses to remain silent."
 * ```
 *
 * **`character_design` is deliberately not a group here.** Python's
 * `TOOL_GROUPS` list omits it too, which means `create_comprehensive_character`
 * and `implant_consolidated_memory` are invisible to `get_tool_description` and
 * cannot be overridden or disabled from a group config — their handler passes
 * literal strings instead. Adding it would be an improvement and a divergence;
 * the omission is reproduced and its consequence is called out on
 * {@link CHARACTER_DESIGN_GROUP}.
 */

const logger = getLogger('ToolRegistry')

/** Group names, in Python's `TOOL_GROUPS` order — lookup order matters below. */
export const TOOL_GROUPS = [
  'action',
  'guidelines',
  'onboarding',
  'action_manager',
  'subagents',
] as const

export type ToolGroupName = (typeof TOOL_GROUPS)[number]

/**
 * The group `character_design` tools *would* live in if Python listed it.
 * Referenced by name so the omission is greppable rather than implicit.
 */
export const CHARACTER_DESIGN_GROUP = 'character_design'

const BASE_CATALOGUE: Readonly<Record<ToolGroupName, Record<string, ToolDefinition>>> = {
  action: ACTION_TOOLS,
  guidelines: GUIDELINE_TOOLS,
  onboarding: ONBOARDING_TOOLS,
  action_manager: ACTION_MANAGER_TOOLS,
  subagents: SUBAGENT_TOOLS,
}

/** A definition after group overrides, decoupled from the frozen base object. */
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

/** Find a tool by short name across every group, in `TOOL_GROUPS` order. */
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

/**
 * Pull the override block for one tool out of a group config.
 *
 * Both layouts `merge_tool_configs` accepts are supported, and for the same
 * reason it supports both: the shipped example uses the flat `tools:` form,
 * while the group-keyed form lets a config disambiguate a name that appears in
 * two groups. The group-keyed form wins when both are present, matching
 * Python's `if has_new_format / elif has_legacy_format` branch order.
 */
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

/**
 * The declaration a handler should build its tool from.
 *
 * `null` means "do not offer this tool": either the name is unknown, or the
 * effective `enabled` flag is false. Handlers branch on that rather than on a
 * separate `isToolEnabled` call, which is what keeps the disabled case from
 * being checked in one place and forgotten in another.
 *
 * @param toolName Short name, e.g. `recall` — never the `mcp__…` form.
 * @param groupName The agent's group, with or without its `group_` prefix.
 */
export function resolveTool(toolName: string, groupName?: string | null): ResolvedTool | null {
  const found = findInCatalogue(toolName)
  if (!found) {
    logger.warning(`Tool '${toolName}' not found in configuration`)
    return null
  }

  const resolved = toResolved(found.definition)

  if (groupName) {
    // The config lives at `agents/group_<name>/`, so the prefix must not be
    // doubled. Python strips it in `mcp_registry.py::_get_agent_tool_config`
    // and *not* in `get_tool_description`, which works only because the
    // `agents.group` column happens to hold the bare name; stripping in both
    // places makes the lookup correct for either spelling.
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

/**
 * The response text for one tool, with `{placeholder}` slots filled.
 * Port of `get_tool_response`, including its "unknown tool" sentinel.
 */
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

/**
 * Whether a tool is enabled, ignoring group overrides.
 *
 * Python's `is_tool_enabled` reads the *base* config — `get_tools_config()`,
 * not `_get_tools_config_for_group()` — so a group config cannot disable a tool
 * through this path even though it can through `get_tool_description`. That
 * asymmetry is load-bearing for `getToolNamesByGroup`, which uses this function
 * to decide what goes in `allowedTools`: were it group-aware, a group that
 * disabled a tool would remove it from the allow-list *and* from the server,
 * and the two lists would stop agreeing about what exists.
 */
export function isToolEnabled(toolName: string, defaultValue = false): boolean {
  const found = findInCatalogue(toolName)
  if (!found) return defaultValue
  return found.definition.enabled ?? true
}

/** Every enabled tool in a group, as `mcp__<server>__<tool>`. */
export function getToolNamesByGroup(group: string, enabledOnly = true): string[] {
  if (!(TOOL_GROUPS as readonly string[]).includes(group)) return []
  const tools = BASE_CATALOGUE[group as ToolGroupName]

  const names: string[] = []
  for (const toolName of Object.keys(tools)) {
    if (enabledOnly && !isToolEnabled(toolName)) continue
    // The server prefix is the group name for four of the five groups; `action`
    // and `guidelines` are their own servers, `action_manager` and `subagents`
    // likewise. Deriving it keeps the qualified name from being written down
    // twice, which is what `definitions.ts` set out to prevent.
    names.push(qualifiedToolName(group, toolName))
  }
  return names
}

/** The catalogue itself, for tests and for the debug router. */
export function getToolsByGroup(group: string): Record<string, ToolDefinition> {
  if (!(TOOL_GROUPS as readonly string[]).includes(group)) return {}
  return BASE_CATALOGUE[group as ToolGroupName]
}
