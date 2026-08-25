import { addCharacterToLocation, getLocationByName } from '@/crud/locations'
import { getAgentByName } from '@/crud/agents'
import type { LocationStorage } from '@/services/location-storage'
import type { PlayerService } from '@/services/player-service'
import type { WorldService } from '@/services/world-service'
import { WorldResetService } from '@/services/world-reset-service'
import { getLoreGuidelinesConfig } from '@/sdk/loaders/yaml-config'
import { formatTemplate } from '@/sdk/tools/definitions'
import {
  completeTool,
  draftWorldTool,
  persistWorldTool,
  readLoreGuidelinesTool,
  setWorldSettingsTool,
  worldStatusTool,
} from '@/sdk/tools/onboarding'
import {
  NAMING_STYLE_KEY,
  STYLE_NOTES_KEY,
  renderWorldSettingsBrief,
  toWorldSettings,
} from '@/domain/world-settings'
import { resolveTool } from '@/sdk/tools/registry'
import { getLogger } from '@/infrastructure/logging/logger'
import type { AgentFilesystemService } from '@/services/agent-filesystem-service'
import type { ItemService } from '@/services/item-service'
import { composeLore, listAdditionTitles, splitLore } from './lore-sections'
import { tool, requireWorldName, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * World initialisation. `draft_world` is re-callable and merges, so the manager
 * can shape the world while the interview is still running and dispatch
 * designers between turns rather than in one batch at the end; `world_status`
 * is what it reads to avoid building the same place twice. Both writers go
 * through `lore-sections.ts`, because the lore file is no longer the manager's
 * alone — the designers write into it too (see `lore-tools.ts`).
 *
 * `set_world_settings` comes before both. It is the only writer of the world's
 * ground rules — language, player name, naming and style conventions — and what
 * it stores is rendered into every design sub-agent's prompt by
 * `sdk/agent/subagent-definitions.ts`, which is what stops a Korean world from
 * growing English items.
 *
 * Beyond flipping the phase, `complete` captures the initial-state snapshot the
 * reset feature restores to — it has to be taken after the item designer has
 * run, or "reset this world" hands the player an inventory they never had.
 */

const logger = getLogger('OnboardingTools')

export interface OnboardingDeps {
  worlds: WorldService
  players: PlayerService
  locations: LocationStorage
  reset: WorldResetService
  /** Needed to place onboarding-created NPCs; without it `complete` still works. */
  agentFiles?: AgentFilesystemService
  /** Only `world_status` reads it, and it degrades to "not reported" without it. */
  items?: ItemService
}

/** The lore guidelines text, from `lore_guidelines.yaml`'s active version. */
function loadLoreGuidelines(): string {
  const config = getLoreGuidelinesConfig()
  const activeVersion = typeof config.active_version === 'string' ? config.active_version : 'v1'
  const version = config[activeVersion]
  if (typeof version !== 'object' || version === null) return ''
  const template = (version as Record<string, unknown>).template
  return typeof template === 'string' ? template : ''
}

export function createOnboardingTools(ctx: ToolContext, deps: OnboardingDeps): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const tools: SdkTool[] = []

  const settingsDef = resolveTool(setWorldSettingsTool.name, ctx.groupName)
  if (settingsDef) {
    tools.push(
      tool(
        setWorldSettingsTool.name,
        settingsDef.description,
        setWorldSettingsTool.inputSchema,
        async (args) => {
          if (
            args.language === null &&
            args.player_name === null &&
            args.naming_style === null &&
            args.style_notes === null
          ) {
            return toolError(
              'set_world_settings needs at least one of language, player_name, ' +
                'naming_style or style_notes. Call world_status to see what is registered.',
            )
          }

          try {
            // Merge, like `draft_world`: a later call fixing the naming convention
            // must not blank the language the world was created with.
            const config = deps.worlds.ensureWorldExists(worldName)
            if (args.language !== null) config.language = args.language
            if (args.player_name !== null) config.userName = args.player_name
            // Copied rather than mutated in place: the config came out of the
            // service's mtime cache, and the entry is shared with every other
            // reader until the save invalidates it.
            const settings = { ...config.settings }
            if (args.naming_style !== null) settings[NAMING_STYLE_KEY] = args.naming_style
            if (args.style_notes !== null) settings[STYLE_NOTES_KEY] = args.style_notes
            config.settings = settings
            deps.worlds.saveWorldConfig(worldName, config)

            // Echoed back verbatim: this is the same text the designers receive,
            // so the manager can see what it just committed them to.
            return toolSuccess(
              formatTemplate(settingsDef.response, {
                settings: renderWorldSettingsBrief(toWorldSettings(config)),
              }),
            )
          } catch (error) {
            logger.error(`Failed to register world settings: ${String(error)}`)
            return toolError(`Error registering world settings: ${String(error)}`)
          }
        },
      ),
    )
  }

  const loreDef = resolveTool(readLoreGuidelinesTool.name, ctx.groupName)
  if (loreDef) {
    // Read once, at build time. The file is hot-reloaded through the mtime cache
    // anyway, and a turn that reads it twice must not see two different texts.
    const guidelines = loadLoreGuidelines()
    tools.push(
      tool(
        readLoreGuidelinesTool.name,
        loreDef.description,
        readLoreGuidelinesTool.inputSchema,
        async () => toolSuccess(guidelines),
      ),
    )
  }

  const statusDef = resolveTool(worldStatusTool.name, ctx.groupName)
  if (statusDef) {
    tools.push(
      tool(
        worldStatusTool.name,
        statusDef.description,
        worldStatusTool.inputSchema,
        // Read at call time, not at build time: the point of this tool is to
        // report what the designers dispatched earlier in the turn have written.
        async () => toolSuccess(buildWorldStatus(deps, worldName)),
      ),
    )
  }

  // Gated like the others: an unconditional tool cannot be turned off from a
  // group config.
  const draftDef = resolveTool(draftWorldTool.name, ctx.groupName)
  if (draftDef) {
    tools.push(
      tool(
        draftWorldTool.name,
        draftDef.description,
        draftWorldTool.inputSchema,
        async (args) => {
          if (args.genre === null && args.theme === null && args.lore_summary === null) {
            return toolError(
              'draft_world needs at least one of genre, theme or lore_summary. ' +
                'Call world_status to see what the draft currently holds.',
            )
          }

          try {
            // Merge, not replace: a later call refining the theme must not blank
            // the genre the player settled two turns ago.
            const config = deps.worlds.ensureWorldExists(worldName)
            config.genre = args.genre ?? config.genre
            config.theme = args.theme ?? config.theme
            deps.worlds.saveWorldConfig(worldName, config)

            // The body is overwritten wholesale by `persist_world` later; it
            // exists only so designers running in the background have a world to
            // design for. Their own contributions live in a separate region and
            // survive both this write and that one.
            if (args.lore_summary !== null) {
              const sections = splitLore(deps.worlds.loadLore(worldName))
              deps.worlds.saveLore(
                worldName,
                composeLore({ ...sections, body: `# World Lore\n\n${args.lore_summary}` }),
              )
            }

            return toolSuccess(
              `World draft updated. Genre: ${config.genre ?? 'unset'}, ` +
                `Theme: ${config.theme ?? 'unset'}. ` +
                `Sub-agents can now start with this context.`,
            )
          } catch (error) {
            logger.error(`Failed to create world draft: ${String(error)}`)
            return toolError(`Error creating world draft: ${String(error)}`)
          }
        },
      ),
    )
  }

  const persistDef = resolveTool(persistWorldTool.name, ctx.groupName)
  if (persistDef) {
    tools.push(
      tool(
        persistWorldTool.name,
        persistDef.description,
        persistWorldTool.inputSchema,
        async (args) => {
          try {
            deps.worlds.ensureWorldExists(worldName)

            const stats = args.stat_system.stats
            deps.players.saveStatDefinitions(worldName, {
              stats: stats.map((stat) => ({ ...stat })),
              derived: args.stat_system.derived ?? [],
            })

            const state = deps.players.loadPlayerState(worldName)
            if (state) {
              const values: Record<string, number> = {}
              for (const stat of stats) values[stat.name] = stat.default
              // Overrides layer *over* the declared defaults rather than
              // replacing the map, so a world can start the player at half health
              // without having to restate every other stat.
              Object.assign(values, args.initial_stats ?? {})
              state.stats = values
              deps.players.savePlayerState(worldName, state)
            }

            // The draft body is replaced; the designers' lore sections and any
            // existing world notes are not the Onboarding Manager's to discard.
            const sections = splitLore(deps.worlds.loadLore(worldName))
            let notes = sections.notes
            if (args.world_notes) {
              // The model emits literal backslash-n inside a YAML-ish string
              // often enough to be worth un-escaping by hand.
              const added = args.world_notes.replaceAll('\\n', '\n')
              notes = notes ? `${notes}\n\n${added}` : added
            }

            deps.worlds.saveLore(
              worldName,
              composeLore({ ...sections, body: `# World Lore\n\n${args.lore}`, notes }),
            )

            return toolSuccess(
              `World persisted successfully. Stats: ${stats.length}, ` +
                `Lore: ${args.lore.length} characters`,
            )
          } catch (error) {
            logger.error(`Failed to persist world: ${String(error)}`)
            return toolError(`Error persisting world: ${String(error)}`)
          }
        },
      ),
    )
  }

  const completeDef = resolveTool(completeTool.name, ctx.groupName)
  if (completeDef) {
    tools.push(
      tool(
        completeTool.name,
        completeDef.description,
        completeTool.inputSchema,
        async (args) => {
          const {
            player_name: playerName,
            starting_location: startingLocation,
            starting_hour: startingHour,
          } = args

          try {
            // Checked against the *filesystem* index and by exact folder name.
            // A display name here would pass the model's own sense check and then
            // leave the player standing at a location that does not resolve.
            const fsLocations = deps.locations.loadAllLocations(worldName)
            if (!Object.hasOwn(fsLocations, startingLocation)) {
              const available = Object.keys(fsLocations)
              return toolError(
                `Starting location '${startingLocation}' not found. ` +
                  `Available locations: ${available.length > 0 ? available.join(', ') : 'none'}. ` +
                  `Make sure location_designer created this location first.`,
              )
            }

            const config = deps.worlds.ensureWorldExists(worldName)
            config.userName = playerName
            // *Pending*, not applied: the phase flips once this turn ends, so the
            // agent finishing its response is not reading a world that changed
            // underneath it mid-turn.
            config.pendingPhase = 'active'
            deps.worlds.saveWorldConfig(worldName, config)

            const playerState = deps.players.loadPlayerState(worldName)
            if (playerState) {
              playerState.currentLocation = startingLocation
              playerState.gameTime = { hour: startingHour, minute: 0, day: 1 }
              deps.players.savePlayerState(worldName, playerState)

              deps.reset.saveInitialState(
                worldName,
                WorldResetService.createInitialStateSnapshot({
                  startingLocation,
                  initialStats: playerState.stats,
                  initialInventory: playerState.inventory,
                  initialGameTime: playerState.gameTime,
                }),
              )
            }

            if (deps.agentFiles && ctx.worldId !== undefined) {
              try {
                addWorldAgentsToInitialLocation(ctx, deps.agentFiles, worldName, startingLocation)
              } catch (error) {
                logger.warning(`Failed to add agents to initial location: ${String(error)}`)
              }
            }
          } catch (error) {
            logger.error(`Failed to complete onboarding: ${String(error)}`)
            return toolError(`Error completing onboarding: ${String(error)}`)
          }

          return toolSuccess(
            formatTemplate(completeDef.response, {
              player_name: playerName,
              starting_location: startingLocation,
              starting_hour: startingHour,
            }),
          )
        },
      ),
    )
  }

  return tools
}

/**
 * A plain-text inventory of the world so far. Deliberately not a JSON dump: the
 * caller is a model deciding what to build next, and a missing section has to
 * read as "nothing here yet" rather than as an empty array it might skim past.
 * Every lookup is filesystem-first, so it also reflects a designer that finished
 * moments ago in the same turn.
 */
function buildWorldStatus(deps: OnboardingDeps, worldName: string): string {
  const lines: string[] = [`World: ${worldName}`]

  const config = deps.worlds.loadWorldConfig(worldName)
  lines.push(`Phase: ${config?.pendingPhase ?? config?.phase ?? 'onboarding'}`)
  lines.push(`Genre: ${config?.genre ?? '(not set)'}`)
  lines.push(`Theme: ${config?.theme ?? '(not set)'}`)
  lines.push(`Player name: ${config?.userName ?? '(not set — set_world_settings sets it)'}`)

  // Reported because they are what the designers are being handed: a world
  // whose language reads wrong here is producing content in that language.
  const settings = config ? toWorldSettings(config) : null
  lines.push(`Language: ${settings?.language ?? 'en'} (set_world_settings changes it)`)
  lines.push(`Naming convention: ${settings?.namingStyle ?? '(not registered)'}`)
  lines.push(`Style notes: ${settings?.styleNotes ?? '(not registered)'}`)

  const sections = splitLore(deps.worlds.loadLore(worldName))
  lines.push(`Lore body: ${sections.body.length} characters`)
  const titles = listAdditionTitles(sections.additions)
  lines.push(
    titles.length > 0
      ? `Lore sections from designers (${titles.length}): ${titles.join(', ')}`
      : 'Lore sections from designers: none yet',
  )

  // `persist_world` is the only writer of stats.json, so an empty catalog is
  // also the answer to "have I persisted the world yet".
  const stats = deps.players.loadStatDefinitions(worldName).stats ?? []
  lines.push(
    stats.length > 0
      ? `Stat system (${stats.length}): ${stats.map((stat) => stat.name).join(', ')}`
      : 'Stat system: not defined yet — persist_world writes it',
  )

  const state = deps.players.loadPlayerState(worldName)
  const locations = deps.locations.loadAllLocations(worldName)
  const locationNames = Object.keys(locations)
  lines.push(
    locationNames.length > 0
      ? `Locations (${locationNames.length}): ${locationNames
          .map((name) => {
            const display = locations[name]?.displayName ?? name
            const here = state?.currentLocation === name ? ' [starting]' : ''
            return `${name} (${display})${here}`
          })
          .join(', ')}`
      : 'Locations: none yet — dispatch location_designer',
  )

  if (deps.agentFiles) {
    const characters = deps.agentFiles.listWorldAgents(worldName)
    lines.push(
      characters.length > 0
        ? `Characters (${characters.length}): ${characters.join(', ')}`
        : 'Characters: none yet — dispatch character_designer',
    )
  }

  if (deps.items) {
    const items = deps.items.getAllItemsInWorld(worldName)
    lines.push(
      items.length > 0
        ? `Item templates (${items.length}): ${items.map((item) => item.itemId).join(', ')}`
        : 'Item templates: none yet — dispatch item_designer',
    )
  }

  return lines.join('\n')
}

/**
 * Place every NPC onboarding created at the starting location — they were
 * created against the *onboarding room*, which is an interview and not a place.
 * Per-agent failures are skipped: one unplaceable NPC must not cost the rest.
 */
function addWorldAgentsToInitialLocation(
  ctx: ToolContext,
  agentFiles: AgentFilesystemService,
  worldName: string,
  initialLocationName: string,
): number {
  const db = ctx.getDb()
  const agentNames = agentFiles.listWorldAgents(worldName)
  if (agentNames.length === 0) return 0

  const location = getLocationByName(db, ctx.worldId!, initialLocationName)
  if (!location) {
    logger.warning(`Initial location '${initialLocationName}' not found in database`)
    return 0
  }

  let added = 0
  for (const agentName of agentNames) {
    try {
      const agent = getAgentByName(db, agentName)
      if (!agent) {
        logger.warning(`Agent '${agentName}' not found in database`)
        continue
      }
      addCharacterToLocation(db, agent.id, location.id)
      added += 1
    } catch (error) {
      logger.warning(`Failed to add agent '${agentName}' to location: ${String(error)}`)
    }
  }

  logger.info(`Added ${added} agents to initial location`)
  return added
}
