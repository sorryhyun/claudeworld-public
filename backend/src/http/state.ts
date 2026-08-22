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
 * Everything the routers need that outlives a request; a route module is a
 * factory that takes it. One per server, so a test can stand up a whole backend
 * without module-level state.
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
  /** Per-room SSE fan-out. */
  broadcaster: EventBroadcaster
  /** Single-use tickets, because `EventSource` cannot send a header. */
  tickets: SSETicketManager
  /** Constructed but *not* started — `main.ts` does that, so tests get no timer. */
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

  // Own mtime cache each — the hot-reload mechanism, not a request cache.
  // Sharing one would cross-invalidate between worlds.
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


  // Built before the orchestrator and closing over it. The cycle is real, and
  // the closure breaks it: no callback fires before a turn is running.
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
    // Bound per world by `buildServers`: the facade writes through to one
    // `player_states` row. Explicit so it shares this `PlayerService`.
    mutations: (db, worldId) => new PlayerFacade(services.players, db, worldId),
    // Input unblocks on narration, not turn end: the Action Manager keeps
    // working afterwards on stats and suggestions.
    onNarrationProduced: (roomId: number) => { orchestrator.setNarrationProduced(roomId) },
    // The inversion the SDK layer depends on: nothing under `src/sdk/` imports
    // orchestration, it fires side effects through these callbacks.
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



  // The pool takes the endpoint's eviction hook, so a session and its MCP
  // binding die together.
  const mcp = new McpTools(serverDeps)
  const pool = new SessionPool(10, mcp.release)

  // Its own `WorldService`: `compressHistory` rewrites `history.md` through
  // `fs` and drops that cache entry itself.
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
      // First: the scheduler is the only thing that *starts* work on its own,
      // so stopping it later lets a tick queue a round mid-drain.
      await scheduler.stop()
      // Then the streams: an open one holds a request alive.
      logger.info('Closing SSE streams...')
      broadcaster.shutdown()
      logger.info('Stopping in-flight turns...')
      await orchestrator.shutdown()
      logger.info('Closing agent sessions...')
      await pool.shutdown()
      // After the sessions: one still unwinding can have a sub-agent tool call
      // in flight, and pulling the listener would make that a connection error.
      mcp.stop()
    },
  }
}

/**
 * The authenticated caller. The defaults matter: a request reaching a handler
 * unauthenticated is `admin`, because the middleware's exclusion table decides
 * what is public — `guest` here would silently 403 every excluded route.
 */
export function identityOf(c: Context<AppEnv>): Identity {
  const role = c.get('userRole') ?? 'admin'
  return { role, userId: c.get('userId') ?? role }
}
