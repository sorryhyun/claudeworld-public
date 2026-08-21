/**
 * Agent creation — the seam between the `agents/` tree and the `agents` table.
 *
 * Ported from `backend/services/agent_factory.py`.
 *
 * `crud/agents.ts` is deliberately dumb: it writes the columns it is handed and
 * reads no files. Everything that turns *a folder on disk* into *a row* happens
 * here — loading the config, merging in whatever the caller supplied, rendering
 * the system prompt, and resolving the behaviour flags a group config implies.
 * Split that way, a character created by the Character Designer mid-game and one
 * seeded at startup go through exactly the same path.
 *
 * The database is a cache of the filesystem, so nothing here is the last word:
 * `recent_events.md` is appended to on disk and the row is left alone
 * ({@link AgentFactory.appendMemory}), and the stored `system_prompt` is
 * rebuilt from the files whenever {@link AgentFactory.reloadFromConfig} runs.
 *
 * `AgentConfigService` is a constructor argument rather than a module-level
 * singleton so a test can point the factory at a temp `agents/` tree — the same
 * shape `WorldService` and `AgentConfigService` already use.
 */

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

// ============================================================================
// Types
// ============================================================================

/** Behaviour flags resolved from a group config and `PRIORITY_AGENTS`. */
export interface AgentSettings {
  interruptEveryTurn: boolean
  priority: number
  transparent: boolean
}

/**
 * Caller-supplied overrides for the four fields that can come from somewhere
 * other than the agent folder.
 *
 * The Character Designer supplies `inANutshell`/`characteristics` for a
 * character it has just written; the agents REST route supplies whatever the
 * request body carried. Python types this as a full `AgentConfigData` but only
 * ever populates these four (`agent_factory.py:44-49`).
 */
export type ProvidedAgentConfig = Partial<
  Pick<AgentConfigData, 'inANutshell' | 'characteristics' | 'recentEvents' | 'profilePic'>
>

/** Arguments of `AgentFactory.create_from_config` (`agent_factory.py:108`). */
export interface CreateFromConfigInput {
  name: string
  /** Agent *folder*, relative to the project root (`agents/group_x/Foo`). */
  configFile: string
  group?: string | null
  providedConfig?: ProvidedAgentConfig | null
  /** Omit to auto-detect from a `worlds/{name}/…` config path. */
  worldName?: string | null
}

// ============================================================================
// Config merging
// ============================================================================

/** `AgentConfigData()` with every field at its Python default. */
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
 * Merge caller-supplied values over the values read from the agent folder.
 *
 * A field is taken from `provided` when it is non-empty *after trimming*, and
 * from `file` otherwise — so a request body carrying `characteristics: "  "`
 * falls back to the file rather than blanking the character.
 *
 * **This drops everything outside the four merged fields, including the memory
 * index.** Python builds the result with `AgentConfigData(**merged)`
 * (`agent_factory.py:67`), so `long_term_memory_subtitles` comes back as None
 * even when the file config had one. The visible consequence is that an agent
 * created *with* a provided config gets a system prompt with no
 * `기억 index` section, while the same agent created without one does — and the
 * section reappears the first time {@link AgentFactory.reloadFromConfig} runs,
 * because that path uses the file config whole. Reproduced as written: fixing it
 * would silently change the stored prompt of every character the Character
 * Designer has ever created.
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

// ============================================================================
// Group settings
// ============================================================================

/**
 * Resolve an agent's behaviour flags from its group config, then from
 * `PRIORITY_AGENTS`.
 *
 * Only keys actually *present* in the group config override the defaults, so a
 * group that sets `priority` but not `transparent` leaves the latter false
 * rather than reading it as missing-and-therefore-false. That distinction is why
 * this reads the raw config object instead of a parsed one with defaults filled
 * in.
 *
 * `PRIORITY_AGENTS` wins over the group config, and its ordering is the
 * priority: the *first* name in the list gets the highest number
 * (`len - index`), so the env var reads as a ranking rather than as a set. A
 * name appearing twice takes its first position, as `list.index` does.
 *
 * `priorityNames` is a parameter only so tests can pin it; production callers
 * omit it and get the process settings, matching Python's
 * `get_settings().get_priority_agent_names()`.
 */
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
    // Python assigns `group_config["priority"]` unconverted, so a YAML value of
    // `"5"` would reach the column as a string. Numbers are what every shipped
    // config carries; `Number(...)` normalises the stray case rather than
    // letting a string into an INTEGER column.
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

/**
 * Recover the world a `worlds/{world}/agents/{agent}` config belongs to.
 *
 * World-scoped characters are stored under the world directory, so the path
 * *is* the scoping information; system agents live under `agents/` and get
 * NULL. Forward slashes only, matching how the column is written on every
 * platform.
 */
function worldNameFromConfigFile(configFile: string): string | null {
  if (!configFile.startsWith('worlds/')) return null
  const parts = configFile.split('/')
  return parts.length >= 2 ? (parts[1] ?? null) : null
}

// ============================================================================
// Factory
// ============================================================================

export class AgentFactory {
  /**
   * @param configs Reader/writer for the `agents/` tree. Defaults to one rooted
   *   at the process project root.
   */
  constructor(private readonly configs: AgentConfigService = new AgentConfigService()) {}

  /**
   * Create an agent from its config folder, or update the row that is already
   * there.
   *
   * The update branch is not an optimisation. Resetting a world wipes the
   * filesystem but leaves the `agents` rows behind, and world-scoped names are
   * not unique-constrained — so without it, replaying onboarding would
   * accumulate a second, third and fourth "Elara" and the room-membership
   * lookups would start resolving to whichever one SQLite returned first.
   *
   * Note the existence probe goes through {@link getAgentByName}, which also
   * tries the space/underscore spellings of the name. A character called
   * "Old Man" therefore updates a pre-existing "Old_Man" rather than creating a
   * twin — which is the intent, since those two spellings refer to one
   * character everywhere else in the codebase.
   */
  createFromConfig(db: Db, input: CreateFromConfigInput): Agent {
    const fileConfig = this.configs.loadAgentConfig(input.configFile)

    const finalConfig = input.providedConfig
      ? mergeAgentConfigs(input.providedConfig, fileConfig)
      : (fileConfig ?? emptyAgentConfig())

    // Resolved separately from `finalConfig` because the merge normalises a
    // missing picture to `''`, and `updateAgent` treats `''` as a value to
    // write while Python's `if x is not None` treats it as one too — but the
    // *create* path stores NULL for a falsy picture. Taking it from the source
    // configs keeps both paths on Python's `None`.
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
      // `updateAgent` only returns null when the row vanished between the two
      // statements, which cannot happen: `bun:sqlite` runs each to completion
      // with nothing interleaved. Python would return None here and let the
      // caller dereference it.
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

  /**
   * Rebuild an agent's row from its config folder — the hot-reload entry point.
   *
   * `null` when the agent does not exist. Throws when it exists but has nothing
   * to reload from, because that is a caller error the route surfaces as a 400
   * rather than a silent no-op.
   *
   * Unlike {@link createFromConfig} this uses the file config *whole*, so the
   * memory index survives into the prompt.
   */
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

  /**
   * Append a memory line to the agent's `recent_events.md`.
   *
   * Filesystem-only by design: the `recent_events` *column* is left holding the
   * text it had, and the next prompt build reads the file. Returns the agent
   * unchanged so callers can keep reporting on it — including when the write
   * failed, which is a soft failure here as it is in the `memorize` handler.
   *
   * Only `agent_config:{id}` is invalidated, not the whole agent cache. The row
   * did not change, so its object entry is still correct; dropping it too would
   * cost a re-read for nothing. Python invalidates exactly this one key
   * (`agent_factory.py:288-292`).
   */
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

  /**
   * Create a row for every agent folder that does not have one yet. Runs at
   * startup; returns only what it created.
   *
   * The existence probe is an exact, *unscoped* name match — deliberately not
   * {@link getAgentByName}, whose spelling variants would let a world character
   * called "Old Man" suppress the seeding of a system agent folder named
   * "Old_Man". Unscoped means a world character sharing a name with a config
   * folder also suppresses it; that is Python's behaviour
   * (`agent_factory.py:315-317`) and it only bites worlds whose cast collides
   * with a top-level agent folder.
   *
   * Folder discovery goes through `listAvailableConfigs()`, which reads the
   * *process* `agents/` directory rather than this factory's. Python has the
   * same split and it only matters under test.
   */
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
