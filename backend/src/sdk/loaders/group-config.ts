/**
 * Per-group agent configuration (`agents/group_<name>/group_config.yaml`).
 *
 * Ported from the group-related functions of `backend/sdk/loaders/yaml_loaders.py`.
 *
 * A group config carries two unrelated things: group-wide *behaviour* flags
 * (priority, transparency, …) and *tool access* lists. The tool lists exist at
 * two levels — group-wide and per-agent under `agents:` — and the per-agent
 * level **extends** the group level rather than replacing it, which is why
 * `Action_Manager` in `group_gameplay` ends up with the group's
 * `disabled_tools` plus its own `enabled_tools`.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { getSettings } from '../../config/settings'
import { getCachedConfig, type YamlConfig } from './yaml-config'

/** Tool-access keys whose values are merged as lists rather than overwritten. */
const LIST_KEYS = [
  'disabled_tools',
  'enabled_tools',
  'disabled_tool_groups',
  'enabled_tool_groups',
] as const

export type ToolListKey = (typeof LIST_KEYS)[number]

/** Known keys of a `group_config.yaml`; unknown keys are preserved verbatim. */
export interface GroupConfig extends YamlConfig {
  interrupt_every_turn?: boolean
  priority?: number
  transparent?: boolean
  can_see_system_messages?: boolean
  disabled_tools?: string[]
  enabled_tools?: string[]
  disabled_tool_groups?: string[]
  enabled_tool_groups?: string[]
  agents?: Record<string, YamlConfig>
}

/** Result of merging group-wide and per-agent settings for one agent. */
export interface AgentToolConfig extends YamlConfig {
  disabled_tools?: string[]
  enabled_tools?: string[]
  disabled_tool_groups?: string[]
  enabled_tool_groups?: string[]
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.map((entry) => String(entry))
}

/** Path of a group's config file. Exported so callers can watch/report on it. */
export function getGroupConfigPath(groupName: string): string {
  return join(getSettings().paths.agentsDir, `group_${groupName}`, 'group_config.yaml')
}

/**
 * Load `group_config.yaml` for a group.
 *
 * Returns `{}` for an unknown group or a missing file — a group without a
 * config is normal, not an error.
 */
export function getGroupConfig(groupName: string): GroupConfig {
  if (!groupName) return {}
  const path = getGroupConfigPath(groupName)
  // Existence is checked here rather than left to getCachedConfig so an absent
  // file stays silent; Python logs this case at debug, not warning.
  if (!existsSync(path)) return {}
  return getCachedConfig(path) as GroupConfig
}

/**
 * Load a group's `extreme_traits.yaml` (agent name → trait text).
 *
 * No group ships one today, but `sdk/handlers/guidelines_tools.py` still reads
 * it, so the empty-result path is the live one.
 */
export function getExtremeTraits(groupName: string): Record<string, string> {
  if (!groupName) return {}
  const path = join(getSettings().paths.agentsDir, `group_${groupName}`, 'extreme_traits.yaml')
  if (!existsSync(path)) return {}
  const config = getCachedConfig(path)

  const traits: Record<string, string> = {}
  for (const [name, value] of Object.entries(config)) {
    if (typeof value === 'string') traits[name] = value
  }
  return traits
}

/**
 * Resolve the effective tool configuration for one agent in a group.
 *
 * Group-level list settings come first, then the agent's own entry under
 * `agents:` extends those lists and overrides any other key.
 *
 * Divergence: Python merges the lists through `set(existing) | set(value)`,
 * which loses ordering — the result varies run to run under hash
 * randomization. Downstream only membership-tests these lists, so the
 * behaviour is the same, but we dedupe order-preserving (group entries first)
 * to keep logs and snapshots stable.
 */
export function getAgentToolConfig(groupName: string, agentName: string): AgentToolConfig {
  if (!groupName || !agentName) return {}

  const groupConfig = getGroupConfig(groupName)
  if (Object.keys(groupConfig).length === 0) return {}

  const result: AgentToolConfig = {}

  for (const key of LIST_KEYS) {
    const list = asStringList(groupConfig[key])
    if (list) result[key] = [...list]
  }

  const agentsSection = groupConfig.agents
  const agentConfig =
    agentsSection && typeof agentsSection === 'object' ? agentsSection[agentName] : undefined
  if (!agentConfig) return result

  for (const [key, value] of Object.entries(agentConfig)) {
    const list = (LIST_KEYS as readonly string[]).includes(key) ? asStringList(value) : null
    if (list) {
      const existing = result[key as ToolListKey] ?? []
      result[key as ToolListKey] = [...new Set([...existing, ...list])]
    } else {
      result[key] = value
    }
  }

  return result
}
