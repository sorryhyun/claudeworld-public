/**
 * The bridge between a world on disk and a world in the database.
 *
 * Ported from `backend/services/persistence_manager.py`.
 *
 * Almost nothing in ClaudeWorld needs both halves at once: gameplay mutations
 * (stats, inventory, travel) go straight through `crud/` to the database, and
 * world authoring goes straight to `worlds/{name}/`. This class exists for the
 * handful of operations that genuinely cannot live on one side —
 *
 * - **creating a location**, which needs a directory, an index row, a `locations`
 *   row, the `rooms` row that carries its transcript, and the `_state.json`
 *   mapping tying the last two together;
 * - **the onboarding → active handover**, where the World Seed Generator has
 *   written a complete world to disk and the database has nothing but an empty
 *   player state;
 * - **exporting** the live database back over the files, so a world stays
 *   portable.
 *
 * It is *not* a general write path. Adding a runtime mutation here would give
 * that mutation two sources of truth to disagree about.
 *
 * Every method is synchronous. `bun:sqlite` and `node:fs` both run to
 * completion, so Python's `async` here bought ordering guarantees that are
 * unconditional in this port.
 */

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
/**
 * The database-side stat definition blob: `{stats: [{name, min, max, default}]}`
 * as stored in `worlds.stat_definitions` and consumed by the clamping rules.
 * Distinct from {@link StatDefinitionsFile}, which is the whole `stats.yaml`
 * document and additionally carries `derived`. Python has one untyped dict for
 * both, which is why the two shapes are easy to confuse.
 */
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

/** `[x, y]` on the world map grid. */
export type Position = [number, number]

/** Arguments of `PersistenceManager.create_location` (`persistence_manager.py:57`). */
export interface CreateLocationInput {
  /** Directory name, and the key every other layer refers to the place by. */
  name: string
  displayName: string
  description: string
  position: Position
  /** Neighbour *names*, written to the filesystem index only — see below. */
  adjacentHints?: string[] | null
  /** Make this the player's current location and the world's current room. */
  isStarting?: boolean
  /** Agent names to record in the room mapping. */
  agents?: string[] | null
}

/**
 * Turn `{name: value}` into the `stat_definitions` shape
 * `initializePlayerStats` expects.
 *
 * The current value is passed as each stat's `default` *and* separately as the
 * initial value, which looks redundant but is not: without the definition entry
 * the stat would not be initialised at all, and without the override the
 * definition's default is what would land. Python builds the same throwaway
 * dict at both call sites (`persistence_manager.py:161`, `:326`).
 */
function statDefinitionsFrom(stats: Record<string, number>): StatDefinitionBlob {
  return { stats: Object.entries(stats).map(([name, value]) => ({ name, default: value })) }
}

/** A `PlayerState` for a world whose `player.yaml` could not be read. */
function blankPlayerState(): PlayerState {
  return {
    currentLocation: null,
    turnCount: 0,
    stats: {},
    inventory: [],
    effects: [],
    recentActions: [],
    // Python constructs `PlayerState(...)` without these three, taking the
    // dataclass defaults (`world_models.py:40-48`) rather than leaving them
    // unset. `game_time` in particular must not be empty: the writer dumps it
    // straight into `player.yaml` and every reader of that file expects a clock.
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

  /**
   * @param db Open database handle.
   * @param worldId Primary key of the world's row.
   * @param worldName Directory name of the world under `worlds/`. Python keeps
   *   both for the same reason: the row id addresses the database half and the
   *   name addresses the filesystem half, and neither derives from the other
   *   cheaply.
   * @param worldsDir Root of the `worlds/` tree; an argument rather than a
   *   settings lookup so the whole class is testable against a temp directory.
   */
  constructor(
    private readonly db: Db,
    private readonly worldId: number,
    private readonly worldName: string,
    worldsDir: string = getSettings().paths.worldsDir,
  ) {
    // One cache across the three filesystem services, so a write through any of
    // them is visible to the others' next read without a second stat.
    const cache = new MtimeCache()
    this.worlds = new WorldService(worldsDir, cache)
    this.players = new PlayerService(worldsDir, cache)
    this.locations = new LocationStorage(worldsDir, cache)
    this.rooms = new RoomMappingService(worldsDir)
  }

  // ==========================================================================
  // Filesystem → Database
  // ==========================================================================

  /**
   * Create a location on both sides and return its database id.
   *
   * Order is load-bearing: the filesystem is written first because it is the
   * source of truth, and the room mapping is written last because it needs the
   * `room_id` that `createLocation` allocated.
   *
   * **`adjacentHints` reaches the filesystem only.** The database column takes
   * location *ids* and the neighbours may not exist yet at seeding time, so
   * Python passes `adjacent_to=None` here (`persistence_manager.py:99`) and
   * leaves the caller to call `addAdjacentLocation` once both ends exist —
   * which `location_tools.py:456-461` does. Passing the names through would
   * store a JSON array of strings in a column every reader parses as ids.
   */
  createLocation(input: CreateLocationInput): number {
    this.locations.createLocation(
      this.worldName,
      input.name,
      input.displayName,
      input.description,
      input.position,
      // Python forwards `None` through to `adjacent`, which lands in the index
      // as `adjacent: null`; the TS writer's parameter is a list and writes
      // `[]`. Both read back as "no neighbours" — `parseAdjacent` and Python's
      // `loc_data.get("adjacent", [])` each yield an empty list — and every
      // caller in the tree already passes a list.
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
      // Note the mapping above records `input.agents` but does *not* add them to
      // the database room, where `_createLocationFromFilesystem` does. The
      // asymmetry is Python's: this path is called during onboarding, before the
      // characters have rows to add.
      //
      // The return value is discarded, as in Python: a world with no player
      // state row is a world that was never created properly, and there is
      // nothing useful to do about it here.
      setCurrentLocation(this.db, this.worldId, dbLocation.id)
      this.rooms.setCurrentRoom(this.worldName, roomKey)
      logger.info(`Set '${input.name}' as current location and room`)
    }

    return dbLocation.id
  }

  /**
   * Copy `player.yaml` into the database.
   *
   * This is the onboarding→active handover, and it is also the repair path the
   * polling endpoint runs when it finds an active world whose player state has
   * no `current_location_id` (`polling.py:106-114`) — i.e. when onboarding
   * finished by writing files and nothing ever mirrored them.
   *
   * Each of the three sections is skipped when empty rather than written as
   * empty, so running this against a world that is already in sync cannot wipe
   * anything the database has and the file does not.
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
          // `player.yaml` stores the *reference* format — `{item_id, quantity,
          // instance_properties}` — so for a modern world `name` and
          // `description` are empty here and `properties` is undefined, because
          // the reference keeps them in the template under `items/` and this
          // read never resolves it. The database inventory therefore ends up
          // holding nameless stacks until something rewrites it. Python does
          // exactly this (`persistence_manager.py:169-179`), and using
          // `getResolvedInventory` instead would put names in the column that
          // the Python backend never writes.
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
   * Materialise a database row for a location that only exists on disk.
   *
   * The subtle part is the room mapping. Onboarding writes character names into
   * `_state.json` for a location that has no database room yet; creating the row
   * allocates one, and that new `room_id` must be written back *with the
   * existing agent list intact* or the characters standing in the starting
   * location vanish from it the moment the world goes active.
   *
   * Returns `null` on any failure — a world with one unmaterialisable location
   * must still open.
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
        // Carried over so a location the Location Designer has not enriched yet
        // is still flagged as a draft on the database side.
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
   * Add agents to a room by name, returning how many resolved.
   *
   * **The name lookup is not scoped to this world.** Python passes no
   * `world_name` (`persistence_manager.py:246`), so a character whose name also
   * exists in another world — or as a system agent — can resolve to that other
   * row and be added to this world's room. The log line even claims the world
   * it did not search. Reproduced as written: narrowing it would change which
   * agent ids land in `room_agents` for any existing database where two worlds
   * share a character name.
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

  /**
   * Write the world's stat definitions to `stats.yaml` and to the row.
   *
   * The same document goes to both sides, so the column holds `derived` as well
   * as `stats` — which the clamping rules ignore, but the API returns. Python
   * passes one dict to both writers (`persistence_manager.py:265-278`).
   */
  saveStatDefinitions(statDefinitions: StatDefinitionsFile): void {
    this.players.saveStatDefinitions(this.worldName, statDefinitions)
    logger.info(`Saved stat definitions to filesystem for world '${this.worldName}'`)

    updateWorld(this.db, this.worldId, { statDefinitions: { ...statDefinitions } })
    logger.info(`Saved stat definitions to database for world_id=${this.worldId}`)
  }

  /**
   * Move the world to a new phase on both sides.
   *
   * This is the *immediate* change. The deferred one — `pending_phase`, set by
   * the `complete` tool so the Onboarding Manager's tool set does not change
   * mid-turn — is `WorldService.applyPendingPhase` and does not touch the
   * database at all.
   *
   * A world whose `world.yaml` will not load still gets its row updated, with a
   * warning: the phase is what the API reports, and refusing to advance it
   * would strand the player in onboarding over an unreadable file.
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

  /**
   * Replace the database stat block from a `{name: value}` map.
   *
   * Distinct from {@link syncPlayerStateFromFilesystem} only in taking the stats
   * directly instead of reading `player.yaml`; the seed generator already holds
   * them in memory when it calls this.
   */
  syncStats(stats: Record<string, number>): void {
    initializePlayerStats(this.db, this.worldId, statDefinitionsFrom(stats), stats)
    logger.info(`Synced ${Object.keys(stats).length} stats to database`)
  }

  // ==========================================================================
  // Database → Filesystem
  // ==========================================================================

  /**
   * Write the live database state back over the world's files.
   *
   * The direction every other method here runs in reverse, for backups and
   * portable exports. Note what it does *not* export: `effects`,
   * `recent_actions`, `game_time`, `equipment` and `flags` are read from the
   * existing `player.yaml` and written back untouched, because the database has
   * no column for them — so exporting into a world whose `player.yaml` is
   * missing silently resets the clock to day 1, 08:00. Python has the same hole
   * (`persistence_manager.py:346-356`).
   *
   * Locations are exported for discovery status only. The description, position
   * and adjacency on disk are authored content and are never overwritten from
   * the database copy.
   */
  exportStateToFilesystem(): void {
    const playerState = getPlayerState(this.db, this.worldId)
    const locations = getLocations(this.db, this.worldId)

    if (!playerState) {
      logger.warning(`No player state to export for world_id=${this.worldId}`)
      return
    }

    const fsState = this.players.loadPlayerState(this.worldName) ?? blankPlayerState()

    // `turn_count` is nullable in the DDL; `player.yaml` has no such shape, so
    // a NULL exports as 0 rather than as `turn_count: null`.
    fsState.turnCount = playerState.turnCount ?? 0

    // Parsed with a bare `JSON.parse`, as Python parses with a bare
    // `json.loads` (`persistence_manager.py:359,363`): a corrupt blob throws
    // and aborts the export rather than being quietly exported as empty, which
    // would overwrite a good `player.yaml` with nothing.
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
      // Only written when discovery actually differs, so an export does not
      // rewrite `_index.yaml` for every location on every backup.
      if (locConfig.isDiscovered === Boolean(location.isDiscovered)) continue

      this.locations.updateLocation(this.worldName, location.name, {
        isDiscovered: location.isDiscovered,
        // `null` means "leave alone" to the writer, which is what most rows
        // carry — see the note on `LocationStorage.updateLocation`.
        label: location.label,
      })
    }

    logger.info(`Exported ${locations.length} locations to filesystem`)
  }
}
