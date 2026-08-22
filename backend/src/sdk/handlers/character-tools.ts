import { getAgentByName } from '../../crud/agents'
import {
  addCharacterToLocation,
  getAgentLocationsInWorld,
  getLocationByName,
  removeCharacterFromLocation,
} from '../../crud/locations'
import { addAgentToRoom } from '../../crud/rooms'
import { getWorld } from '../../crud/worlds'
import type { LocationStorage } from '../../services/location-storage'
import type { PlayerService } from '../../services/player-service'
import { RoomMappingService } from '../../services/room-mapping'
import { deleteCharacterTool, removeCharacterTool } from '../tools/gameplay'
import { moveCharacterTool } from '../tools/location'
import { resolveTool } from '../tools/registry'
import { persistCharacterDesignTool } from '../tools/subagent'
import { getLogger } from '../../infrastructure/logging/logger'
import type { AgentFactory } from '../../services/agent-factory'
import type { AgentFilesystemService } from '../../services/agent-filesystem-service'
import { tool, requireWorldId, requireWorldName, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * Who is in the world, where they stand, and how they leave it. Filesystem
 * first: the agent folders under `worlds/<name>/agents/` are the roster,
 * `_state.json` is the seating chart, and the database is a best-effort cache.
 * Each DB sync is caught and warned — a failed sync must not fail the tool,
 * since the filesystem write already happened and reporting failure would tell
 * the model to retry and double-apply it.
 */

const logger = getLogger('GameplayTools.Character')

export interface CharacterDeps {
  agentFiles: AgentFilesystemService
  players: PlayerService
  rooms: RoomMappingService
  locations: LocationStorage
  /** Absent during onboarding-only flows; `persist_character_design` needs it. */
  agentFactory?: AgentFactory
}

// Each of the three variants earns its place: the model writes `Old Marn`
// where the folder is `Old_Marn`, writes the folder name where a display name
// is expected, and varies the case of both.
function matchAgentFolder(folders: string[], characterName: string): string | null {
  const variants = [
    characterName,
    characterName.replaceAll(' ', '_'),
    characterName.replaceAll('_', ' '),
  ].map((v) => v.toLowerCase())

  return folders.find((folder) => variants.includes(folder.toLowerCase())) ?? null
}

/** The player's current location, with the same fallback the context uses. */
function currentLocationName(players: PlayerService, worldName: string): string {
  return players.loadPlayerState(worldName)?.currentLocation || 'unknown'
}

function joinOrNone(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none'
}

export function createCharacterTools(ctx: ToolContext, deps: CharacterDeps): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const worldId = requireWorldId(ctx)

  const tools: SdkTool[] = []

  // remove_character — leaves the world, keeps the character
  const removeDef = resolveTool(removeCharacterTool.name, ctx.groupName)
  if (removeDef) {
    tools.push(
      tool(
        removeCharacterTool.name,
        removeDef.description,
        removeCharacterTool.inputSchema,
        async (args) => {
          const characterName = args.character_name
          try {
            const folders = deps.agentFiles.listWorldAgents(worldName)
            const folder = matchAgentFolder(folders, characterName)
            if (!folder) {
              return toolError(
                `Character '${characterName}' not found.\n\nAvailable characters: ${joinOrNone(folders)}`,
              )
            }
            const displayName = folder.replaceAll('_', ' ')

            const location = currentLocationName(deps.players, worldName)
            const roomKey = RoomMappingService.locationToRoomKey(location)
            const mapping = deps.rooms.loadState(worldName).rooms[roomKey]

            if (!mapping || !mapping.agents.includes(folder)) {
              return toolSuccess(
                `Character '${displayName}' was not at the current location (${location}).`,
              )
            }

            deps.rooms.removeAgentFromRoom(worldName, roomKey, folder)

            try {
              const agent = getAgentByName(ctx.getDb(), folder, worldName)
              const locationRow = getLocationByName(ctx.getDb(), worldId, location)
              if (agent && locationRow) {
                removeCharacterFromLocation(ctx.getDb(), agent.id, locationRow.id)
              }
            } catch (error) {
              logger.warning(`DB sync failed (non-critical): ${String(error)}`)
            }

            return toolSuccess(
              `**Character Removed from Location:**\n` +
                `- Name: ${displayName}\n` +
                `- Location: ${location}\n` +
                `- Note: Character still exists in the world`,
            )
          } catch (error) {
            logger.error(`remove_character error: ${String(error)}`)
            return toolError(`Error removing character from location: ${String(error)}`)
          }
        },
      ),
    )
  }

  // delete_character — archives the folder
  const deleteDef = resolveTool(deleteCharacterTool.name, ctx.groupName)
  if (deleteDef) {
    tools.push(
      tool(
        deleteCharacterTool.name,
        deleteDef.description,
        deleteCharacterTool.inputSchema,
        async (args) => {
          const characterName = args.character_name
          const narrative = args.narrative.trim()
          // The map is keyed on `disappearance`, so the `실종` the tool
          // description advertises falls through to DEATH. Player never sees it.
          const reason =
            { death: 'death', disappearance: 'disappearance', magic: 'magic' }[
              args.reason.trim().toLowerCase()
            ] ?? 'death'

          try {
            const archived = deps.agentFiles.archiveAgent(
              worldName,
              characterName.replaceAll(' ', '_'),
            )
            if (!archived) {
              return toolSuccess(`Character '${characterName}' not found or already deleted.`)
            }

            let text = `**Character Deleted:**\n- Name: ${characterName}\n- Reason: ${reason}`
            if (narrative) text += `\n- Narrative: ${narrative}`
            return toolSuccess(text)
          } catch (error) {
            logger.error(`delete_character error: ${String(error)}`)
            return toolError(`Error deleting character: ${String(error)}`)
          }
        },
      ),
    )
  }

  // move_character — relocate an NPC
  const moveDef = resolveTool(moveCharacterTool.name, ctx.groupName)
  if (moveDef) {
    tools.push(
      tool(
        moveCharacterTool.name,
        moveDef.description,
        moveCharacterTool.inputSchema,
        async (args) => {
          const { character_name: characterName, destination } = args
          const narrative = args.narrative.trim()

          try {
            const folders = deps.agentFiles.listWorldAgents(worldName)
            const folder = matchAgentFolder(folders, characterName)
            if (!folder) {
              return toolError(
                `Character '${characterName}' not found in filesystem.\n\n` +
                  `Available characters: ${joinOrNone(folders)}`,
              )
            }
            const displayName = folder.replaceAll('_', ' ')

            const destRoomKey = deps.rooms.findLocationRoomKeyFuzzy(worldName, destination)
            if (!destRoomKey) {
              const known = Object.keys(deps.locations.loadAllLocations(worldName))
              return toolError(
                `Location '${destination}' not found.\n\nAvailable locations: ${joinOrNone(known)}`,
              )
            }
            const destLocationName = RoomMappingService.roomKeyToLocation(destRoomKey) ?? destRoomKey

            // Pulled out of every other location first: a character listed in
            // two rooms reacts twice in cell 1.
            const state = deps.rooms.loadState(worldName)
            for (const [roomKey, mapping] of Object.entries(state.rooms)) {
              if (!roomKey.startsWith('location:') || roomKey === destRoomKey) continue
              if (mapping.agents.includes(folder)) {
                deps.rooms.removeAgentFromRoom(worldName, roomKey, folder)
              }
            }
            deps.rooms.addAgentToRoom(worldName, destRoomKey, folder)

            try {
              const db = ctx.getDb()
              let agent = getAgentByName(db, folder, worldName)

              // A character can exist on disk with no row (hand-authored, or a
              // sub-agent whose DB write failed); backfill rather than fail.
              if (!agent && deps.agentFactory) {
                agent = deps.agentFactory.createFromConfig(db, {
                  name: folder,
                  configFile: `worlds/${worldName}/agents/${folder}`,
                  group: null,
                  worldName,
                }) as ReturnType<typeof getAgentByName>
              }

              const destLocation = getLocationByName(db, worldId, destLocationName)
              if (agent && destLocation) {
                for (const old of getAgentLocationsInWorld(db, agent.id, worldId)) {
                  if (old.id !== destLocation.id) removeCharacterFromLocation(db, agent.id, old.id)
                }
                addCharacterToLocation(db, agent.id, destLocation.id)
                if (destLocation.roomId) addAgentToRoom(db, destLocation.roomId, agent.id)
              }
            } catch (error) {
              logger.warning(`DB sync failed (non-critical): ${String(error)}`)
            }

            let text = `**Character Moved:**\n- Name: ${displayName}\n- Destination: ${destLocationName}`
            if (narrative) text += `\n- Narrative: ${narrative}`
            return toolSuccess(text)
          } catch (error) {
            logger.error(`move_character error: ${String(error)}`)
            return toolError(`Error moving character: ${String(error)}`)
          }
        },
      ),
    )
  }

  return tools
}

// A separate factory because the tool belongs to the `subagents` MCP server.
export function createPersistCharacterTool(
  ctx: ToolContext,
  deps: CharacterDeps,
): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const worldId = requireWorldId(ctx)

  const def = resolveTool(persistCharacterDesignTool.name, ctx.groupName)
  if (!def || !deps.agentFactory) return []
  const agentFactory = deps.agentFactory

  return [
    tool(
      persistCharacterDesignTool.name,
      def.description,
      persistCharacterDesignTool.inputSchema,
      async (args) => {
        try {
          const db = ctx.getDb()
          const agentName = args.name.replaceAll(' ', '_')

          // Appearance stays out of `in_a_nutshell.md`: that file is injected
          // into every other character's context on every turn.
          const inANutshell = `${args.name} is a ${args.role}.`
          let characteristics = `## Role\n${args.role}\n\n## Appearance\n${args.appearance}\n\n## Personality\n${args.personality}\n\n## Initial Disposition\n${args.initial_disposition}`
          if (args.secret) characteristics += `\n\n## Hidden Detail\n${args.secret}`

          deps.agentFiles.createAgent(worldName, agentName, inANutshell, characteristics)

          const whichLocation = args.which_location || 'current'
          const isCurrent = whichLocation.toLowerCase() === 'current'
          const currentLocation = currentLocationName(deps.players, worldName)

          let locationDisplay = 'current location'
          let targetLocation = isCurrent ? null : getLocationByName(db, worldId, whichLocation)

          if (!isCurrent && targetLocation) {
            const roomKey = RoomMappingService.locationToRoomKey(targetLocation.name)
            if (targetLocation.roomId) {
              deps.rooms.ensureRoomMappingExists(worldName, roomKey, targetLocation.roomId, [])
            }
            deps.rooms.addAgentToRoom(worldName, roomKey, agentName)
            locationDisplay = targetLocation.displayName || targetLocation.name
          } else {
            targetLocation = null
            deps.rooms.addAgentToRoom(
              worldName,
              RoomMappingService.locationToRoomKey(currentLocation),
              agentName,
            )
          }

          const newAgent = agentFactory.createFromConfig(db, {
            name: agentName,
            configFile: `worlds/${worldName}/agents/${agentName}`,
            group: null,
          })

          if (isCurrent) {
            // During onboarding "current" is the interview room, not a place;
            // `complete` places them at the starting location instead.
            const world = ctx.worldId === undefined ? null : getWorld(db, ctx.worldId)
            const isOnboardingRoom =
              world !== null && ctx.roomId !== undefined && world.onboardingRoomId === ctx.roomId
            if (!isOnboardingRoom && ctx.roomId !== undefined) {
              addAgentToRoom(db, ctx.roomId, newAgent.id)
            }
          } else if (targetLocation) {
            addCharacterToLocation(db, newAgent.id, targetLocation.id)
          }

          return toolSuccess(
            `**Character Created:**\n` +
              `- Name: ${args.name}\n` +
              `- Role: ${args.role}\n` +
              `- Location: ${locationDisplay}\n` +
              `- Disposition: ${args.initial_disposition}`,
          )
        } catch (error) {
          logger.error(`persist_character_design error: ${String(error)}`)
          return toolError(`Error creating character: ${String(error)}`)
        }
      },
    ),
  ]
}
