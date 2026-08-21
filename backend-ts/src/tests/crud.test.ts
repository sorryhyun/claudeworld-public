/**
 * CRUD parity tests.
 *
 * Each test gets a throwaway database built from `SCHEMA_SQL` below, which is a
 * verbatim `.schema` dump of a real Python-written `claudeworld.db` at Alembic
 * head `e872d9c86c83` — not DDL generated from the Drizzle definitions. That
 * distinction is the whole point: the contract under test is "these functions
 * read and write a database SQLAlchemy produced", and generating the schema
 * from the same source as the code under test would excuse any drift.
 *
 * The dump is inlined rather than referenced as a fixture file so the suite has
 * no dependency on a scratch database that may not exist on another machine.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../db'
import {
  addActionToHistory,
  addAgentToRoom,
  addGameplayAgentsToRoom,
  createMessage,
  getAgent,
  getAgentByName,
  getAgentsInRoom,
  getCharactersAtLocation,
  getLocation,
  getLocations,
  getMessagesAfterAgentResponse,
  getPlayerState,
  getRoom,
  getRoomAgentSession,
  getWorld,
  getWorldByName,
  incrementTurn,
  updateRoomAgentSession,
  updateWorldLastPlayed,
} from '../crud'
import type { GameTimeSnapshot } from '../crud'

// Fixture contents, asserted on below. World 1 "asdf" owns room 1
// ("Onboarding: asdf") with three messages; agent 1 Onboarding_Manager is its
// only member. Agents 1-4 are group "gameplay", 5-8 are "subagent". There are
// no locations and no Narrator agent — which is why the gameplay-agent tests
// expect a count of 1 rather than 2.
const WORLD_ID = 1
const ROOM_ID = 1
const ONBOARDING_MANAGER_ID = 1
const ACTION_MANAGER_ID = 2

let dir: string
let dbPath: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-crud-'))
  dbPath = join(dir, 'test.db')
  createFixtureDb(dbPath)
  db = openDb({ path: dbPath })
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Read a column back through raw SQL, bypassing the Drizzle decoders. */
function rawValue<T>(sql: string): T {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const row = raw.query<Record<string, T>, []>(sql).get()
    if (!row) throw new Error(`no row for: ${sql}`)
    return Object.values(row)[0] as T
  } finally {
    raw.close()
  }
}

describe('worlds', () => {
  test('getWorld returns the world with its relationships', () => {
    const world = getWorld(db, WORLD_ID)
    expect(world).not.toBeNull()
    expect(world!.name).toBe('asdf')
    expect(world!.ownerId).toBe('admin')
    expect(world!.phase).toBe('onboarding')
    expect(world!.locations).toEqual([])
    expect(world!.onboardingRoom?.id).toBe(ROOM_ID)
    expect(world!.playerState?.turnCount).toBe(0)
    // No current_location_id in the fixture, so the LEFT JOIN must not drop the
    // player state row.
    expect(world!.playerState?.currentLocation).toBeNull()
  })

  test('getWorld returns null for an unknown id', () => {
    expect(getWorld(db, 9999)).toBeNull()
  })

  test('getWorldByName matches with and without an owner', () => {
    expect(getWorldByName(db, 'asdf')?.id).toBe(WORLD_ID)
    expect(getWorldByName(db, 'asdf', 'admin')?.id).toBe(WORLD_ID)
    expect(getWorldByName(db, 'asdf', 'someone-else')).toBeNull()
    expect(getWorldByName(db, 'nope')).toBeNull()
  })

  test('updateWorldLastPlayed writes SQLAlchemy-formatted text', () => {
    expect(getWorld(db, WORLD_ID)!.lastPlayedAt).toBeNull()

    const before = Date.now()
    updateWorldLastPlayed(db, WORLD_ID)

    const stored = rawValue<string>(`SELECT last_played_at FROM worlds WHERE id = ${WORLD_ID}`)
    // The exact shape matters: Python reads this column with SQLAlchemy's
    // parser, which expects space-separated, microsecond-padded, offset-free text.
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/)

    const roundTripped = getWorld(db, WORLD_ID)!.lastPlayedAt!
    expect(roundTripped).toBeInstanceOf(Date)
    expect(roundTripped.getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  test('updateWorldLastPlayed is a no-op for an unknown world', () => {
    expect(() => updateWorldLastPlayed(db, 9999)).not.toThrow()
  })
})

describe('rooms and membership', () => {
  test('getRoom loads agents, messages and world', () => {
    const room = getRoom(db, ROOM_ID)
    expect(room).not.toBeNull()
    expect(room!.name).toBe('Onboarding: asdf')
    expect(room!.world?.id).toBe(WORLD_ID)
    expect(room!.agents.map((a) => a.id)).toEqual([ONBOARDING_MANAGER_ID])
    expect(room!.messages.map((m) => m.id)).toEqual([1, 2, 3])
    // Booleans decode as booleans, not 0/1.
    expect(room!.isPaused).toBe(false)
    expect(room!.createdAt).toBeInstanceOf(Date)
  })

  test('getRoom returns null for an unknown id', () => {
    expect(getRoom(db, 9999)).toBeNull()
  })

  test('getAgentsInRoom returns only members', () => {
    expect(getAgentsInRoom(db, ROOM_ID).map((a) => a.name)).toEqual(['Onboarding_Manager'])
    expect(getAgentsInRoom(db, 9999)).toEqual([])
  })

  test('addAgentToRoom inserts once and announces the arrival', () => {
    const room = addAgentToRoom(db, ROOM_ID, ACTION_MANAGER_ID)
    expect(room?.id).toBe(ROOM_ID)
    expect(getAgentsInRoom(db, ROOM_ID).map((a) => a.id).sort()).toEqual([
      ONBOARDING_MANAGER_ID,
      ACTION_MANAGER_ID,
    ])

    // The room already had messages, so this is a mid-conversation addition and
    // gets a system notice.
    const notice = getRoom(db, ROOM_ID)!.messages.at(-1)!
    expect(notice.content).toBe('Action_Manager joined the chat')
    expect(notice.participantType).toBe('system')
    expect(notice.role).toBe('assistant')

    // joined_at must be present — getMessagesAfterAgentResponse relies on it.
    const joinedAt = rawValue<string>(
      `SELECT joined_at FROM room_agents WHERE room_id = ${ROOM_ID} AND agent_id = ${ACTION_MANAGER_ID}`,
    )
    expect(joinedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/)
  })

  test('addAgentToRoom is idempotent and still returns the room', () => {
    const before = getRoom(db, ROOM_ID)!.messages.length
    const again = addAgentToRoom(db, ROOM_ID, ONBOARDING_MANAGER_ID)

    // Python returns the room even when nothing was inserted; addGameplayAgents
    // counts on that truthiness.
    expect(again?.id).toBe(ROOM_ID)
    expect(getAgentsInRoom(db, ROOM_ID)).toHaveLength(1)
    expect(getRoom(db, ROOM_ID)!.messages).toHaveLength(before)
  })

  test('addAgentToRoom returns null when the room or agent is missing', () => {
    expect(addAgentToRoom(db, 9999, ONBOARDING_MANAGER_ID)).toBeNull()
    expect(addAgentToRoom(db, ROOM_ID, 9999)).toBeNull()
  })

  test('addGameplayAgentsToRoom is idempotent', () => {
    // Only Action_Manager exists in the fixture; Narrator does not, so the
    // count is 1 rather than 2.
    expect(addGameplayAgentsToRoom(db, ROOM_ID)).toBe(1)
    expect(getAgentsInRoom(db, ROOM_ID).map((a) => a.id).sort()).toEqual([
      ONBOARDING_MANAGER_ID,
      ACTION_MANAGER_ID,
    ])

    // Second call: still 1, because Python counts "agent resolvable", not
    // "agent newly inserted" — and no duplicate row appears.
    expect(addGameplayAgentsToRoom(db, ROOM_ID)).toBe(1)
    expect(getAgentsInRoom(db, ROOM_ID)).toHaveLength(2)
  })
})

describe('agents', () => {
  test('getAgent by id', () => {
    const agent = getAgent(db, ACTION_MANAGER_ID)
    expect(agent?.name).toBe('Action_Manager')
    expect(agent?.group).toBe('gameplay')
    // System agents have a NULL world_name.
    expect(agent?.worldName).toBeNull()
    expect(getAgent(db, 9999)).toBeNull()
  })

  test('getAgentByName tries underscore and space spellings', () => {
    expect(getAgentByName(db, 'Action_Manager')?.id).toBe(ACTION_MANAGER_ID)
    // Stored with an underscore; the space spelling must still resolve.
    expect(getAgentByName(db, 'Action Manager')?.id).toBe(ACTION_MANAGER_ID)
    expect(getAgentByName(db, 'No_Such_Agent')).toBeNull()
  })

  test('getAgentByName filters by world when one is given', () => {
    // Every fixture agent is a system agent (world_name NULL), and SQL equality
    // never matches NULL — so naming a world finds nothing, exactly as Python.
    expect(getAgentByName(db, 'Action_Manager', 'asdf')).toBeNull()
  })
})

describe('locations', () => {
  test('empty world has no locations', () => {
    expect(getLocations(db, WORLD_ID)).toEqual([])
    expect(getLocation(db, 1)).toBeNull()
    expect(getCharactersAtLocation(db, 1)).toEqual([])
  })

  test('getCharactersAtLocation excludes system agents by default', () => {
    const locationId = seedLocation()

    // Onboarding_Manager (group "gameplay") is already in the room and must be
    // filtered out; the seeded NPC has no group and must survive.
    const npcId = seedAgent('Village Elder', null)
    addAgentToRoom(db, ROOM_ID, npcId)

    expect(getCharactersAtLocation(db, locationId).map((a) => a.name)).toEqual(['Village Elder'])
    expect(getCharactersAtLocation(db, locationId, { excludeSystemAgents: false }).map((a) => a.id).sort()).toEqual(
      [ONBOARDING_MANAGER_ID, npcId].sort(),
    )
  })

  test('getLocation resolves the backing room', () => {
    const locationId = seedLocation()
    const location = getLocation(db, locationId)
    expect(location?.name).toBe('village')
    expect(location?.room?.id).toBe(ROOM_ID)
    expect(location?.isDiscovered).toBe(true)
    expect(getLocations(db, WORLD_ID).map((l) => l.id)).toEqual([locationId])
  })
})

describe('player state', () => {
  test('getPlayerState returns the row for a world', () => {
    const state = getPlayerState(db, WORLD_ID)
    expect(state?.worldId).toBe(WORLD_ID)
    expect(state?.turnCount).toBe(0)
    expect(state?.isChatMode).toBe(false)
    expect(state?.currentLocation).toBeNull()
    expect(getPlayerState(db, 9999)).toBeNull()
  })

  test('incrementTurn advances and persists', () => {
    expect(incrementTurn(db, WORLD_ID)).toBe(1)
    expect(incrementTurn(db, WORLD_ID)).toBe(2)
    expect(getPlayerState(db, WORLD_ID)?.turnCount).toBe(2)
  })

  test('incrementTurn returns 0 for a world without player state', () => {
    expect(incrementTurn(db, 9999)).toBe(0)
  })

  test('addActionToHistory appends and caps at ten entries', () => {
    for (let turn = 1; turn <= 12; turn += 1) {
      addActionToHistory(db, WORLD_ID, { turn, action: `act ${turn}`, result: `res ${turn}` })
    }

    const stored = rawValue<string>(`SELECT action_history FROM player_states WHERE world_id = ${WORLD_ID}`)
    const history = JSON.parse(stored) as Array<Record<string, unknown>>

    expect(history).toHaveLength(10)
    expect(history[0]).toEqual({ turn: 3, action: 'act 3', result: 'res 3' })
    expect(history[9]).toEqual({ turn: 12, action: 'act 12', result: 'res 12' })
  })

  test('addActionToHistory is a no-op for an unknown world', () => {
    expect(() => addActionToHistory(db, 9999, { turn: 1, action: 'a', result: 'r' })).not.toThrow()
  })
})

describe('messages', () => {
  test('createMessage auto-assigns an id and bumps room activity', () => {
    const roomBefore = getRoom(db, ROOM_ID)!

    const created = createMessage(db, ROOM_ID, {
      content: 'hello',
      role: 'user',
      participantType: 'user',
      participantName: 'Tester',
      gameTimeSnapshot: { hour: 9, minute: 30, day: 2 },
      chatSessionId: 77,
    })

    // The DDL's `INTEGER NOT NULL PRIMARY KEY` is a rowid alias, so omitting the
    // column still yields a fresh, monotonic id.
    expect(created.id).toBe(4)
    expect(created.roomId).toBe(ROOM_ID)
    expect(created.timestamp).toBeInstanceOf(Date)
    expect(created.gameTimeSnapshot).toBe('{"hour":9,"minute":30,"day":2}')

    const next = createMessage(db, ROOM_ID, { content: 'again', role: 'user' })
    expect(next.id).toBe(5)

    const activityAfter = getRoom(db, ROOM_ID)!.lastActivityAt!
    expect(activityAfter.getTime()).toBeGreaterThan(roomBefore.lastActivityAt!.getTime())

    const storedTimestamp = rawValue<string>(`SELECT timestamp FROM messages WHERE id = ${created.id}`)
    expect(storedTimestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/)
  })

  test('createMessage can leave room activity alone', () => {
    const before = getRoom(db, ROOM_ID)!.lastActivityAt!
    createMessage(db, ROOM_ID, { content: 'quiet', role: 'assistant' }, { updateRoomActivity: false })
    expect(getRoom(db, ROOM_ID)!.lastActivityAt!.getTime()).toBe(before.getTime())
  })

  test('createMessage stores empty JSON payloads as NULL', () => {
    // Python guards these with a truthiness check, where [] and {} are falsy.
    const created = createMessage(db, ROOM_ID, {
      content: 'empty',
      role: 'assistant',
      images: [],
      anthropicCalls: [],
      // Cast because the declared shape has required keys; the runtime guard is
      // what is under test, and a partly-built snapshot can reach it.
      gameTimeSnapshot: {} as GameTimeSnapshot,
    })

    expect(created.images).toBeNull()
    expect(created.anthropicCalls).toBeNull()
    expect(created.gameTimeSnapshot).toBeNull()
  })

  test('createMessage serializes images with snake_case media_type', () => {
    const created = createMessage(db, ROOM_ID, {
      content: 'pic',
      role: 'user',
      images: [{ data: 'abc', mediaType: 'image/webp' }],
    })

    // Python writes `media_type`; the frontend and the Python readers both
    // depend on that spelling.
    expect(created.images).toBe('[{"data":"abc","media_type":"image/webp"}]')
  })

  test('getMessagesAfterAgentResponse returns messages since the agent last spoke', () => {
    // Fixture: message 3 is the last from Onboarding_Manager.
    expect(getMessagesAfterAgentResponse(db, ROOM_ID, ONBOARDING_MANAGER_ID)).toEqual([])

    const fresh = createMessage(db, ROOM_ID, { content: 'player acts', role: 'user' })
    const after = getMessagesAfterAgentResponse(db, ROOM_ID, ONBOARDING_MANAGER_ID)

    expect(after.map((m) => m.id)).toEqual([fresh.id])
    expect(after[0]?.agent).toBeNull()
  })

  test('getMessagesAfterAgentResponse falls back to the join time', () => {
    // Action_Manager has never spoken here; joining now must hide the backlog.
    addAgentToRoom(db, ROOM_ID, ACTION_MANAGER_ID)

    const seen = getMessagesAfterAgentResponse(db, ROOM_ID, ACTION_MANAGER_ID)
    // Only the "joined the chat" notice, which was written after joined_at.
    expect(seen.map((m) => m.content)).toEqual(['Action_Manager joined the chat'])

    createMessage(db, ROOM_ID, { content: 'later', role: 'user' })
    expect(getMessagesAfterAgentResponse(db, ROOM_ID, ACTION_MANAGER_ID).map((m) => m.content)).toEqual([
      'Action_Manager joined the chat',
      'later',
    ])
  })

  test('getMessagesAfterAgentResponse shows everything for a non-member', () => {
    // No last message and no joined_at row: Python leaves the query unfiltered.
    const seen = getMessagesAfterAgentResponse(db, ROOM_ID, ACTION_MANAGER_ID)
    expect(seen.map((m) => m.id)).toEqual([1, 2, 3])
  })

  test('getMessagesAfterAgentResponse keeps the newest N in chronological order', () => {
    for (let i = 0; i < 5; i += 1) {
      createMessage(db, ROOM_ID, { content: `m${i}`, role: 'user' })
    }

    const seen = getMessagesAfterAgentResponse(db, ROOM_ID, ONBOARDING_MANAGER_ID, 3)
    // The limit takes the latest three, not the earliest, and hands them back
    // oldest-first. All five share a millisecond timestamp, so this also pins
    // the id tiebreaker: without it SQLite returns the tied rows in any order.
    expect(seen.map((m) => m.content)).toEqual(['m2', 'm3', 'm4'])
  })

  test('joined agent rows resolve their agent on the way out', () => {
    const spoken = createMessage(db, ROOM_ID, {
      content: 'npc line',
      role: 'assistant',
      agentId: ACTION_MANAGER_ID,
    })
    const seen = getMessagesAfterAgentResponse(db, ROOM_ID, ONBOARDING_MANAGER_ID)
    const found = seen.find((m) => m.id === spoken.id)
    expect(found?.agent?.name).toBe('Action_Manager')
  })
})

describe('room agent sessions', () => {
  test('getRoomAgentSession reads the fixture row', () => {
    expect(getRoomAgentSession(db, ROOM_ID, ONBOARDING_MANAGER_ID)).toBe(
      '6a118a99-37c7-4fc1-be82-099f9eb1e35e',
    )
    expect(getRoomAgentSession(db, ROOM_ID, ACTION_MANAGER_ID)).toBeNull()
  })

  test('updateRoomAgentSession inserts then updates in place', () => {
    const inserted = updateRoomAgentSession(db, ROOM_ID, ACTION_MANAGER_ID, 'session-a')
    expect(inserted.sessionId).toBe('session-a')
    expect(getRoomAgentSession(db, ROOM_ID, ACTION_MANAGER_ID)).toBe('session-a')

    const updated = updateRoomAgentSession(db, ROOM_ID, ACTION_MANAGER_ID, 'session-b')
    expect(updated.sessionId).toBe('session-b')

    // Upsert on the composite PK, so there must still be exactly one row.
    const count = rawValue<number>(
      `SELECT COUNT(*) FROM room_agent_sessions WHERE room_id = ${ROOM_ID} AND agent_id = ${ACTION_MANAGER_ID}`,
    )
    expect(count).toBe(1)

    const storedUpdatedAt = rawValue<string>(
      `SELECT updated_at FROM room_agent_sessions WHERE room_id = ${ROOM_ID} AND agent_id = ${ACTION_MANAGER_ID}`,
    )
    expect(storedUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/)
  })

  test('updateRoomAgentSession overwrites an existing pair', () => {
    updateRoomAgentSession(db, ROOM_ID, ONBOARDING_MANAGER_ID, 'replaced')
    expect(getRoomAgentSession(db, ROOM_ID, ONBOARDING_MANAGER_ID)).toBe('replaced')
  })
})

// ---------------------------------------------------------------------------
// Fixture. The seed rows below reproduce a real onboarding-phase database
// row for row (ids, names, groups and SQLAlchemy-formatted timestamps all
// copied from it); only the multi-kilobyte `system_prompt` bodies are replaced
// with placeholders, since nothing here reads them.
//
// The fixture has no locations, so tests that need one build it with raw SQL
// rather than through CRUD functions outside this slice's scope.
// ---------------------------------------------------------------------------

/** Verbatim `.schema` dump from a Python-written DB at Alembic head e872d9c86c83. */
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
  (3, 'History_Summarizer', NULL, 'gameplay', 'agents/group_gameplay/History_Summarizer', 'prompt', 0, 5, 0, '2026-08-06 04:08:41.405764'),
  (4, 'Chat_Summarizer', NULL, 'gameplay', 'agents/group_gameplay/Chat_Summarizer', 'prompt', 0, 5, 0, '2026-08-06 04:08:41.408570'),
  (5, 'Location_Designer', NULL, 'subagent', 'agents/group_subagent/Location_Designer', 'prompt', 0, 0, 1, '2026-08-06 04:08:41.412934'),
  (6, 'Character_Designer', NULL, 'subagent', 'agents/group_subagent/Character_Designer', 'prompt', 0, 0, 1, '2026-08-06 04:08:41.416430'),
  (7, 'Item_Designer', NULL, 'subagent', 'agents/group_subagent/Item_Designer', 'prompt', 0, 0, 1, '2026-08-06 04:08:41.419393'),
  (8, 'detailed_character_designer', NULL, 'subagent', 'agents/group_subagent/detailed_character_designer', 'prompt', 0, 0, 1, '2026-08-06 04:08:41.422074');

INSERT INTO rooms (id, owner_id, name, max_interactions, is_paused, is_finished, created_at, last_activity_at, last_read_at, world_id) VALUES
  (1, 'admin', 'Onboarding: asdf', NULL, 0, 0, '2026-08-06 04:14:54.924546', '2026-08-06 04:15:04.244761', NULL, 1);

INSERT INTO worlds (id, name, owner_id, user_name, language, phase, onboarding_room_id, created_at, updated_at, last_played_at) VALUES
  (1, 'asdf', 'admin', '손님', 'ko', 'onboarding', 1, '2026-08-06 04:14:54.931812', '2026-08-06 04:14:54.931817', NULL);

INSERT INTO messages (id, room_id, agent_id, content, role, participant_type, participant_name, timestamp) VALUES
  (1, 1, NULL, '손님이 오셨습니다. 온보딩을 시작해주세요.', 'user', 'system', 'System', '2026-08-06 04:14:54.955085'),
  (2, 1, 1, '반갑습니다.', 'assistant', NULL, NULL, '2026-08-06 04:15:04.245555'),
  (3, 1, 1, '(무시함)', 'assistant', NULL, NULL, '2026-08-21 05:42:30.444034');

INSERT INTO room_agents (room_id, agent_id, joined_at) VALUES (1, 1, '2026-08-06 04:14:54.949033');

INSERT INTO room_agent_sessions (room_id, agent_id, session_id, updated_at) VALUES
  (1, 1, '6a118a99-37c7-4fc1-be82-099f9eb1e35e', '2026-08-06 04:15:04.240454');

INSERT INTO player_states (id, world_id, current_location_id, turn_count, stats, inventory, effects, action_history, is_chat_mode, chat_mode_start_message_id, chat_session_id) VALUES
  (1, 1, NULL, 0, '{}', '[]', '[]', '[]', 0, NULL, NULL);
`

function createFixtureDb(path: string): void {
  const raw = new Database(path, { create: true })
  try {
    // Foreign keys stay off during seeding: worlds and rooms reference each
    // other, so no insert order satisfies both constraints. Python has the same
    // cycle and breaks it with a flush mid-transaction.
    raw.exec(SCHEMA_SQL)
    raw.exec(SEED_SQL)
  } finally {
    raw.close()
  }
}

function seedLocation(): number {
  const raw = new Database(dbPath)
  try {
    raw
      .query(
        `INSERT INTO locations (world_id, name, display_name, room_id, is_current, is_discovered, is_draft)
         VALUES (?, 'village', 'Village', ?, 0, 1, 0)`,
      )
      .run(WORLD_ID, ROOM_ID)
    return Number(raw.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id)
  } finally {
    raw.close()
  }
}

function seedAgent(name: string, group: string | null): number {
  const raw = new Database(dbPath)
  try {
    raw
      .query(`INSERT INTO agents (name, "group", system_prompt) VALUES (?, ?, 'prompt')`)
      .run(name, group)
    return Number(raw.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id)
  } finally {
    raw.close()
  }
}
