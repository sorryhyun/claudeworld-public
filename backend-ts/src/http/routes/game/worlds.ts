/**
 * World management routes — port of `backend/routers/game/worlds.py`.
 *
 * Create, list, import, enter, reset and delete a world. The filesystem is the
 * source of truth for every one of them: `worlds/<name>/` is written first and
 * the database rows are a cache that this module keeps in step
 * ({@link syncWorldFromFs}).
 *
 * ## Two things worth knowing before editing
 *
 * **`/importable` must stay registered before `/:world_id`.** Both match
 * `GET /worlds/importable`, and Hono runs matching handlers in registration
 * order. Swapping them turns the import picker into a 422 (`world_id` is
 * declared `int`), which is exactly the failure FastAPI's own ordering rule
 * avoids.
 *
 * **The collection routes answer on `/worlds` and `/worlds/` alike.** Python's
 * canonical path is `/worlds/` — `@router.get("/")` under `prefix="/worlds"` —
 * and Starlette 307-redirects `/worlds` onto it, which `fetch` follows
 * transparently; `frontend/src/services/gameService.ts` only ever sends the
 * unslashed form. Hono's router is strict about the trailing slash and does not
 * redirect, so both spellings are registered rather than leaving one of them a
 * 404 that Python answers with a 200.
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
import { HttpError } from '../../errors'
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

// =============================================================================
// FS↔DB SYNC HELPERS (formerly WorldFacade)
// =============================================================================

/**
 * Copy the filesystem's view of a world onto its database row.
 *
 * Only four fields move, and only in one direction: the filesystem wins. The
 * onboarding tools write `world.yaml` directly, so the row is stale from the
 * moment the interview names a genre — this is what makes the world panel show
 * it. Returns whether anything changed, which callers use to decide whether to
 * re-read the row.
 *
 * `routers/game/polling.py` carries its own copy of this logic instead of
 * calling the helper, because it needs the new phase *before* the write in
 * order to route the poll; that duplication is preserved there.
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

/**
 * A full `World` response: the row plus the two fields that only exist on disk.
 *
 * Port of `_build_world_response`. Both overlays *replace* rather than merge —
 * the `worlds.stat_definitions` column is a write-only cache and this path
 * never reads it.
 */
function buildWorldResponse(state: AppState, world: World): WorldResponse {
  return toWorld(world, {
    lore: state.services.worlds.loadLore(world.name),
    stat_definitions: toStatDefinitions(state.services.players.loadStatDefinitions(world.name).stats),
  })
}

// =============================================================================
// Router
// =============================================================================

export function createWorldRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  // ---------------------------------------------------------------------------
  // World management
  // ---------------------------------------------------------------------------

  /**
   * Create a world and stage its onboarding room.
   *
   * Order matters and is Python's: the filesystem tree first (it is the source
   * of truth, and its "already exists" is a 400 the user can act on), then the
   * database rows, then the `_state.json` mapping that links the two, then the
   * Onboarding Manager and the system message that will trigger it.
   *
   * The trigger message is written but *not* acted on here — the frontend calls
   * `/start-onboarding` once it is listening, so the agent's first thinking
   * stream is not produced before anything can display it.
   */
  const createWorldHandler = async (c: Context<AppEnv>) => {
    const identity = identityOf(c)
    const body = await parseBody(c, WorldCreate)

    if (getWorldByName(state.db, body.name, identity.userId)) {
      throw new HttpError(400, `World '${body.name}' already exists`)
    }

    // `WorldService.createWorld` already throws `HttpError(400, "World '<x>'
    // already exists")`, which is the exact response Python's
    // `except ValueError` produced, so there is nothing to translate here.
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

      // Written as a *user*-role system message on purpose: the Onboarding
      // Manager's group sets `can_see_system_messages`, so this is what the
      // agent reads as its first instruction when `/start-onboarding` fires.
      createMessage(state.db, world.onboardingRoomId, {
        content: getOnboardingMessage(toLangKey(body.language)),
        role: 'user',
        participantType: 'system',
        participantName: 'System',
      })

      logger.info(`Onboarding room ready for world '${body.name}' (trigger via /start-onboarding)`)
    }

    logger.info(`Created world '${body.name}' for user '${identity.userId}'`)
    return c.json(toWorldSummary(world))
  }

  routes.post('/worlds', createWorldHandler)
  routes.post('/worlds/', createWorldHandler)

  /**
   * Send the Onboarding Manager its opening prompt.
   *
   * **No ownership check, deliberately.** `worlds.py:217` takes an `identity`
   * dependency and never reads it, so any authenticated caller can start
   * onboarding on any world that is still in the onboarding phase. Reproduced
   * rather than tightened: the parity harness diffs statuses, and the guest role
   * is not a security boundary here (see `http/access-control.ts`).
   */
  routes.post('/worlds/:world_id/start-onboarding', (c) => {
    const worldId = intPathParam(c, 'world_id')

    const world = getWorld(state.db, worldId)
    if (!world) throw new HttpError(404, 'World not found')
    if (world.phase !== 'onboarding') {
      throw new HttpError(400, 'World is not in onboarding phase')
    }
    if (!world.onboardingRoomId) throw new HttpError(400, 'World has no onboarding room')

    const action = getOnboardingMessage(toLangKey(world.language))

    // Python's `spawn_background`, not `BackgroundTasks` — this one is meant to
    // start immediately, and the handler makes no further reads that a turn's
    // writes could race.
    spawnTurn(state, worldId, (w) => w.onboardingRoomId, action, `start_onboarding:world=${worldId}`)

    return c.json({ status: 'started' })
  })

  const listWorldsHandler = (c: Context<AppEnv>) =>
    c.json(getWorldsByOwner(state.db, identityOf(c).userId).map(toWorldSummary))

  routes.get('/worlds', listWorldsHandler)
  routes.get('/worlds/', listWorldsHandler)

  /**
   * Worlds present in `worlds/` but absent from this user's database rows.
   *
   * The filesystem scan is unfiltered by owner — `WorldService.list_worlds()`
   * takes no argument here — so a world created by another account, or by a
   * hand-copied folder, shows up as importable. That is how a world moves
   * between installs.
   */
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

  /**
   * World details, with `lore.md` and `stats.yaml` overlaid.
   *
   * **Gap: no agent pre-connect.** Python spawns a background task here that
   * opens SDK sessions for the Action Manager and up to five NPCs at the
   * player's location, purely to take that latency off the first action. There
   * is no `pre_connect` on `SessionPool` yet, so the optimisation is absent.
   * Nothing about the response changes; the first action is simply slower.
   */
  routes.get('/worlds/:world_id', (c) => {
    const worldId = intPathParam(c, 'world_id')
    let world = requireWorld(state, c, worldId)

    if (syncWorldFromFs(state, world)) {
      world = getWorld(state.db, worldId)!
    }

    return c.json(buildWorldResponse(state, world))
  })

  /** Delete a world, database first and filesystem second. */
  routes.delete('/worlds/:world_id', (c) => {
    const worldId = intPathParam(c, 'world_id')
    // The one place the 403 detail is not "Not your world"; see
    // `http/access-control.ts` on why the inconsistency is preserved.
    const world = requireWorld(state, c, worldId, 'Not authorized to delete this world')

    deleteWorldRow(state.db, worldId)
    state.services.worlds.deleteWorld(world.name)

    logger.info(`Deleted world '${world.name}' (FS + DB)`)
    return c.json({ status: 'deleted' })
  })

  /** Every non-system agent standing somewhere in the world. */
  routes.get('/worlds/:world_id/characters', (c) => {
    const worldId = intPathParam(c, 'world_id')
    requireWorld(state, c, worldId)
    return c.json({ characters: getAllCharactersInWorld(state.db, worldId) })
  })

  /** `history.md`, verbatim. Read-only; the agents are what write it. */
  routes.get('/worlds/:world_id/history', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)
    return c.json({ history: state.services.worlds.loadHistory(world.name) })
  })

  /**
   * Compress `history.md` into `consolidated_history.md`.
   *
   * Turns are batched and handed to the History_Summarizer, which writes one
   * titled section per batch; `history.md` is then cleared. The batching and
   * the summarizer call both live in the service — this handler is only the
   * ownership check and Python's error mapping.
   *
   * That mapping is two-branched and worth keeping: a `ValueError` is a 400
   * (the caller asked for something the world cannot do), anything else is a
   * 500 carrying the reason, which is what `gameService.compressWorldHistory`
   * surfaces in its toast.
   */
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

  /**
   * Enter an active world: apply the pending phase, reset, and open the scene.
   *
   * The reset is not a courtesy — entering a world is how a finished onboarding
   * becomes a playable game, and `_perform_world_reset` is what turns the
   * seed generator's output into a first turn (fresh rooms, player state from
   * `_initial.json`, an arrival message for the Action Manager to answer).
   *
   * **Gap: no Action Manager pre-connect**, for the same reason as
   * `GET /worlds/{id}` above — `SessionPool` has no `pre_connect`, and
   * `RoomOrchestrator.preConnectLocation` only works while a turn is in flight,
   * which is precisely not the case here. The opening turn is slower to start;
   * nothing about the response changes.
   */
  routes.post('/worlds/:world_id/enter', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const found = requireWorld(state, c, worldId)

    // The onboarding `complete` tool parks the transition in `pending_phase` so
    // the player, not the agent, decides when the world opens. This is where
    // the player says yes.
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

  /**
   * Reset an active world to the state `_initial.json` captured.
   *
   * `confirm` is validated *before* the world is looked up, which is Python's
   * order: an unconfirmed reset of a world that does not exist is a 400, not a
   * 404. It reads backwards but it is observable, so it is kept.
   */
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

// =============================================================================
// Reset
// =============================================================================

interface ResetOutcome {
  startingLocation: LocationWithRoom
  /** The arrival line, both written to the room and replayed as the first action. */
  arrivalContent: string
}

/**
 * Put a world back to the moment onboarding finished. Shared by enter and reset.
 *
 * Port of `_perform_world_reset`. The steps are in Python's order and the order
 * is load-bearing in three places:
 *
 * 1. **Stale filesystem entries are cleaned before the database is synced
 *    against the filesystem** — otherwise `_index.yaml` still lists locations
 *    whose directories are gone, and the sync keeps their rows alive.
 * 2. **Fresh rooms are minted before the starting location is resolved.** A new
 *    room is what clears a location's conversation context; resolving the
 *    starting location first would hand back a row still pointing at the old
 *    room, and the opening scene would replay the last session's transcript.
 * 3. **`_state.json` is rewritten after the rooms are re-mapped**, so the
 *    surviving mapping is the new room id rather than the one just abandoned.
 *
 * `errorContext` is the prefix Python's `except Exception` puts on a 500
 * ("Failed to enter world" / "Failed to reset world"); the two `ValueError`
 * cases are thrown as 400s directly, since that is what both callers turn them
 * into.
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
      `Cleaned up ${staleEntries.length} stale entries from _index.yaml: ${staleEntries.join(', ')}`,
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

  // Fresh room per location. The old rooms are deliberately left behind with
  // their transcripts intact — see `createNewRoomForLocation`.
  for (const [roomKey, mapping] of Object.entries(services.rooms.getAllRoomMappings(world.name))) {
    if (!roomKey.startsWith('location:')) continue

    const oldRoomId = mapping.dbRoomId
    const locationName = roomKey.slice('location:'.length)

    if (oldRoomId) {
      // Python awaits `client_pool.cleanup_room`. Nothing downstream depends on
      // the eviction having finished — a session for a room id nothing points at
      // any more is unreachable either way — so this is fire-and-forget rather
      // than making the whole reset async.
      void state.pool.evictRoom(oldRoomId)
    }

    const location = getLocationByName(db, world.id, locationName)
    if (location) {
      const newRoom = createNewRoomForLocation(db, location)
      // Characters are dropped from the mapping, not carried over: the gameplay
      // agents are added to the room by `createNewRoomForLocation`, and the cast
      // is re-seeded by the world's own definition rather than by whoever
      // happened to be standing there when the last session ended.
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
    // Absent from Python's `FSPlayerState(...)` call, so both fall back to the
    // dataclass defaults — an empty map each.
    equipment: {},
    flags: {},
  })
  logger.info(`Reset player.yaml in filesystem (game_time: ${initialGameTime.hour}:00)`)

  const transient = services.rooms.loadState(world.name)
  const startingRoomKey = RoomMappingService.locationToRoomKey(startingLocationName)
  const preserved: typeof transient.rooms = {}
  if (transient.rooms.onboarding) preserved.onboarding = transient.rooms.onboarding
  if (transient.rooms[startingRoomKey]) preserved[startingRoomKey] = transient.rooms[startingRoomKey]

  transient.rooms = preserved
  transient.suggestions = []
  transient.currentRoom = startingRoomKey
  // A stale arrival context would make the opening scene narrate a journey the
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

/**
 * Blank the three kinds of narrative memory a played world accumulates:
 * per-location `events.md`, the world's `history.md`, and each agent's
 * `recent_events.md`.
 *
 * All three are best-effort in Python (the whole block sits inside the caller's
 * try/except) and all three are regenerated by play, so a missing directory is
 * not an error.
 */
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

// =============================================================================
// Background turns
// =============================================================================

/**
 * Run one turn in the background.
 *
 * Python opens a *new database session* for every one of these, because its
 * request session is closed by the time the task runs. `bun:sqlite` is a single
 * synchronous handle with no session lifetime, so `state.db` is used directly;
 * the re-read of the world row is kept because the row can genuinely have moved
 * on (a phase sync, a `last_played_at` bump) between the response and the turn.
 */
async function runTurn(state: AppState, worldId: number, roomId: number, action: string): Promise<void> {
  const world = getWorld(state.db, worldId)
  if (!world) return
  await state.orchestrator.handlePlayerAction({ world, roomId, action })
}

/**
 * {@link runTurn} against a room chosen off the freshly-read world row.
 *
 * The room is resolved inside the task rather than captured, because
 * `/start-onboarding` answers before the turn begins and the onboarding room is
 * read off whatever the row says at that later point.
 */
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
