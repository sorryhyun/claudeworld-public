import { getAgentByName } from '../../crud/agents'
import {
  addAdjacentLocation,
  createNewRoomForLocation,
  getLocationByName,
  getLocations,
  moveCharacterToLocation,
} from '../../crud/locations'
import { createMessage } from '../../crud/messages'
import { getPlayerState, setCurrentLocation } from '../../crud/player-state'
import type { LocationStorage } from '../../services/location-storage'
import type { PlayerService } from '../../services/player-service'
import { RoomMappingService } from '../../services/room-mapping'
import type { WorldService } from '../../services/world-service'
import { travelTool } from '../tools/location'
import { resolveTool } from '../tools/registry'
import { persistLocationDesignTool } from '../tools/subagent'
import { getLogger } from '../../infrastructure/logging/logger'
import type { LocationPersistenceFactory, TurnStatusPort } from './ports'
import { tool, requireAgentId, requireRoomId, requireWorldId, requireWorldName, toolError, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * Moving the player, and creating somewhere to move them to.
 * Port of `sdk/handlers/location_tools.py`.
 *
 * `list_locations` is not here — Phase 0 put it in `world-tools.ts`.
 *
 * **`travel` is the widest side effect in the game.** One call ends the scene,
 * writes its summary to world history, gives the departing NPCs a memory round,
 * opens a *new room* at the destination, moves the player and their companions,
 * writes the arrival narration into that new room, saves the next turn's
 * suggested actions and parks a continuity payload for the following turn. It
 * is one tool rather than six because every one of those has to happen, in that
 * order, or the player arrives somewhere with no narration and no way to act.
 */

const logger = getLogger('GameplayTools.Location')

export interface LocationToolDeps {
  players: PlayerService
  rooms: RoomMappingService
  locations: LocationStorage
  worlds: WorldService
  status?: TurnStatusPort
  /** Required by `persist_location_design`; absent means the tool is not offered. */
  persistence?: LocationPersistenceFactory
}

export function createLocationTools(ctx: ToolContext, deps: LocationToolDeps): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const worldId = requireWorldId(ctx)

  const def = resolveTool(travelTool.name, ctx.groupName)
  if (!def) return []

  const travel = tool(
    travelTool.name,
    def.description,
    travelTool.inputSchema,
    async (args) => {
      const {
        destination,
        bring_characters: bringCharacters,
        narration,
        action_1: action1,
        action_2: action2,
        chat_summary: chatSummary,
        user_action: userAction,
      } = args

      const db = ctx.getDb()
      // Held across the whole call so the `finally` can clear the indicator on
      // the *departure* room, which is the room the player is still watching.
      let departureRoomId: number | null = null

      try {
        const fromLocationName = deps.players.loadPlayerState(worldName)?.currentLocation || 'unknown'
        const fromLocation =
          fromLocationName === 'unknown' ? null : getLocationByName(db, worldId, fromLocationName)

        if (fromLocation?.roomId) {
          departureRoomId = fromLocation.roomId
          deps.status?.setSubAgentActive?.(
            departureRoomId,
            'Travel',
            `Traveling to ${destination}...`,
          )
        }

        if (fromLocationName !== 'unknown') {
          try {
            const config = deps.locations.loadLocation(worldName, fromLocationName)
            const fromDisplay = config?.displayName ?? fromLocationName
            // The database's turn count, not the filesystem's: `incrementTurn`
            // writes the row and `player.yaml` may not have caught up yet, so
            // reading the file here numbers the history entry one turn behind.
            const turn = getPlayerState(db, worldId)?.turnCount ?? 0
            deps.worlds.addHistoryEntry(worldName, turn, fromDisplay, chatSummary)
          } catch (error) {
            logger.warning(`Failed to save chat summary to history: ${String(error)}`)
          }

          try {
            if (fromLocation) {
              const count = (await deps.status?.triggerNpcMemoryRound?.(fromLocation.id)) ?? 0
              if (count > 0) logger.info(`Memory round complete: ${count} NPCs processed`)
            }
          } catch (error) {
            logger.warning(`Failed to trigger memory round: ${String(error)}`)
          }
        }

        const dbLocations = getLocations(db, worldId)
        const destinationLower = destination.toLowerCase()
        // Folder name only, and substring-tolerant — Python matches
        // `loc.name.lower() == dest or dest in loc.name.lower()`, deliberately
        // *not* consulting display names. `getLocationByName` would be a wider
        // net; using it here would let the model travel to a location whose
        // folder does not exist, and the room key is built from the folder name.
        const match = dbLocations.find(
          (loc) =>
            loc.name.toLowerCase() === destinationLower ||
            loc.name.toLowerCase().includes(destinationLower),
        )

        if (!match) {
          return toolError(
            `Location '${destination}' does not exist. Use Task tool with location_designer ` +
              `to create it first.\n\nAvailable locations: ${
                dbLocations.length > 0 ? dbLocations.map((l) => l.name).join(', ') : 'none'
              }`,
          )
        }

        // A *fresh* room per visit, not the location's existing one. That is what
        // gives the arrival a clean conversation history: the room is the context
        // window, so revisiting a tavern must not replay the last visit's
        // dialogue at the model.
        const newRoom = createNewRoomForLocation(db, match)
        deps.rooms.setRoomMapping(
          worldName,
          RoomMappingService.locationToRoomKey(match.name),
          newRoom.id,
          [],
        )

        deps.status?.preConnectLocation?.(newRoom.id, match.id)

        setCurrentLocation(db, worldId, match.id)

        const fsState = deps.players.loadPlayerState(worldName)
        if (fsState) {
          fsState.currentLocation = match.name
          deps.players.savePlayerState(worldName, fsState)
        }

        const movedCharacters: string[] = []
        for (const charName of bringCharacters) {
          try {
            // Looked up world-wide, matching Python's `get_agent_by_name(db, name)`
            // with no world filter — a companion may have been created before the
            // world scoping existed.
            const agent = getAgentByName(db, charName)
            if (agent) {
              moveCharacterToLocation(db, agent.id, fromLocation?.id ?? null, match.id)
              movedCharacters.push(charName)
            } else {
              logger.warning(`Character '${charName}' not found, skipping`)
            }
          } catch (error) {
            logger.warning(`Failed to move character '${charName}': ${String(error)}`)
          }
        }

        try {
          createMessage(db, newRoom.id, {
            content: narration,
            role: 'assistant',
            agentId: requireAgentId(ctx),
          })
        } catch (error) {
          logger.error(`Failed to create travel narration: ${String(error)}`)
        }

        try {
          deps.rooms.saveSuggestions(worldName, [action1, action2])
        } catch (error) {
          logger.error(`Failed to save travel suggestions: ${String(error)}`)
        }

        try {
          deps.rooms.saveArrivalContext(worldName, {
            previousNarration: narration,
            triggeringAction: userAction,
            fromLocation: fromLocationName,
          })
        } catch (error) {
          logger.error(`Failed to save arrival context: ${String(error)}`)
        }

        let text = `**Traveled to:** ${match.name}\n- Position: (${match.positionX}, ${match.positionY})`
        if (movedCharacters.length > 0) {
          text += `\n- Companions: ${movedCharacters.join(', ')}`
        }
        text += '\n\n Narrative message created and displayed to player.'
        text += `\n Suggested actions: [${action1}] / [${action2}]`
        text += '\n Chat summary saved to world history.'
        text += '\n Arrival context saved for next action continuity.'

        return toolSuccess(text)
      } catch (error) {
        logger.error(`travel error: ${String(error)}`)
        return toolError(`Error during travel: ${String(error)}`)
      } finally {
        if (departureRoomId !== null) deps.status?.setSubAgentInactive?.(departureRoomId)
      }
    },
  )

  // `requireRoomId` is called for its check only: `travel` writes its narration
  // into the *new* room, but a context with no room at all has no departure
  // scene to summarise and should never have been offered the tool.
  requireRoomId(ctx)

  return [travel]
}

/**
 * `persist_location_design` — the Location Designer sub-agent's callback.
 *
 * Refuses to overwrite. A designer that re-runs and clobbers a location the
 * player has already visited would silently rewrite the map under them, so an
 * existing name is an error the sub-agent has to work around by picking another.
 */
export function createPersistLocationTool(
  ctx: ToolContext,
  deps: LocationToolDeps,
): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const worldId = requireWorldId(ctx)

  const def = resolveTool(persistLocationDesignTool.name, ctx.groupName)
  if (!def || !deps.persistence) return []
  const persistenceFor = deps.persistence

  return [
    tool(
      persistLocationDesignTool.name,
      def.description,
      persistLocationDesignTool.inputSchema,
      async (args) => {
        try {
          const db = ctx.getDb()
          const dbLocations = getLocations(db, worldId)
          const nameLower = args.name.toLowerCase()

          const existing = dbLocations.find(
            (loc) =>
              loc.name.toLowerCase() === nameLower ||
              (loc.displayName !== null && loc.displayName.toLowerCase() === nameLower),
          )
          if (existing) {
            return toolError(`Location '${args.name}' already exists. Cannot overwrite.`)
          }

          const adjacentHints = args.adjacent_to ?? []

          const newLocationId = persistenceFor(db, worldId, worldName).createLocation({
            name: args.name,
            displayName: args.display_name,
            description: args.description,
            position: [args.position_x, args.position_y],
            adjacentHints,
            isStarting: args.is_starting,
          })

          // Adjacency is bidirectional and written from the pre-creation
          // snapshot, so a hint naming the location being created cannot link it
          // to itself.
          for (const adjacentName of adjacentHints) {
            const adjacent = dbLocations.find((loc) => loc.name === adjacentName)
            if (!adjacent) continue
            addAdjacentLocation(db, newLocationId, adjacent.id)
            addAdjacentLocation(db, adjacent.id, newLocationId)
          }

          // `is_starting` is informational during onboarding; the real starting
          // location is whatever `complete` is told, which is why this only logs.
          if (args.is_starting) {
            logger.info(`Location '${args.name}' marked as starting location candidate`)
          }

          return toolSuccess(
            `**Location Created:**\n` +
              `- Name: ${args.name}\n` +
              `- Position: (${args.position_x}, ${args.position_y})\n` +
              `- Is Starting: ${args.is_starting ? 'True' : 'False'}\n` +
              `- Description: ${args.description.slice(0, 200)}...`,
          )
        } catch (error) {
          logger.error(`persist_location_design error: ${String(error)}`)
          return toolError(`Error creating location: ${String(error)}`)
        }
      },
    ),
  ]
}
