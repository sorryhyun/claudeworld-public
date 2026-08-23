/**
 * Per-group agent configuration (`agents/group_<name>/group_config.yaml`):
 * behaviour flags plus tool-access lists. The lists exist group-wide and
 * per-agent under `agents:`, and the per-agent level **extends** the group level
 * rather than replacing it.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { getSettings } from '@/config/settings'
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

/** Returns `{}` for an unknown group: a group without a config is normal. */
export function getGroupConfig(groupName: string): GroupConfig {
  if (!groupName) return {}
  const path = getGroupConfigPath(groupName)
  // Checked here rather than in getCachedConfig so an absent file stays silent.
  if (!existsSync(path)) return {}
  return getCachedConfig(path) as GroupConfig
}

/** Agent name → trait text. No group ships one, so `{}` is the live path. */
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
 * The effective tool configuration for one agent: group-level lists first, then
 * the agent's entry under `agents:` extends those lists and overrides any other
 * key. Deduping preserves order, group entries first, so logs stay stable.
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
