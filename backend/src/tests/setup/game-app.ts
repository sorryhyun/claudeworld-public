/**
 * A whole backend, stood up over a temp database and a temp `worlds/` tree.
 *
 * The game routes are tested through `createApp()` — real middleware, real
 * router, real error envelope — because the thing under test is the HTTP
 * surface, not the handlers. What is *not* real is the turn: `RoomOrchestrator`
 * is built with its `turns` seam pointed at a recorder, so a route that starts a
 * background turn is observable without a model, a CLI subprocess or a network
 * call.
 *
 * The database is built from the same verbatim SQLAlchemy `.schema` dump
 * `crud.test.ts` uses, for the same reason: the contract is "these routes read
 * and write a database Python produced", and generating the DDL from
 * `schema.ts` would excuse any drift between them.
 */

import { Database } from 'bun:sqlite'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Hono } from 'hono'
import type { AppEnv } from '@/http/types'

import { generateJwtToken } from '@/auth/jwt'
import { resetSettings } from '@/config/settings'
import { getCache } from '@/infrastructure/cache'
import { BackgroundScheduler } from '@/infrastructure/scheduler'
import { EventBroadcaster } from '@/infrastructure/sse'
import { LiveStreamRegistry } from '@/http/live-streams'
import { SSETicketManager } from '@/infrastructure/sse-ticket'
import { openDb, type Db } from '@/db'
import { RoomOrchestrator } from '@/orchestration/room-orchestrator'
import type { ExecutionResult } from '@/orchestration/tape/models'
import type { GameplayServices } from '@/orchestration/gameplay-context'
import type { SessionPool } from '@/sdk/client/session-pool'
import type { ServerDeps } from '@/sdk/handlers/servers'
import type { McpTools } from '@/sdk/mcp'
import { AgentConfigService } from '@/services/agent-config-service'
import { AgentFactory } from '@/services/agent-factory'
import { AgentFilesystemService } from '@/services/agent-filesystem-service'
import { AgentService } from '@/services/agent-service'
import { HistoryCompressionService } from '@/services/history-compression-service'
import { ItemService } from '@/services/item-service'
import { LocationStorage } from '@/services/location-storage'
import { PlayerService } from '@/services/player-service'
import { RoomMappingService } from '@/services/room-mapping'
import { WorldResetService } from '@/services/world-reset-service'
import { WorldService } from '@/services/world-service'
import type { AppState } from '@/http/state'

export const ADMIN_USER_ID = 'admin'
export const GUEST_USER_ID = 'guest-000000000001'

const JWT_SECRET = 'game-routes-test-secret'

/** One recorded call to a turn implementation. */
export interface RecordedTurn {
  kind: 'gameplay' | 'chat' | 'chatRoom'
  roomId: number
  action: string
  /** Absent for `chatRoom`: a plain chat room belongs to no world. */
  worldId?: number
  chatSessionId?: number | null
  mentionedAgentIds?: number[] | null
}

export interface GameAppHarness {
  app: Hono<AppEnv>
  state: AppState
  db: Db
  dbPath: string
  worldsDir: string
  /** Every turn the routes asked the orchestrator to run, in order. */
  turns: RecordedTurn[]
  /** Agent ids the stub pool reports as busy in a room. */
  busyAgents: Map<number, number[]>
  request(path: string, init?: RequestInit & { token?: string | null }): Promise<Response>
  json<T = unknown>(path: string, init?: RequestInit & { token?: string | null }): Promise<T>
  cleanup(): void
}

/**
 * Pin the environment the app reads at import time.
 *
 * Called before `createApp` is imported. `resetSettings()` drops the cached
 * settings so the developer's own `.env` cannot supply a different `JWT_SECRET`
 * and invalidate every token this file mints.
 */
export function pinTestEnv(): void {
  process.env.JWT_SECRET = JWT_SECRET
  process.env.ENABLE_GUEST_LOGIN = 'true'
  resetSettings()
}

export async function adminToken(): Promise<string> {
  return generateJwtToken({ role: 'admin', userId: ADMIN_USER_ID })
}

export async function guestToken(): Promise<string> {
  return generateJwtToken({ role: 'guest', userId: GUEST_USER_ID })
}

export interface CreateHarnessOptions {
  /** Copy `src/tests/fixtures/worlds/` into the temp tree. Default `true`. */
  withFixtureWorld?: boolean
}

export async function createGameApp(
  options: CreateHarnessOptions = {},
): Promise<GameAppHarness> {
  pinTestEnv()

  const root = mkdtempSync(join(tmpdir(), 'cw-game-'))
  const dbPath = join(root, 'test.db')
  const worldsDir = join(root, 'worlds')

  createFixtureDb(dbPath)
  if (options.withFixtureWorld !== false) {
    cpSync(FIXTURE_WORLDS_DIR, worldsDir, { recursive: true })
  }

  const db = openDb({ path: dbPath })

  // The CRUD cache is a module-level singleton keyed by room id, and every
  // harness reuses room id 1 against a *different* database. Without this, one
  // test's room membership is served to the next one's poll.
  getCache().clear()

  const services: GameplayServices = {
    worlds: new WorldService(worldsDir),
    players: new PlayerService(worldsDir),
    locations: new LocationStorage(worldsDir),
    rooms: new RoomMappingService(worldsDir),
  }

  const turns: RecordedTurn[] = []
  const busyAgents = new Map<number, number[]>()

  // Only the two methods `RoomOrchestrator` actually calls on the pool are
  // implemented. Anything else reaching for the pool in a route is a bug this
  // harness should surface as a TypeError rather than hide behind a mock.
  const pool = {
    interruptRoom: (): Promise<string[]> => Promise.resolve([]),
    agentsInRoom: (roomId: number): number[] => busyAgents.get(roomId) ?? [],
    evictRoom: (): Promise<void> => Promise.resolve(),
    // Needed by the agent- and room-agent delete routes, which evict an agent's
    // sessions by key. No session is ever opened here, so there is nothing to
    // return and nothing to evict — but the methods have to exist, or the
    // deletion path throws a TypeError instead of doing the cleanup.
    keysForAgent: (): string[] => [],
    evict: (): Promise<void> => Promise.resolve(),
    // `GET /auth/health/pool` reads this. Fixed numbers rather than a real
    // pool: what the route can get wrong is the camelCase-to-snake_case
    // rename, and distinct values per field are what catch a crossed pair.
    stats: () => ({
      poolSize: 3,
      poolKeys: ['room_1_agent_1', 'room_1_agent_2', 'room_2_agent_1'],
      pendingCleanupTasks: 0,
      activeClients: 1,
      connectionSemaphoreAvailable: 7,
      maxConcurrentConnections: 10,
    }),
  } as unknown as SessionPool

  const serverDeps = {
    players: services.players,
    rooms: services.rooms,
    locations: services.locations,
    onNarrationProduced: () => {},
  } as unknown as ServerDeps

  // Same convention as `pool` above: nothing is implemented, because the turns
  // are stubbed and nothing in a route reaches the MCP surface. A route that
  // starts to should surface as a TypeError, not be absorbed by a mock — and it
  // spares every route test a loopback listener it would never call.
  const mcp = {} as unknown as McpTools

  const orchestrator = new RoomOrchestrator({
    db,
    pool,
    services,
    serverDeps,
    mcp,
    projectRoot: root,
    turns: {
      gameplay: (_deps, input) => {
        turns.push({
          kind: 'gameplay',
          roomId: input.roomId,
          action: input.action,
          worldId: input.world.id,
        })
        return Promise.resolve(emptyResult())
      },
      chat: (_deps, input) => {
        turns.push({
          kind: 'chat',
          roomId: input.roomId,
          action: input.action,
          worldId: input.world.id,
          chatSessionId: input.chatSessionId,
        })
        return Promise.resolve(emptyResult())
      },
      chatRoom: (_deps, input) => {
        // No `worldId`: a plain chat room has none, which is the whole point of
        // this turn kind. Tests assert on the absence.
        turns.push({
          kind: 'chatRoom',
          roomId: input.roomId,
          action: input.action,
          mentionedAgentIds: input.mentionedAgentIds ?? null,
        })
        return Promise.resolve(emptyResult())
      },
    },
  })

  const state: AppState = {
    db,
    pool,
    orchestrator,
    // Real instances, not stubs: both are pure in-memory bookkeeping with no
    // I/O, and the SSE route tests drive them directly.
    broadcaster: new EventBroadcaster(),
    liveStreams: new LiveStreamRegistry(),
    tickets: new SSETicketManager(),
    services,
    serverDeps,
    mcp,
    agents: new AgentService(pool, orchestrator),
    agentFiles: new AgentFilesystemService(worldsDir),
    agentFactory: new AgentFactory(new AgentConfigService(root)),
    items: new ItemService(worldsDir),
    // A summarizer that always declines. The compression *logic* is covered by
    // `history-compression.test.ts` with its own stub; what the route tests
    // need is a service that neither reaches a model nor pretends to succeed.
    history: new HistoryCompressionService(
      () => Promise.resolve(null),
      worldsDir,
      new AgentConfigService(root),
    ),
    reset: new WorldResetService(worldsDir),
    // Constructed but never started, exactly as `createAppState` leaves it. A
    // route test must not have a timer firing autonomous rounds at its rooms,
    // but the field has to exist or `createApp` is being handed a shape the
    // real one does not have.
    scheduler: new BackgroundScheduler({ db, orchestrator, maxConcurrentRooms: 5 }),
    projectRoot: root,
    shutdown: () => Promise.resolve(),
  }

  const { createApp } = await import('@/http/app')
  const app = createApp(state)

  const token = await adminToken()

  async function request(
    path: string,
    init: RequestInit & { token?: string | null } = {},
  ): Promise<Response> {
    const { token: override, ...rest } = init
    const headers = new Headers(rest.headers)
    // `null` means "send no token", which is how the 401 cases are written.
    const apiKey = override === undefined ? token : override
    if (apiKey !== null) headers.set('x-api-key', apiKey)
    if (rest.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    return app.request(path, { ...rest, headers })
  }

  return {
    app,
    state,
    db,
    dbPath,
    worldsDir,
    turns,
    busyAgents,
    request,
    async json<T>(path: string, init?: RequestInit & { token?: string | null }): Promise<T> {
      return (await (await request(path, init)).json()) as T
    },
    cleanup() {
      db.$client.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** A background turn is fire-and-forget; give the macrotask queue a chance. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** Read a column back through raw SQL, bypassing the Drizzle decoders. */
export function rawQuery<T>(dbPath: string, sql: string): T[] {
  const raw = new Database(dbPath)
  try {
    return raw.query<T, []>(sql).all()
  } finally {
    raw.close()
  }
}

/** Run a statement against the fixture database, for setup outside the CRUD surface. */
export function rawExec(dbPath: string, sql: string): void {
  const raw = new Database(dbPath)
  try {
    raw.exec(sql)
  } finally {
    raw.close()
  }
}

/** Insert a row and return its id, for fixtures outside the CRUD surface. */
export function rawInsert(
  dbPath: string,
  sql: string,
  params: (string | number | null)[] = [],
): number {
  const raw = new Database(dbPath)
  try {
    raw.query(sql).run(...params)
    return Number(raw.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id)
  } finally {
    raw.close()
  }
}

function emptyResult(): ExecutionResult {
  return {
    totalResponses: 0,
    totalSkips: 0,
    cellsExecuted: 0,
    wasInterrupted: false,
    wasPaused: false,
    reachedLimit: false,
    allSkipped: false,
    reactions: [],
  }
}

// ---------------------------------------------------------------------------
// Fixture database
//
// `SCHEMA_SQL` is a verbatim `.schema` dump from a Python-written database at
// Alembic head e872d9c86c83; `SEED_SQL` is the world the game routes are tested
// against — world 1 "asdf", owned by `admin`, in the onboarding phase, with its
// onboarding room 1 holding three messages and the Onboarding Manager.
//
// It matches `src/tests/fixtures/worlds/asdf/` on disk, which is what makes the
// filesystem-is-source-of-truth paths meaningful here.
// ---------------------------------------------------------------------------

export function createFixtureDb(path: string): void {
  const raw = new Database(path, { create: true })
  try {
    raw.exec(SCHEMA_SQL)
    raw.exec(SEED_SQL)
  } finally {
    raw.close()
  }
}

/** Where `createFixtureDb` expects the fixture worlds to be copied from. */
export const FIXTURE_WORLDS_DIR = join(dirname(import.meta.dir), 'fixtures', 'worlds')

const SCHEMA_SQL = `
CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL,
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
CREATE TABLE agents (
	id INTEGER NOT NULL,
	name VARCHAR NOT NULL,
	world_name VARCHAR,
	"group" VARCHAR,
	config_file VARCHAR,
	profile_pic TEXT,
	in_a_nutshell TEXT,
	characteristics TEXT,
	recent_events TEXT,
	system_prompt TEXT NOT NULL,
	interrupt_every_turn BOOLEAN,
	priority INTEGER,
	transparent BOOLEAN,
	created_at DATETIME,
	PRIMARY KEY (id)
);
CREATE INDEX ix_agents_group ON agents ("group");
CREATE INDEX ix_agents_id ON agents (id);
CREATE INDEX ix_agents_name ON agents (name);
CREATE INDEX ix_agents_world_name ON agents (world_name);
CREATE UNIQUE INDEX ux_agents_name_world ON agents (name, world_name);
CREATE TABLE rooms (
	id INTEGER NOT NULL,
	owner_id VARCHAR,
	name VARCHAR NOT NULL,
	max_interactions INTEGER,
	is_paused BOOLEAN DEFAULT 0,
	is_finished BOOLEAN DEFAULT 0,
	created_at DATETIME,
	last_activity_at DATETIME,
	last_read_at DATETIME,
	world_id INTEGER,
	PRIMARY KEY (id),
	FOREIGN KEY(world_id) REFERENCES worlds (id) ON DELETE CASCADE
);
CREATE INDEX ix_rooms_id ON rooms (id);
CREATE INDEX ix_rooms_last_activity_at ON rooms (last_activity_at);
CREATE INDEX ix_rooms_name ON rooms (name);
CREATE INDEX ix_rooms_owner_id ON rooms (owner_id);
CREATE INDEX ix_rooms_world_id ON rooms (world_id);
CREATE UNIQUE INDEX ux_rooms_owner_name_world ON rooms (owner_id, name, world_id);
CREATE TABLE worlds (
	id INTEGER NOT NULL,
	name VARCHAR NOT NULL,
	owner_id VARCHAR,
	user_name VARCHAR,
	language VARCHAR(2),
	phase VARCHAR(10),
	genre VARCHAR,
	theme VARCHAR,
	stat_definitions TEXT,
	onboarding_room_id INTEGER,
	created_at DATETIME,
	updated_at DATETIME,
	last_played_at DATETIME,
	PRIMARY KEY (id),
	FOREIGN KEY(onboarding_room_id) REFERENCES rooms (id) ON DELETE SET NULL
);
CREATE INDEX ix_worlds_id ON worlds (id);
CREATE INDEX ix_worlds_name ON worlds (name);
CREATE INDEX ix_worlds_owner_id ON worlds (owner_id);
CREATE UNIQUE INDEX ux_worlds_owner_name ON worlds (owner_id, name);
CREATE TABLE locations (
	id INTEGER NOT NULL,
	world_id INTEGER NOT NULL,
	name VARCHAR NOT NULL,
	display_name VARCHAR,
	description TEXT,
	label VARCHAR,
	position_x INTEGER,
	position_y INTEGER,
	adjacent_locations TEXT,
	room_id INTEGER,
	is_current BOOLEAN,
	is_discovered BOOLEAN,
	is_draft BOOLEAN,
	PRIMARY KEY (id),
	FOREIGN KEY(room_id) REFERENCES rooms (id) ON DELETE SET NULL,
	FOREIGN KEY(world_id) REFERENCES worlds (id) ON DELETE CASCADE
);
CREATE INDEX ix_location_world ON locations (world_id);
CREATE INDEX ix_locations_id ON locations (id);
CREATE TABLE messages (
	id INTEGER NOT NULL,
	room_id INTEGER NOT NULL,
	agent_id INTEGER,
	content TEXT NOT NULL,
	role VARCHAR(9) NOT NULL,
	participant_type VARCHAR,
	participant_name VARCHAR,
	thinking TEXT,
	anthropic_calls TEXT,
	timestamp DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	image_data TEXT,
	image_media_type VARCHAR,
	images TEXT,
	chat_session_id INTEGER,
	game_time_snapshot TEXT,
	PRIMARY KEY (id),
	FOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE SET NULL,
	FOREIGN KEY(room_id) REFERENCES rooms (id) ON DELETE CASCADE
);
CREATE INDEX idx_message_agent_id ON messages (agent_id);
CREATE INDEX idx_message_chat_session ON messages (room_id, chat_session_id);
CREATE INDEX idx_message_room_id ON messages (room_id);
CREATE INDEX idx_message_room_timestamp ON messages (room_id, timestamp);
CREATE INDEX ix_messages_chat_session_id ON messages (chat_session_id);
CREATE INDEX ix_messages_id ON messages (id);
CREATE TABLE room_agent_sessions (
	room_id INTEGER NOT NULL,
	agent_id INTEGER NOT NULL,
	session_id VARCHAR NOT NULL,
	updated_at DATETIME,
	PRIMARY KEY (room_id, agent_id),
	FOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE,
	FOREIGN KEY(room_id) REFERENCES rooms (id) ON DELETE CASCADE
);
CREATE TABLE room_agents (
	room_id INTEGER NOT NULL,
	agent_id INTEGER NOT NULL,
	joined_at DATETIME,
	PRIMARY KEY (room_id, agent_id),
	FOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE,
	FOREIGN KEY(room_id) REFERENCES rooms (id) ON DELETE CASCADE
);
CREATE TABLE player_states (
	id INTEGER NOT NULL,
	world_id INTEGER NOT NULL,
	current_location_id INTEGER,
	turn_count INTEGER,
	stats TEXT,
	inventory TEXT,
	effects TEXT,
	action_history TEXT,
	is_chat_mode BOOLEAN,
	chat_mode_start_message_id INTEGER,
	chat_session_id INTEGER,
	PRIMARY KEY (id),
	FOREIGN KEY(current_location_id) REFERENCES locations (id) ON DELETE SET NULL,
	FOREIGN KEY(world_id) REFERENCES worlds (id) ON DELETE CASCADE,
	UNIQUE (world_id)
);
CREATE INDEX ix_player_states_id ON player_states (id);
`

const SEED_SQL = `
INSERT INTO alembic_version (version_num) VALUES ('e872d9c86c83');

INSERT INTO agents (id, name, world_name, "group", config_file, system_prompt, interrupt_every_turn, priority, transparent, created_at) VALUES
  (1, 'Onboarding_Manager', NULL, 'gameplay', 'agents/group_gameplay/Onboarding_Manager', 'prompt', 0, 5, 0, '2026-08-06 04:08:41.398158'),
  (2, 'Action_Manager', NULL, 'gameplay', 'agents/group_gameplay/Action_Manager', 'prompt', 0, 5, 0, '2026-08-06 04:08:41.402597'),
  (3, 'Narrator', NULL, 'gameplay', 'agents/group_gameplay/Narrator', 'prompt', 0, 5, 0, '2026-08-06 04:08:41.405000'),
  (4, 'Chat_Summarizer', NULL, 'gameplay', 'agents/group_gameplay/Chat_Summarizer', 'prompt', 0, 5, 0, '2026-08-06 04:08:41.408570');

INSERT INTO rooms (id, owner_id, name, max_interactions, is_paused, is_finished, created_at, last_activity_at, last_read_at, world_id) VALUES
  (1, 'admin', 'Onboarding: asdf', NULL, 0, 0, '2026-08-06 04:14:54.924546', '2026-08-06 04:15:04.244761', NULL, 1);

INSERT INTO worlds (id, name, owner_id, user_name, language, phase, onboarding_room_id, created_at, updated_at, last_played_at) VALUES
  (1, 'asdf', 'admin', '손님', 'ko', 'onboarding', 1, '2026-08-06 04:14:54.931812', '2026-08-06 04:14:54.931817', NULL);

INSERT INTO messages (id, room_id, agent_id, content, role, participant_type, participant_name, timestamp) VALUES
  (1, 1, NULL, '손님이 오셨습니다. 온보딩을 시작해주세요.', 'user', 'system', 'System', '2026-08-06 04:14:54.955085'),
  (2, 1, 1, '반갑습니다.', 'assistant', NULL, NULL, '2026-08-06 04:15:04.245555'),
  (3, 1, 1, '(무시함)', 'assistant', NULL, NULL, '2026-08-21 05:42:30.444034');

INSERT INTO room_agents (room_id, agent_id, joined_at) VALUES (1, 1, '2026-08-06 04:14:54.949033');

INSERT INTO player_states (id, world_id, current_location_id, turn_count, stats, inventory, effects, action_history, is_chat_mode, chat_mode_start_message_id, chat_session_id) VALUES
  (1, 1, NULL, 0, '{}', '[]', '[]', '[]', 0, NULL, NULL);
`
