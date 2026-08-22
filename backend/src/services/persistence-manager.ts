// The bridge between a world on disk and a world in the database, for the few
// operations that cannot live on one side. Not a general write path: a runtime
// mutation added here would gain a second source of truth.

import { getSettings } from '../config/settings'
import { getAgentByName } from '../crud/agents'
import { createLocation, getLocations, type LocationCreate } from '../crud/locations'
import {
  addInventoryItem,
  getPlayerState,
  initializePlayerStats,
  setCurrentLocation,
} from '../crud/player-state'
import { addAgentToRoom } from '../crud/rooms'
import { updateWorld } from '../crud/worlds'
import type { Db } from '../db'
import type { Location, WorldPhase } from '../db/schema'
import type { InventoryEntry } from '../domain/player-rules'
// `worlds.stat_definitions`; StatDefinitionsFile is the whole `stats.json`.
import type { StatDefinitions as StatDefinitionBlob } from '../domain/player-rules'
import { getLogger } from '../infrastructure/logging/logger'
import { LocationStorage } from './location-storage'
import {
  DEFAULT_GAME_TIME,
  PlayerService,
  type PlayerState,
  type StatDefinitions as StatDefinitionsFile,
} from './player-service'
import { RoomMappingService } from './room-mapping'
import { MtimeCache, WorldService } from './world-service'

const logger = getLogger('PersistenceManager')

export type Position = [number, number]

export interface CreateLocationInput {
  /** Directory name, and the key every other layer refers to the place by. */
  name: string
  displayName: string
  description: string
  position: Position
  /** Neighbour *names*, written to the filesystem index only. */
  adjacentHints?: string[] | null
  isStarting?: boolean
  agents?: string[] | null
}

// The value is passed as `default` *and* as the initial value: without the
// definition entry the stat is never initialised at all.
function statDefinitionsFrom(stats: Record<string, number>): StatDefinitionBlob {
  return { stats: Object.entries(stats).map(([name, value]) => ({ name, default: value })) }
}

function blankPlayerState(): PlayerState {
  return {
    currentLocation: null,
    turnCount: 0,
    stats: {},
    inventory: [],
    effects: [],
    recentActions: [],
    // Must not be empty: the writer dumps it into `player.json`, and every
    // reader of that file expects a clock.
    gameTime: { ...DEFAULT_GAME_TIME },
    equipment: {},
    flags: {},
  }
}

export class PersistenceManager {
  private readonly worlds: WorldService
  private readonly players: PlayerService
  private readonly locations: LocationStorage
  private readonly rooms: RoomMappingService

  // `worldId` addresses the database half, `worldName` the filesystem half.
  constructor(
    private readonly db: Db,
    private readonly worldId: number,
    private readonly worldName: string,
    worldsDir: string = getSettings().paths.worldsDir,
  ) {
    // One cache across all three, so a write through any one is visible to the
    // others' next read.
    const cache = new MtimeCache()
    this.worlds = new WorldService(worldsDir, cache)
    this.players = new PlayerService(worldsDir, cache)
    this.locations = new LocationStorage(worldsDir, cache)
    this.rooms = new RoomMappingService(worldsDir)
  }

  /**
   * Create a location on both sides. Order is load-bearing: filesystem first
   * (source of truth), room mapping last (needs the allocated `room_id`).
   * `adjacentHints` reaches the filesystem only — the column takes ids, and the
   * caller calls `addAdjacentLocation` once both ends exist.
   */
  createLocation(input: CreateLocationInput): number {
    this.locations.createLocation(
      this.worldName,
      input.name,
      input.displayName,
      input.description,
      input.position,
      input.adjacentHints ?? [],
    )
    logger.info(`Created location '${input.name}' in filesystem`)

    const locationCreate: LocationCreate = {
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      positionX: input.position[0],
      positionY: input.position[1],
      adjacentTo: null,
      isDiscovered: true,
    }
    const dbLocation = createLocation(this.db, this.worldId, locationCreate)
    logger.info(
      `Created location '${input.name}' in database (id=${dbLocation.id}, ` +
        `room_id=${String(dbLocation.roomId)})`,
    )

    const roomKey = RoomMappingService.locationToRoomKey(input.name)

    if (dbLocation.roomId) {
      this.rooms.setRoomMapping(this.worldName, roomKey, dbLocation.roomId, input.agents ?? [])
      logger.info(`Stored room mapping: ${roomKey} -> room_id=${dbLocation.roomId}`)
    }

    if (input.isStarting) {
      // The agents go in the mapping but not the database room: this path runs
      // during onboarding, before the characters have rows to add.
      setCurrentLocation(this.db, this.worldId, dbLocation.id)
      this.rooms.setCurrentRoom(this.worldName, roomKey)
      logger.info(`Set '${input.name}' as current location and room`)
    }

    return dbLocation.id
  }

  /**
   * Copy `player.json` into the database: the onboarding→active handover, and
   * polling's repair path. Empty sections are skipped rather than written as
   * empty, so this cannot wipe what the database has and the file does not.
   */
  syncPlayerStateFromFilesystem(): void {
    const fsState = this.players.loadPlayerState(this.worldName)
    if (!fsState) {
      logger.warning(`No player state found in filesystem for world '${this.worldName}'`)
      return
    }

    if (!getPlayerState(this.db, this.worldId)) {
      logger.warning(`No player state found in database for world_id=${this.worldId}`)
      return
    }

    const statNames = Object.keys(fsState.stats)
    if (statNames.length > 0) {
      initializePlayerStats(
        this.db,
        this.worldId,
        statDefinitionsFrom(fsState.stats),
        fsState.stats,
      )
      logger.info(`Synced ${statNames.length} stats to database`)
    }

    if (fsState.inventory.length > 0) {
      for (const item of fsState.inventory) {
        addInventoryItem(this.db, this.worldId, {
          // `player.json` stores the *reference* format, so name/description
          // are usually empty — the `items/` template holds them, unresolved here.
          id: String(item.item_id ?? item.id ?? ''),
          name: String(item.name ?? ''),
          description: item.description ?? '',
          quantity: item.quantity ?? 1,
          properties: item.properties ?? null,
        })
      }
      logger.info(`Synced ${fsState.inventory.length} inventory items to database`)
    }

    if (fsState.currentLocation) {
      const locations = getLocations(this.db, this.worldId)
      const location =
        locations.find((candidate) => candidate.name === fsState.currentLocation) ??
        this.createLocationFromFilesystem(fsState.currentLocation)

      if (location) {
        setCurrentLocation(this.db, this.worldId, location.id)
        logger.info(
          `Synced current_location to '${fsState.currentLocation}' (id=${location.id})`,
        )
      } else {
        logger.warning(
          `Could not create location '${fsState.currentLocation}' from filesystem`,
        )
      }
    }
  }

  /**
   * Materialise a database row for a location that only exists on disk. The new
   * `room_id` must be written back *with the existing agent list intact*, or the
   * characters in the starting location vanish once the world goes active.
   */
  private createLocationFromFilesystem(locationName: string): Location | null {
    try {
      const locConfig = this.locations.loadLocation(this.worldName, locationName)
      if (!locConfig) {
        logger.warning(`Location '${locationName}' not found in filesystem`)
        return null
      }

      const roomKey = RoomMappingService.locationToRoomKey(locationName)
      const existingAgents = this.rooms.getRoomMapping(this.worldName, roomKey)?.agents ?? []

      const dbLocation = createLocation(this.db, this.worldId, {
        name: locationName,
        displayName: locConfig.displayName,
        description: locConfig.description,
        positionX: locConfig.position[0],
        positionY: locConfig.position[1],
        adjacentTo: null,
        isDiscovered: locConfig.isDiscovered,
        // Keeps a not-yet-enriched location flagged as a draft on both sides.
        isDraft: locConfig.isDraft,
      })
      logger.info(`Created location '${locationName}' in database (id=${dbLocation.id})`)

      if (dbLocation.roomId) {
        this.rooms.setRoomMapping(this.worldName, roomKey, dbLocation.roomId, existingAgents)
        logger.info(`Stored room mapping: ${roomKey} -> room_id=${dbLocation.roomId}`)

        if (existingAgents.length > 0) {
          const added = this.addAgentsToRoom(dbLocation.roomId, existingAgents)
          logger.info(`Added ${added} character agents to room ${dbLocation.roomId}`)
        }
      }

      return dbLocation
    } catch (error) {
      logger.error(
        `Failed to create location '${locationName}' from filesystem: ${String(error)}`,
      )
      return null
    }
  }

  /**
   * Add agents to a room by name. The lookup is deliberately *not* scoped to
   * this world: narrowing it would change which agent ids land in `room_agents`
   * for existing databases where two worlds share a character name.
   */
  private addAgentsToRoom(roomId: number, agentNames: string[]): number {
    let added = 0
    for (const agentName of agentNames) {
      const agent = getAgentByName(this.db, agentName)
      if (!agent) {
        logger.warning(`Agent '${agentName}' not found in world '${this.worldName}'`)
        continue
      }
      addAgentToRoom(this.db, roomId, agent.id)
      added += 1
      logger.debug(`Added agent '${agentName}' to room ${roomId}`)
    }
    return added
  }

  // The same document goes to both sides, so the column holds `derived` too —
  // ignored by the clamping rules, returned by the API.
  saveStatDefinitions(statDefinitions: StatDefinitionsFile): void {
    this.players.saveStatDefinitions(this.worldName, statDefinitions)
    logger.info(`Saved stat definitions to filesystem for world '${this.worldName}'`)

    updateWorld(this.db, this.worldId, { statDefinitions: { ...statDefinitions } })
    logger.info(`Saved stat definitions to database for world_id=${this.worldId}`)
  }

  /**
   * Move the world to a new phase on both sides immediately; the deferred
   * variant is `WorldService.applyPendingPhase`. An unreadable `world.json`
   * still gets its row updated, or the player is stranded in onboarding.
   */
  updateWorldPhase(phase: WorldPhase): void {
    const config = this.worlds.loadWorldConfig(this.worldName)
    if (config) {
      config.phase = phase
      this.worlds.saveWorldConfig(this.worldName, config)
      logger.info(`Set phase='${phase}' in filesystem`)
    } else {
      logger.warning(
        `Could not load world config for '${this.worldName}' to update phase`,
      )
    }

    updateWorld(this.db, this.worldId, { phase })
    logger.info(`Set phase='${phase}' in database`)
  }

  /** Replace the database stat block from a `{name: value}` map. */
  syncStats(stats: Record<string, number>): void {
    initializePlayerStats(this.db, this.worldId, statDefinitionsFrom(stats), stats)
    logger.info(`Synced ${Object.keys(stats).length} stats to database`)
  }

  /**
   * Write the live database state back over the world's files, for backups and
   * portable exports. `effects`, `recent_actions`, `game_time`, `equipment` and
   * `flags` have no column and round-trip through the existing `player.json` —
   * exporting into a world missing that file silently resets the clock to day 1.
   * Locations export discovery status only.
   */
  exportStateToFilesystem(): void {
    const playerState = getPlayerState(this.db, this.worldId)
    const locations = getLocations(this.db, this.worldId)

    if (!playerState) {
      logger.warning(`No player state to export for world_id=${this.worldId}`)
      return
    }

    const fsState = this.players.loadPlayerState(this.worldName) ?? blankPlayerState()

    fsState.turnCount = playerState.turnCount ?? 0

    // Bare `JSON.parse` on purpose: a corrupt blob aborts the export rather
    // than overwriting a good `player.json` with nothing.
    if (playerState.stats) {
      fsState.stats = JSON.parse(playerState.stats) as Record<string, number>
    }
    if (playerState.inventory) {
      fsState.inventory = JSON.parse(playerState.inventory) as InventoryEntry[]
    }

    if (playerState.currentLocation) {
      fsState.currentLocation = playerState.currentLocation.name
    }

    this.players.savePlayerState(this.worldName, fsState)
    logger.info(`Exported player state to filesystem for world '${this.worldName}'`)

    for (const location of locations) {
      const locConfig = this.locations.loadLocation(this.worldName, location.name)
      if (!locConfig) continue
      // Only when discovery differs, so a backup does not rewrite every entry.
      if (locConfig.isDiscovered === Boolean(location.isDiscovered)) continue

      this.locations.updateLocation(this.worldName, location.name, {
        isDiscovered: location.isDiscovered,
        // `null` means "leave alone" to the writer.
        label: location.label,
      })
    }

    logger.info(`Exported ${locations.length} locations to filesystem`)
  }
}
