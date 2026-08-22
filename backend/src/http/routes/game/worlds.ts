/**
 * World management routes. The filesystem is the source of truth; the database
 * rows are a cache this module keeps in step ({@link syncWorldFromFs}).
 *
 * `/importable` must stay registered before `/:world_id` — Hono matches in
 * registration order — and the collection routes are registered both with and
 * without the trailing slash, which Hono does not redirect.
 */

import { eq } from 'drizzle-orm'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono, type Context } from 'hono'

import { getAgentByName, syncAgentsWithFilesystem } from '../../../crud/agents'
import {
  createNewRoomForLocation,
  getAllCharactersInWorld,
  getLocationByName,
  getLocations,
  syncLocationsWithFilesystem,
  type LocationWithRoom,
} from '../../../crud/locations'
import { createMessage } from '../../../crud/messages'
import { getPlayerState } from '../../../crud/player-state'
import { addAgentToRoom } from '../../../crud/rooms'
import {
  createWorld as createWorldRow,
  deleteWorld as deleteWorldRow,
  getWorld,
  getWorldByName,
  getWorldsByOwner,
  importWorldFromFilesystem,
  updateWorld,
} from '../../../crud/worlds'
import { locations as locationsTable, playerStates, type World } from '../../../db/schema'
import { toLangKey } from '../../../domain/enums'
import { getArrivalMessage, getOnboardingMessage } from '../../../domain/localization'
import { getLogger } from '../../../infrastructure/logging/logger'
import {
  toImportableWorld,
  toStatDefinitions,
  toWorld,
  toWorldSummary,
  WorldCreate,
  WorldResetRequest,
  type World as WorldResponse,
} from '../../../schemas/game'
import { RoomMappingService } from '../../../services/room-mapping'
import { HttpError } from '../../../domain/errors'
import { identityOf, type AppState } from '../../state'
import type { AppEnv } from '../../types'
import {
  createLocationFromFilesystem,
  deferBackground,
  intPathParam,
  parseBody,
  requireWorld,
  startBackground,
} from './shared'

const logger = getLogger('GameRouter.Worlds')

/**
 * Copy the filesystem's view of a world onto its row; returns whether anything
 * changed. `routes/game/polling.ts` keeps its own copy on purpose: it needs the
 * new phase *before* the write in order to route the poll.
 */
export function syncWorldFromFs(state: AppState, world: World): boolean {
  const config = state.services.worlds.loadWorldConfig(world.name)
  if (!config) {
    logger.warning(`FS config not found for world '${world.name}'`)
    return false
  }

  const updates: Parameters<typeof updateWorld>[2] = {}
  let count = 0
  if (config.phase !== world.phase) {
    updates.phase = config.phase === 'active' || config.phase === 'ended' ? config.phase : 'onboarding'
    count += 1
  }
  if (config.userName && config.userName !== world.userName) {
    updates.userName = config.userName
    count += 1
  }
  if (config.genre && config.genre !== world.genre) {
    updates.genre = config.genre
    count += 1
  }
  if (config.theme && config.theme !== world.theme) {
    updates.theme = config.theme
    count += 1
  }

  if (count === 0) return false

  updateWorld(state.db, world.id, updates)
  logger.info(`Synced ${count} fields for world '${world.name}'`)
  return true
}

// Both overlays replace rather than merge — `stat_definitions` is write-only.
function buildWorldResponse(state: AppState, world: World): WorldResponse {
  return toWorld(world, {
    lore: state.services.worlds.loadLore(world.name),
    stat_definitions: toStatDefinitions(state.services.players.loadStatDefinitions(world.name).stats),
  })
}

export function createWorldRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  /**
   * Create a world and stage its onboarding room. Order matters: filesystem
   * tree, rows, `_state.json` mapping, then the Onboarding Manager and its
   * trigger message. That message is written but not acted on here — the
   * frontend calls `/start-onboarding` once it is listening.
   */
  const createWorldHandler = async (c: Context<AppEnv>) => {
    const identity = identityOf(c)
    const body = await parseBody(c, WorldCreate)

    if (getWorldByName(state.db, body.name, identity.userId)) {
      throw new HttpError(400, `World '${body.name}' already exists`)
    }

    state.services.worlds.createWorld(body.name, identity.userId, body.user_name, body.language)

    const world = createWorldRow(
      state.db,
      { name: body.name, userName: body.user_name, language: body.language },
      identity.userId,
    )

    if (world.onboardingRoomId) {
      state.services.rooms.setRoomMapping(body.name, 'onboarding', world.onboardingRoomId, [
        'Onboarding_Manager',
      ])
      state.services.rooms.setCurrentRoom(body.name, 'onboarding')
      logger.info(`Stored onboarding room mapping for world '${body.name}'`)
    }

    const onboardingAgent = getAgentByName(state.db, 'Onboarding_Manager')
    if (onboardingAgent && world.onboardingRoomId) {
      addAgentToRoom(state.db, world.onboardingRoomId, onboardingAgent.id)

      // `user` role on purpose: the Onboarding Manager's group sets
      // `can_see_system_messages`, making this its first instruction.
      createMessage(state.db, world.onboardingRoomId, {
        content: getOnboardingMessage(toLangKey(body.language)),
        role: 'user',
        participantType: 'system',
        participantName: 'System',
      })

      logger.info(`Onboarding room ready for world '${body.name}' (trigger via /start-onboarding)`)
    } else if (!onboardingAgent) {
      // Seeding runs at startup, so a missing row means no `agents/` tree.
      logger.warning(
        `No 'Onboarding_Manager' agent row — world '${body.name}' has an empty onboarding room ` +
          'and its first turn will fail. Check that the agents/ directory is present and restart.',
      )
    }

    logger.info(`Created world '${body.name}' for user '${identity.userId}'`)
    return c.json(toWorldSummary(world))
  }

  routes.post('/worlds', createWorldHandler)
  routes.post('/worlds/', createWorldHandler)

  // No ownership check, deliberately: any authenticated caller can start
  // onboarding on any world still in that phase (see `http/access-control.ts`).
  routes.post('/worlds/:world_id/start-onboarding', (c) => {
    const worldId = intPathParam(c, 'world_id')

    const world = getWorld(state.db, worldId)
    if (!world) throw new HttpError(404, 'World not found')
    if (world.phase !== 'onboarding') {
      throw new HttpError(400, 'World is not in onboarding phase')
    }
    if (!world.onboardingRoomId) throw new HttpError(400, 'World has no onboarding room')

    const action = getOnboardingMessage(toLangKey(world.language))

    // Safe to start immediately: no further reads a turn's writes could race.
    spawnTurn(state, worldId, (w) => w.onboardingRoomId, action, `start_onboarding:world=${worldId}`)

    return c.json({ status: 'started' })
  })

  const listWorldsHandler = (c: Context<AppEnv>) =>
    c.json(getWorldsByOwner(state.db, identityOf(c).userId).map(toWorldSummary))

  routes.get('/worlds', listWorldsHandler)
  routes.get('/worlds/', listWorldsHandler)

  // Worlds on disk but absent from this user's rows. The scan is unfiltered by
  // owner, which is how a world moves between accounts and installs.
  routes.get('/worlds/importable', (c) => {
    const identity = identityOf(c)
    const owned = new Set(getWorldsByOwner(state.db, identity.userId).map((w) => w.name))

    return c.json(
      state.services.worlds
        .listWorlds()
        .filter((config) => !owned.has(config.name))
        .map(toImportableWorld),
    )
  })

  /** Adopt an on-disk world into the database. */
  routes.post('/worlds/import/:world_name', (c) => {
    const identity = identityOf(c)
    const worldName = decodeURIComponent(c.req.param('world_name'))

    const config = state.services.worlds.loadWorldConfig(worldName)
    if (!config) {
      throw new HttpError(404, `World '${worldName}' not found in filesystem`)
    }
    if (getWorldByName(state.db, worldName, identity.userId)) {
      throw new HttpError(400, `World '${worldName}' already exists in database`)
    }

    const world = importWorldFromFilesystem(state.db, config, identity.userId, {
      players: state.services.players,
      rooms: state.services.rooms,
    })
    logger.info(`Imported world '${worldName}' for user '${identity.userId}'`)
    return c.json(toWorldSummary(world))
  })

  // Gap: `SessionPool` has no `preConnect`, so nothing warms the Action
  // Manager's session here and the first action is slower.
  routes.get('/worlds/:world_id', (c) => {
    const worldId = intPathParam(c, 'world_id')
    let world = requireWorld(state, c, worldId)

    if (syncWorldFromFs(state, world)) {
      world = getWorld(state.db, worldId)!
    }

    return c.json(buildWorldResponse(state, world))
  })

  routes.delete('/worlds/:world_id', (c) => {
    const worldId = intPathParam(c, 'world_id')
    // The one place the 403 detail is not "Not your world".
    const world = requireWorld(state, c, worldId, 'Not authorized to delete this world')

    deleteWorldRow(state.db, worldId)
    state.services.worlds.deleteWorld(world.name)

    logger.info(`Deleted world '${world.name}' (FS + DB)`)
    return c.json({ status: 'deleted' })
  })

  routes.get('/worlds/:world_id/characters', (c) => {
    const worldId = intPathParam(c, 'world_id')
    requireWorld(state, c, worldId)
    return c.json({ characters: getAllCharactersInWorld(state.db, worldId) })
  })

  /** `history.md`, verbatim. Read-only; the agents write it. */
  routes.get('/worlds/:world_id/history', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)
    return c.json({ history: state.services.worlds.loadHistory(world.name) })
  })

  // Compress `history.md` into `consolidated_history.md`. The 400/500 split is
  // load-bearing: `gameService.compressWorldHistory` shows the 500's reason.
  routes.post('/worlds/:world_id/history/compress', async (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)

    try {
      return c.json(await state.history.compressHistory(state.db, world.name))
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new HttpError(400, error.message)
      }
      logger.exception(`Failed to compress history for world '${world.name}'`, error)
      throw new HttpError(500, `Failed to compress history: ${String(error)}`)
    }
  })

  // The reset is what turns the seed generator's output into a first turn.
  routes.post('/worlds/:world_id/enter', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const found = requireWorld(state, c, worldId)

    // The onboarding `complete` tool parks the transition in `pending_phase` so
    // the player, not the agent, decides when the world opens.
    state.services.worlds.applyPendingPhase(found.name)
    syncWorldFromFs(state, found)

    const world = getWorld(state.db, worldId)!
    if (world.phase !== 'active') {
      throw new HttpError(400, 'World is not ready yet (still in onboarding phase)')
    }

    const { startingLocation, arrivalContent } = performWorldReset(state, world, 'Failed to enter world')

    if (startingLocation.roomId) {
      const roomId = startingLocation.roomId
      deferBackground(
        () => runTurn(state, worldId, roomId, arrivalContent),
        { name: `enter_world:world=${worldId}` },
      )
      logger.info('Enter: Triggered initial scene generation')
    }

    return c.json({
      world: buildWorldResponse(state, world),
      arrival_message_sent: true,
    })
  })

  // `confirm` is validated before the world is looked up, so an unconfirmed
  // reset of a nonexistent world is a 400, not a 404.
  routes.post('/worlds/:world_id/reset', async (c) => {
    const worldId = intPathParam(c, 'world_id')
    const request = await parseBody(c, WorldResetRequest)

    if (!request.confirm) {
      throw new HttpError(400, 'Must set confirm=true to reset world')
    }

    const world = requireWorld(state, c, worldId)
    if (world.phase !== 'active') {
      throw new HttpError(400, 'Can only reset active worlds')
    }

    const { startingLocation, arrivalContent } = performWorldReset(
      state,
      world,
      `Failed to reset world`,
    )

    if (startingLocation.roomId) {
      const roomId = startingLocation.roomId
      deferBackground(
        () => runTurn(state, worldId, roomId, arrivalContent),
        { name: `reset_world:world=${worldId}` },
      )
      logger.info('Triggered initial scene generation for reset')
    }

    return c.json({
      success: true,
      message: `World '${world.name}' has been reset to its initial state`,
      world_id: worldId,
      starting_location: startingLocation.displayName || startingLocation.name,
    })
  })

  return routes
}

interface ResetOutcome {
  startingLocation: LocationWithRoom
  /** The arrival line, both written to the room and replayed as the first action. */
  arrivalContent: string
}

/**
 * Put a world back to the moment onboarding finished. Shared by enter and reset.
 *
 * The step order is load-bearing three times: stale `_index.json` entries are
 * cleaned before the DB is synced against the filesystem, or the sync keeps
 * rows for deleted directories alive; fresh rooms are minted before the
 * starting location is resolved, since a new room is what clears a location's
 * conversation context; and `_state.json` is rewritten after the re-mapping, so
 * the surviving mapping is the new room id.
 */
function performWorldReset(state: AppState, world: World, errorContext: string): ResetOutcome {
  try {
    return performWorldResetInner(state, world)
  } catch (error) {
    if (error instanceof HttpError) throw error
    logger.exception(`Failed to reset world '${world.name}'`, error)
    throw new HttpError(500, `${errorContext}: ${String(error)}`)
  }
}

function performWorldResetInner(state: AppState, world: World): ResetOutcome {
  const { db, services } = state
  const initial = state.reset.loadInitialState(world.name)
  if (!initial) throw new HttpError(400, 'No initial state found for this world')

  const startingLocationName = initial.starting_location
  const initialGameTime = initial.initial_game_time ?? { hour: 8, minute: 0, day: 1 }

  logger.info(`Resetting world '${world.name}' to initial state`)

  const staleEntries = services.locations.cleanupStaleEntries(world.name)
  if (staleEntries.length > 0) {
    logger.info(
      `Cleaned up ${staleEntries.length} stale entries from _index.json: ${staleEntries.join(', ')}`,
    )
  }

  const deletedCount = syncLocationsWithFilesystem(db, world.id, world.name, {
    loadAllLocations: (name) => services.locations.loadAllLocations(name),
    deleteRoomMapping: (name, roomKey) => {
      services.rooms.deleteRoomMapping(name, roomKey)
    },
  })
  if (deletedCount > 0) logger.info(`Cleaned up ${deletedCount} orphaned locations during reset`)

  const staleAgents = syncAgentsWithFilesystem(db, world.name, { projectRoot: state.projectRoot })
  if (staleAgents > 0) logger.info(`Cleaned up ${staleAgents} stale agents during reset`)

  // Fresh room per location; the old ones keep their transcripts.
  for (const [roomKey, mapping] of Object.entries(services.rooms.getAllRoomMappings(world.name))) {
    if (!roomKey.startsWith('location:')) continue

    const oldRoomId = mapping.dbRoomId
    const locationName = roomKey.slice('location:'.length)

    if (oldRoomId) {
      // Fire-and-forget: a session for an unreferenced room id is unreachable
      // anyway, and awaiting would make the whole reset async.
      void state.pool.evictRoom(oldRoomId)
    }

    const location = getLocationByName(db, world.id, locationName)
    if (location) {
      const newRoom = createNewRoomForLocation(db, location)
      // Characters are dropped: the cast is re-seeded from the world
      // definition, not from whoever stood here last session.
      services.rooms.setRoomMapping(world.name, roomKey, newRoom.id, [])
      logger.info(`Created fresh room for ${roomKey} (old=${oldRoomId}, new=${newRoom.id})`)
    } else {
      services.rooms.deleteRoomMapping(world.name, roomKey)
      logger.info(`Removed stale room mapping ${roomKey}`)
    }
  }

  let startingLocation = getLocationByName(db, world.id, startingLocationName)
  if (!startingLocation) {
    startingLocation = createLocationFromFilesystem(
      state,
      world.name,
      world.id,
      startingLocationName,
    )
    if (!startingLocation) {
      throw new HttpError(
        400,
        `Starting location '${startingLocationName}' not found in database or filesystem`,
      )
    }
    logger.info(
      `Created starting location '${startingLocationName}' from filesystem during reset`,
    )
  }

  if (getPlayerState(db, world.id)) {
    db.update(playerStates)
      .set({
        turnCount: 0,
        currentLocationId: startingLocation.id,
        stats: JSON.stringify(initial.initial_stats),
        inventory: JSON.stringify(initial.initial_inventory),
        effects: '[]',
        actionHistory: '[]',
        isChatMode: false,
        chatModeStartMessageId: null,
      })
      .where(eq(playerStates.worldId, world.id))
      .run()
    logger.info('Reset player state in database')
  }

  services.players.savePlayerState(world.name, {
    currentLocation: startingLocationName,
    turnCount: 0,
    stats: initial.initial_stats,
    inventory: initial.initial_inventory,
    effects: [],
    recentActions: [],
    gameTime: initialGameTime,
    equipment: {},
    flags: {},
  })
  logger.info(`Reset player.json in filesystem (game_time: ${initialGameTime.hour}:00)`)

  const transient = services.rooms.loadState(world.name)
  const startingRoomKey = RoomMappingService.locationToRoomKey(startingLocationName)
  const preserved: typeof transient.rooms = {}
  if (transient.rooms.onboarding) preserved.onboarding = transient.rooms.onboarding
  if (transient.rooms[startingRoomKey]) preserved[startingRoomKey] = transient.rooms[startingRoomKey]

  transient.rooms = preserved
  transient.suggestions = []
  transient.currentRoom = startingRoomKey
  // A stale arrival context makes the opening scene narrate a journey the
  // player never took.
  delete transient.ui.arrival_context
  services.rooms.saveState(world.name, transient)
  logger.info(`Reset _state.json rooms to: ${Object.keys(preserved).join(', ')}`)

  const allLocations = getLocations(db, world.id)
  for (const location of allLocations) {
    const shouldBeDiscovered = location.id === startingLocation.id
    if (Boolean(location.isDiscovered) !== shouldBeDiscovered) {
      db.update(locationsTable)
        .set({ isDiscovered: shouldBeDiscovered })
        .where(eq(locationsTable.id, location.id))
        .run()
    }
  }
  logger.info(
    `Reset is_discovered for ${allLocations.length} locations ` +
      `(starting location: ${startingLocation.name})`,
  )

  clearWorldNarrativeFiles(state, world.name)

  const locationDisplay = startingLocation.displayName || startingLocation.name
  const language = toLangKey(world.language)
  const defaultName = language === 'ko' ? '여행자' : 'The traveler'
  const arrivalContent = getArrivalMessage(
    world.userName || defaultName,
    locationDisplay,
    language,
  )

  if (startingLocation.roomId) {
    createMessage(db, startingLocation.roomId, {
      content: arrivalContent,
      role: 'user',
      participantType: 'system',
      participantName: 'System',
    })
    logger.info('Sent arrival message for reset')
  }

  logger.info(`Successfully reset world '${world.name}'`)
  return { startingLocation, arrivalContent }
}

// All of this is regenerated by play, so a missing directory is not an error.
function clearWorldNarrativeFiles(state: AppState, worldName: string): void {
  const worldPath = state.services.worlds.getWorldPath(worldName)

  const locationsPath = join(worldPath, 'locations')
  if (existsSync(locationsPath)) {
    for (const entry of readdirSync(locationsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const eventsFile = join(locationsPath, entry.name, 'events.md')
      if (existsSync(eventsFile)) writeFileSync(eventsFile, '', 'utf-8')
    }
    logger.info('Cleared events.md files')
  }

  const historyFile = join(worldPath, 'history.md')
  if (existsSync(historyFile)) {
    writeFileSync(historyFile, '# World History\n\n', 'utf-8')
    logger.info('Reset history.md')
  }

  const agentsPath = join(worldPath, 'agents')
  if (existsSync(agentsPath)) {
    let cleared = 0
    for (const entry of readdirSync(agentsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const recentEvents = join(agentsPath, entry.name, 'recent_events.md')
      if (existsSync(recentEvents)) {
        rmSync(recentEvents, { force: true })
        cleared += 1
      }
    }
    if (cleared > 0) logger.info(`Cleared ${cleared} agent recent_events.md files`)
  }
}

// The world row is re-read because it can move on before the turn starts.
async function runTurn(state: AppState, worldId: number, roomId: number, action: string): Promise<void> {
  const world = getWorld(state.db, worldId)
  if (!world) return
  await state.orchestrator.handlePlayerAction({ world, roomId, action })
}

// The room is resolved inside the task, not captured: `/start-onboarding`
// answers before the turn begins.
function spawnTurn(
  state: AppState,
  worldId: number,
  roomOf: (world: World) => number | null,
  action: string,
  name: string,
): void {
  startBackground(async () => {
    const world = getWorld(state.db, worldId)
    if (!world) return
    const roomId = roomOf(world)
    if (!roomId) return
    await state.orchestrator.handlePlayerAction({ world, roomId, action })
  }, { name })
}
