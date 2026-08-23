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
} from '@/sdk/tools/onboarding'
import { resolveTool } from '@/sdk/tools/registry'
import { getLogger } from '@/infrastructure/logging/logger'
import type { AgentFilesystemService } from '@/services/agent-filesystem-service'
import { tool, requireWorldName, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * World initialisation. The three writing tools run in a fixed order, each
 * leaving the world in a state the next depends on (see `tools/onboarding.ts`).
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

/** Marker `persist_world` preserves across a lore rewrite. */
const WORLD_NOTES_MARKER = '\n\n---\n## World Notes'

export function createOnboardingTools(ctx: ToolContext, deps: OnboardingDeps): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const tools: SdkTool[] = []

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
          try {
            const config = deps.worlds.ensureWorldExists(worldName)
            config.genre = args.genre
            config.theme = args.theme
            deps.worlds.saveWorldConfig(worldName, config)

            // Overwritten wholesale by `persist_world` later; this exists only so
            // the sub-agents running in the background have a world to design for.
            deps.worlds.saveLore(worldName, `# World Lore\n\n${args.lore_summary}`)

            return toolSuccess(
              `World draft created. Genre: ${args.genre}, Theme: ${args.theme}. ` +
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

            // The draft is replaced, but anything already filed under
            // "## World Notes" survives — the notes are written by other agents
            // and are not the Onboarding Manager's to discard.
            const existingLore = deps.worlds.loadLore(worldName)
            const notesIndex = existingLore.indexOf(WORLD_NOTES_MARKER)
            let newLore =
              notesIndex === -1
                ? `# World Lore\n\n${args.lore}`
                : `# World Lore\n\n${args.lore}${existingLore.slice(notesIndex)}`

            if (args.world_notes) {
              // The model emits literal backslash-n inside a YAML-ish string
              // often enough to be worth un-escaping by hand.
              const notes = args.world_notes.replaceAll('\\n', '\n')
              newLore = `${newLore}\n\n---\n## World Notes\n${notes}`
            }

            deps.worlds.saveLore(worldName, newLore)

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
