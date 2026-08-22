/**
 * Agent configuration parsing from the `agents/` tree. The filesystem is the
 * source of truth: each agent is a folder of markdown sections re-read on every
 * response, so an edit lands without a restart. The database only caches it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { YAML } from 'bun'

import { getSettings } from '../../config/settings'
import { parseLongTermMemory } from './memory'
import { getLogger } from '../../infrastructure/logging/logger'

const logger = getLogger('AgentConfig')

/** A folder is an agent if it has at least one of these. */
export const REQUIRED_AGENT_FILES = ['in_a_nutshell.md', 'characteristics.md'] as const

/** Folders under `agents/` with this prefix hold a group of agents. */
export const GROUP_DIR_PREFIX = 'group_'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'] as const
const PROFILE_PIC_NAMES = ['profile', 'avatar', 'picture', 'photo'] as const

export interface AgentConfigData {
  /** Path to the agent folder, relative to the project root. */
  configFile: string | null
  inANutshell: string | null
  characteristics: string | null
  recentEvents: string | null
  /** Filename only (not a path) of the profile image, if any. */
  profilePic: string | null
  /** `subtitle -> full memory text`, backing the `recall` tool. */
  longTermMemoryIndex: Record<string, string> | null
  /** Pre-rendered `'a', 'b'` subtitle list injected into the system prompt. */
  longTermMemorySubtitles: string | null
  /** From the folder's optional `config.yaml`; used for TRPG placement. */
  homeLocation: string | null
}

export interface AgentConfigEntry {
  /** Agent folder path relative to the project root. */
  path: string
  /** Group name with the `group_` prefix stripped, or null when ungrouped. */
  group: string | null
}

export function hasContent(config: AgentConfigData): boolean {
  return Boolean(config.inANutshell || config.characteristics || config.recentEvents)
}

function readSection(folderPath: string, filename: string): string {
  try {
    return readFileSync(join(folderPath, filename), 'utf-8').trim()
  } catch {
    return ''
  }
}

function readYamlConfig(folderPath: string): Record<string, unknown> {
  const configFile = join(folderPath, 'config.yaml')
  if (!existsSync(configFile)) return {}
  try {
    const parsed: unknown = YAML.parse(readFileSync(configFile, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    logger.warning(`Failed to parse config.yaml in ${folderPath}: ${String(error)}`)
  }
  return {}
}

// Conventional names win over an arbitrary image, so a folder holding both
// `profile.png` and a screenshot picks the intended one.
function findProfilePic(folderPath: string): string | null {
  let entries: string[]
  try {
    // Sorted: raw readdir order is filesystem-dependent, so the fallback scan
    // below would pick a different file on two machines.
    entries = readdirSync(folderPath).sort()
  } catch {
    return null
  }

  const present = new Set(entries)
  for (const name of PROFILE_PIC_NAMES) {
    for (const ext of IMAGE_EXTENSIONS) {
      const candidate = `${name}${ext}`
      if (present.has(candidate)) return candidate
    }
  }

  for (const ext of IMAGE_EXTENSIONS) {
    const match = entries.find((entry) => entry.endsWith(ext))
    if (match !== undefined) return match
  }

  return null
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Parse an agent folder. `folderPath` may be absolute or relative to the project
 * root — the form stored in the `config_file` column. `null` when missing.
 */
export function parseAgentConfig(folderPath: string): AgentConfigData | null {
  const settings = getSettings()
  const absolute = isAbsolute(folderPath)
    ? resolve(folderPath)
    : join(settings.paths.projectRoot, folderPath)

  if (!isDirectory(absolute)) return null

  try {
    const memoryFile = join(absolute, 'consolidated_memory.md')
    let longTermMemoryIndex: Record<string, string> | null = null
    let longTermMemorySubtitles: string | null = null

    if (existsSync(memoryFile)) {
      const parsed = parseLongTermMemory(memoryFile)
      if (Object.keys(parsed).length > 0) {
        longTermMemoryIndex = parsed
        // Quoted and joined here, not at injection time: this exact string is
        // what gets persisted and rendered in the prompt.
        longTermMemorySubtitles = Object.keys(parsed)
          .map((subtitle) => `'${subtitle}'`)
          .join(', ')
      }
    }

    const yamlConfig = readYamlConfig(absolute)
    const homeLocation = yamlConfig.home_location

    return {
      // The caller supplies this from the DB row.
      configFile: null,
      inANutshell: readSection(absolute, 'in_a_nutshell.md'),
      characteristics: readSection(absolute, 'characteristics.md'),
      recentEvents: readSection(absolute, 'recent_events.md'),
      profilePic: findProfilePic(absolute),
      longTermMemoryIndex,
      longTermMemorySubtitles,
      homeLocation: typeof homeLocation === 'string' ? homeLocation : null,
    }
  } catch (error) {
    logger.error(`Error parsing agent config ${absolute}: ${String(error)}`)
    return null
  }
}

function hasRequiredFile(folderPath: string): boolean {
  return REQUIRED_AGENT_FILES.some((file) => existsSync(join(folderPath, file)))
}

/**
 * Enumerate every agent folder under `agents/`, in both layouts:
 * `agents/<name>/` and `agents/group_<group>/<name>/`. Agent names are the map
 * keys, so two groups cannot hold the same name — the second silently wins.
 */
export function listAvailableConfigs(): Record<string, AgentConfigEntry> {
  const { projectRoot, agentsDir } = getSettings().paths
  if (!existsSync(agentsDir)) return {}

  const configs: Record<string, AgentConfigEntry> = {}

  for (const entry of readdirSync(agentsDir).sort()) {
    if (entry.startsWith('.')) continue
    const entryPath = join(agentsDir, entry)
    if (!isDirectory(entryPath)) continue

    if (entry.startsWith(GROUP_DIR_PREFIX)) {
      const groupName = entry.slice(GROUP_DIR_PREFIX.length)
      for (const agentEntry of readdirSync(entryPath).sort()) {
        if (agentEntry.startsWith('.')) continue
        const agentPath = join(entryPath, agentEntry)
        if (!isDirectory(agentPath) || !hasRequiredFile(agentPath)) continue
        configs[agentEntry] = { path: relative(projectRoot, agentPath), group: groupName }
      }
    } else if (hasRequiredFile(entryPath)) {
      configs[entry] = { path: relative(projectRoot, entryPath), group: null }
    }
  }

  return configs
}
