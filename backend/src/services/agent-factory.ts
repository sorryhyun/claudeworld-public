// Agent creation — the seam between the `agents/` tree and the `agents` table.
// Everything that turns a folder on disk into a row happens here, so a
// character created mid-game and one seeded at startup take the same path.

import { eq } from 'drizzle-orm'

import { getPriorityAgentNames } from '../config/settings'
import { createAgent, getAgent, getAgentByName, updateAgent } from '../crud/agents'
import type { Db } from '../db'
import { agents, type Agent } from '../db/schema'
import { agentConfigKey, getCache } from '../infrastructure/cache'
import { getLogger } from '../infrastructure/logging/logger'
import { getGroupConfig } from '../sdk/loaders/group-config'
import { listAvailableConfigs, type AgentConfigData } from '../sdk/parsing/agent-config'
import { AgentConfigService } from './agent-config-service'
import { buildSystemPrompt } from './prompt-builder'

const logger = getLogger('AgentFactory')

export interface AgentSettings {
  interruptEveryTurn: boolean
  priority: number
  transparent: boolean
}

/** The four fields that can come from outside the agent folder. */
export type ProvidedAgentConfig = Partial<
  Pick<AgentConfigData, 'inANutshell' | 'characteristics' | 'recentEvents' | 'profilePic'>
>

export interface CreateFromConfigInput {
  name: string
  /** Agent *folder*, relative to the project root (`agents/group_x/Foo`). */
  configFile: string
  group?: string | null
  providedConfig?: ProvidedAgentConfig | null
  /** Omit to auto-detect from a `worlds/{name}/…` config path. */
  worldName?: string | null
}

function emptyAgentConfig(): AgentConfigData {
  return {
    configFile: null,
    inANutshell: null,
    characteristics: null,
    recentEvents: null,
    profilePic: null,
    longTermMemoryIndex: null,
    longTermMemorySubtitles: null,
    homeLocation: null,
  }
}

/**
 * Merge caller values over the agent folder's, taking `provided` only when
 * non-empty *after trimming* so `"  "` cannot blank a character. Everything
 * outside the four merged fields is dropped, memory index included — changing
 * that would rewrite every character's stored prompt.
 */
export function mergeAgentConfigs(
  provided: ProvidedAgentConfig,
  file: AgentConfigData | null,
): AgentConfigData {
  const pick = (
    key: 'inANutshell' | 'characteristics' | 'recentEvents' | 'profilePic',
  ): string => {
    const providedValue = (provided[key] ?? '').trim()
    return providedValue || (file?.[key] ?? '').trim()
  }

  return {
    ...emptyAgentConfig(),
    inANutshell: pick('inANutshell'),
    characteristics: pick('characteristics'),
    recentEvents: pick('recentEvents'),
    profilePic: pick('profilePic'),
  }
}

// Only keys *present* in the group config override the defaults, which is why
// this reads the raw object. `PRIORITY_AGENTS` wins over it, and its ordering
// *is* the priority: first name, highest number.
export function resolveGroupSettings(
  name: string,
  group: string | null | undefined,
  priorityNames: string[] = getPriorityAgentNames(),
): AgentSettings {
  const settings: AgentSettings = {
    interruptEveryTurn: false,
    priority: 0,
    transparent: false,
  }

  if (group) {
    const groupConfig = getGroupConfig(group)
    if ('interrupt_every_turn' in groupConfig) {
      settings.interruptEveryTurn = Boolean(groupConfig.interrupt_every_turn)
    }
    // `Number(...)` keeps a YAML `"5"` from reaching an INTEGER column as text.
    if ('priority' in groupConfig) settings.priority = Number(groupConfig.priority)
    if ('transparent' in groupConfig) settings.transparent = Boolean(groupConfig.transparent)
  }

  const index = priorityNames.indexOf(name)
  if (index !== -1) {
    settings.priority = priorityNames.length - index
    logger.info(
      `Agent '${name}' priority set to ${settings.priority} from PRIORITY_AGENTS env var`,
    )
  }

  return settings
}

// The path under `worlds/{world}/agents/` *is* the scoping information; system
// agents live under `agents/` and get NULL. Forward slashes on every platform.
function worldNameFromConfigFile(configFile: string): string | null {
  if (!configFile.startsWith('worlds/')) return null
  const parts = configFile.split('/')
  return parts.length >= 2 ? (parts[1] ?? null) : null
}

export class AgentFactory {
  constructor(private readonly configs: AgentConfigService = new AgentConfigService()) {}

  /**
   * Create an agent from its config folder, or update the row already there.
   * The update branch is not an optimisation: world-scoped names carry no
   * unique constraint, so without it replaying onboarding accumulates
   * duplicates. The probe is {@link getAgentByName}: "Old Man" hits "Old_Man".
   */
  createFromConfig(db: Db, input: CreateFromConfigInput): Agent {
    const fileConfig = this.configs.loadAgentConfig(input.configFile)

    const finalConfig = input.providedConfig
      ? mergeAgentConfigs(input.providedConfig, fileConfig)
      : (fileConfig ?? emptyAgentConfig())

    // From the source configs: the merge normalises a missing picture to `''`,
    // which `updateAgent` would write over NULL.
    const profilePic = input.providedConfig?.profilePic || fileConfig?.profilePic || null

    const systemPrompt = buildSystemPrompt(input.name, finalConfig)
    const settings = resolveGroupSettings(input.name, input.group)

    let effectiveWorldName = input.worldName ?? null
    if (!effectiveWorldName && input.configFile) {
      effectiveWorldName = worldNameFromConfigFile(input.configFile)
      if (effectiveWorldName) {
        logger.debug(`Auto-detected world_name '${effectiveWorldName}' from config_file`)
      }
    }

    const existing = getAgentByName(db, input.name, effectiveWorldName)
    if (existing) {
      logger.info(
        `Agent '${input.name}' already exists in world '${String(effectiveWorldName)}', ` +
          'updating instead of creating',
      )
      const updated = updateAgent(db, existing.id, {
        systemPrompt,
        profilePic,
        inANutshell: finalConfig.inANutshell,
        characteristics: finalConfig.characteristics,
        recentEvents: finalConfig.recentEvents,
        interruptEveryTurn: settings.interruptEveryTurn,
        priority: settings.priority,
        transparent: settings.transparent,
      })
      // Unreachable: `bun:sqlite` interleaves nothing between the statements.
      if (!updated) throw new Error(`Agent ${existing.id} disappeared while being updated`)
      return updated
    }

    return createAgent(db, {
      name: input.name,
      systemPrompt,
      profilePic,
      inANutshell: finalConfig.inANutshell,
      characteristics: finalConfig.characteristics,
      recentEvents: finalConfig.recentEvents,
      group: input.group ?? null,
      configFile: input.configFile,
      interruptEveryTurn: settings.interruptEveryTurn,
      priority: settings.priority,
      transparent: settings.transparent,
      worldName: effectiveWorldName,
    })
  }

  // Unlike {@link createFromConfig} this uses the file config *whole*, so the
  // memory index survives into the prompt.
  reloadFromConfig(db: Db, agentId: number): Agent | null {
    const agent = getAgent(db, agentId)
    if (!agent) return null

    if (!agent.configFile) {
      throw new Error(`Agent ${agent.name} does not have a config file to reload from`)
    }

    const configData = this.configs.loadAgentConfig(agent.configFile)
    if (!configData) throw new Error(`Failed to load config from ${agent.configFile}`)

    return updateAgent(db, agentId, {
      systemPrompt: buildSystemPrompt(agent.name, configData),
      profilePic: configData.profilePic,
      inANutshell: configData.inANutshell,
      characteristics: configData.characteristics,
      recentEvents: configData.recentEvents,
      ...resolveGroupSettings(agent.name, agent.group),
    })
  }

  // Filesystem-only: the column keeps its old text and the next prompt build
  // reads the file. A failed write is soft, and only `agent_config:{id}` is
  // invalidated — the row itself did not change.
  appendMemory(db: Db, agentId: number, memoryEntry: string): Agent | null {
    const agent = getAgent(db, agentId)
    if (!agent) return null

    if (!agent.configFile) {
      logger.warning(`Agent ${agent.name} has no config file, cannot append memory`)
      return agent
    }

    if (this.configs.appendToRecentEvents(agent.configFile, memoryEntry)) {
      getCache().invalidate(agentConfigKey(agentId))
    } else {
      logger.warning(`Failed to append memory to ${agent.configFile}`)
    }

    return agent
  }

  // The probe is an exact, unscoped match — deliberately not
  // {@link getAgentByName}, whose spelling variants would let a world character
  // "Old Man" suppress seeding of the system folder "Old_Man".
  seedFromConfigs(db: Db): Record<string, Agent> {
    const created: Record<string, Agent> = {}

    for (const [agentName, configInfo] of Object.entries(listAvailableConfigs())) {
      const existing = db.select().from(agents).where(eq(agents.name, agentName)).get()
      if (existing) continue

      created[agentName] = this.createFromConfig(db, {
        name: agentName,
        configFile: configInfo.path,
        group: configInfo.group,
      })

      const groupInfo = configInfo.group ? ` (group: ${configInfo.group})` : ''
      logger.info(
        `Created agent '${agentName}'${groupInfo} from config file: ${configInfo.path}`,
      )
    }

    return created
  }
}
