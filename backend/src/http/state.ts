import type { Context } from 'hono'

import type { Db } from '../db'
import { getLogger } from '../infrastructure/logging/logger'
import { BackgroundScheduler } from '../infrastructure/scheduler'
import { EventBroadcaster } from '../infrastructure/sse'
import { SSETicketManager } from '../infrastructure/sse-ticket'
import { RoomOrchestrator } from '../orchestration/room-orchestrator'
import type { GameplayServices } from '../orchestration/gameplay-context'
import { SessionPool } from '../sdk/client/session-pool'
import { McpTools } from '../sdk/mcp'
import type { ServerDeps } from '../sdk/handlers/servers'
import { AgentConfigService } from '../services/agent-config-service'
import { AgentFactory } from '../services/agent-factory'
import { AgentFilesystemService } from '../services/agent-filesystem-service'
import { AgentService } from '../services/agent-service'
import { ItemService } from '../services/item-service'
import { LocationStorage } from '../services/location-storage'
import { PersistenceManager } from '../services/persistence-manager'
import { PlayerFacade } from '../services/player-facade'
import { PlayerService } from '../services/player-service'
import { RoomMappingService } from '../services/room-mapping'
import {
  createSummarizer,
  HistoryCompressionService,
} from '../services/history-compression-service'
import { WorldResetService } from '../services/world-reset-service'
import { WorldService } from '../services/world-service'
import { getSettings } from '../config/settings'
import type { Identity } from './access-control'
import type { AppEnv } from './types'

/**
 * Everything the routers need that outlives a request.
 *
 * The FastAPI counterpart is `app.state` plus the `Depends(...)` functions in
 * `core/dependencies.py`. There is no dependency-injection framework here and
 * none is wanted: a route module is a factory that takes this object, which is
 * the shape Phase 1 already settled on for `createAuthRoutes()` and the reason
 * that router is a factory rather than a module singleton.
 *
 * One instance per server. It is created in {@link createAppState} at startup
 * and torn down by {@link AppState.shutdown}, so a test can stand up a whole
 * backend against a temp database without touching module-level state.
 */

const logger = getLogger('AppState')

export interface AppState {
  db: Db
  /** Warm Claude sessions, one per (room, agent). */
  pool: SessionPool
  /** Turn tracking, interrupts, and the transient status the poller reports. */
  orchestrator: RoomOrchestrator
  /** The four filesystem services the world is actually stored in. */
  services: GameplayServices
  /** What the MCP tool servers are handed, per request. */
  serverDeps: ServerDeps
  /** The loopback MCP endpoint the spawned CLIs call tools through. */
  mcp: McpTools
  /** Deletion paths that must also tear down warm sessions. */
  agents: AgentService
  /** World-scoped agent folders, and the mirror into the `agents` table. */
  agentFiles: AgentFilesystemService
  agentFactory: AgentFactory
  items: ItemService
  reset: WorldResetService
  /** Drives the History_Summarizer over `history.md`. */
  history: HistoryCompressionService
  /** Per-room SSE fan-out; the streaming half of the chat surface. */
  broadcaster: EventBroadcaster
  /** Single-use tickets, because `EventSource` cannot send a header. */
  tickets: SSETicketManager
  /**
   * Autonomous chat rounds, on Python's two-second cadence.
   *
   * Constructed here but *not* started: `createAppState` is what the test suite
   * and `bun run smoke` build, and neither wants a timer firing turns at them.
   * `main.ts` starts it; `shutdown()` stops it either way, so a caller that
   * never started it still pays nothing.
   */
  scheduler: BackgroundScheduler
  projectRoot: string
  shutdown(): Promise<void>
}

export interface CreateAppStateOptions {
  db: Db
  /** Defaults to `settings.paths.worldsDir`; overridden in tests. */
  worldsDir?: string
  projectRoot?: string
}

export function createAppState(options: CreateAppStateOptions): AppState {
  const settings = getSettings()
  const worldsDir = options.worldsDir ?? settings.paths.worldsDir
  const projectRoot = options.projectRoot ?? settings.paths.projectRoot

  // Each service keeps its own mtime cache, which is the hot-reload mechanism —
  // not a request cache. They are deliberately *not* given a shared one: a
  // shared cache would make an edit to one world's files invalidate reads of
  // another's, and the entries are small enough that sharing buys nothing.
  const services: GameplayServices = {
    worlds: new WorldService(worldsDir),
    players: new PlayerService(worldsDir),
    locations: new LocationStorage(worldsDir),
    rooms: new RoomMappingService(worldsDir),
  }

  const items = new ItemService(worldsDir)
  const reset = new WorldResetService(worldsDir)
  const agentFiles = new AgentFilesystemService(worldsDir)
  const agentConfigs = new AgentConfigService(projectRoot)
  const agentFactory = new AgentFactory(agentConfigs)


  // `serverDeps` is built before the orchestrator and closes over it. The cycle
  // is real — tools report progress to the orchestrator, and the orchestrator
  // runs the turns that build the tools — and a closure is the narrowest place
  // to break it: the callback cannot fire until a turn is running, by which
  // point the binding is long since initialised.
  const serverDeps: ServerDeps = {
    players: services.players,
    rooms: services.rooms,
    locations: services.locations,
    worlds: services.worlds,
    items,
    reset,
    agentConfigs,
    agentFiles,
    agentFactory,
    persistence: (db, worldId, worldName) =>
      new PersistenceManager(db, worldId, worldName, worldsDir),
    // Bound per world by `buildServers`, because the facade's write-through
    // targets one `player_states` row. Passed explicitly rather than left to
    // the default so it shares this state's `PlayerService` — and with it the
    // mtime cache that makes the filesystem reads hot.
    mutations: (db, worldId) => new PlayerFacade(services.players, db, worldId),
    // The player's input unblocks on narration rather than on the turn ending:
    // the Action Manager keeps working afterwards (stats, suggestions) and
    // there is nothing left to wait for once the prose is on screen.
    onNarrationProduced: (roomId: number) => { orchestrator.setNarrationProduced(roomId) },
    // The inversion the SDK layer depends on: tools report progress and fire
    // turn side effects through these callbacks, so nothing under `src/sdk/`
    // ever imports the orchestrator.
    status: {
      setSubAgentActive: (roomId, name, thinkingText) => {
        orchestrator.setSubAgentActive(roomId, name, thinkingText)
      },
      setSubAgentInactive: (roomId) => { orchestrator.setSubAgentInactive(roomId) },
      setSeedGenerationActive: (roomId, thinkingText) => {
        orchestrator.setSeedGenerationActive(roomId, thinkingText)
      },
      setSeedGenerationInactive: (roomId) => { orchestrator.setSeedGenerationInactive(roomId) },
      triggerNpcMemoryRound: (locationId) => orchestrator.triggerNpcMemoryRound(locationId),
      preConnectLocation: (roomId, locationId) => {
        orchestrator.preConnectLocation(roomId, locationId)
      },
    },
  }



  // Ordered so nothing has to be forward-declared: `serverDeps` closes over the
  // orchestrator lazily but references nothing here eagerly, the endpoint needs
  // only `serverDeps`, and the pool needs the endpoint's eviction hook — which
  // keeps a session and its MCP binding dying together.
  const mcp = new McpTools(serverDeps)
  const pool = new SessionPool(10, mcp.release)

  // Its own `WorldService` and mtime cache, deliberately: `compressHistory`
  // rewrites `history.md` through `fs` directly and drops that path's cache
  // entry itself, which it can only do for a cache it owns.
  const history = new HistoryCompressionService(
    createSummarizer(pool, { useSonnet: settings.useSonnet }),
    worldsDir,
    agentConfigs,
  )

  const broadcaster = new EventBroadcaster()

  const orchestrator = new RoomOrchestrator({
    db: options.db,
    pool,
    services,
    serverDeps,
    mcp,
    projectRoot,
    useSonnet: settings.useSonnet,
  })

  const scheduler = new BackgroundScheduler({
    db: options.db,
    orchestrator,
    maxConcurrentRooms: settings.maxConcurrentRooms,
  })

  return {
    db: options.db,
    pool,
    orchestrator,
    services,
    serverDeps,
    mcp,
    agents: new AgentService(pool, orchestrator),
    agentFiles,
    agentFactory,
    items,
    reset,
    history,
    broadcaster,
    tickets: new SSETicketManager(),
    scheduler,
    projectRoot,
    async shutdown() {
      // Before anything else: the scheduler is the only thing that *starts*
      // work on its own, so it has to stop first or a tick can hand the
      // orchestrator a fresh round while the next line is draining it.
      await scheduler.stop()
      // Then: an open stream holds a request alive, and every one of them has
      // to be told to finish before the turns that feed them stop existing.
      logger.info('Closing SSE streams...')
      broadcaster.shutdown()
      logger.info('Stopping in-flight turns...')
      await orchestrator.shutdown()
      logger.info('Closing agent sessions...')
      await pool.shutdown()
      // After the sessions, not before: a session still unwinding can have a
      // sub-agent tool call in flight, and tearing the listener out from under
      // it would turn an orderly shutdown into a connection error.
      mcp.stop()
    },
  }
}

/**
 * The authenticated caller. Port of `get_request_identity`.
 *
 * The defaults matter and are Python's: an unauthenticated request that somehow
 * reaches a handler is treated as `admin`, because the middleware's exclusion
 * table — not the handler — is what decides whether a route is public. Changing
 * the default to `guest` here would silently 403 every excluded route instead of
 * serving it.
 */
export function identityOf(c: Context<AppEnv>): Identity {
  const role = c.get('userRole') ?? 'admin'
  return { role, userId: c.get('userId') ?? role }
}
