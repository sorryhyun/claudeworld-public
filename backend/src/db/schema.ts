import { relations } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'
import { sqlaDateTime } from './columns'

/**
 * Drizzle mirror of a schema that already exists, not a proposal for one: an
 * untouched `claudeworld.db` must keep opening, so every name, nullability,
 * default and index here is transcribed from the live DDL rather than chosen.
 * Booleans are INTEGER, enums VARCHAR(n) and datetimes TEXT for that reason.
 */

// An enum column is a plain VARCHAR on SQLite — the values are enforced by the
// application, not the database. These unions restore that at compile time.
export const WORLD_PHASES = ['onboarding', 'active', 'ended'] as const
export type WorldPhase = (typeof WORLD_PHASES)[number]

export const LANGUAGES = ['en', 'ko', 'jp'] as const
export type Language = (typeof LANGUAGES)[number]

export const MESSAGE_ROLES = ['user', 'assistant'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

export const agents = sqliteTable(
  'agents',
  {
    id: integer('id').primaryKey({ autoIncrement: false }),
    name: text('name').notNull(),
    // NULL marks a system agent (Action_Manager and friends), shared by every
    // world; a non-NULL value scopes the agent to one world's cast.
    worldName: text('world_name'),
    group: text('group'),
    configFile: text('config_file'),
    profilePic: text('profile_pic'),
    inANutshell: text('in_a_nutshell'),
    characteristics: text('characteristics'),
    recentEvents: text('recent_events'),
    systemPrompt: text('system_prompt').notNull(),
    interruptEveryTurn: integer('interrupt_every_turn', { mode: 'boolean' }),
    priority: integer('priority'),
    transparent: integer('transparent', { mode: 'boolean' }),
    createdAt: sqlaDateTime('created_at'),
  },
  (t) => [
    index('ix_agents_id').on(t.id),
    index('ix_agents_name').on(t.name),
    index('ix_agents_world_name').on(t.worldName),
    index('ix_agents_group').on(t.group),
    uniqueIndex('ux_agents_name_world').on(t.name, t.worldName),
  ],
)

export const rooms = sqliteTable(
  'rooms',
  {
    id: integer('id').primaryKey({ autoIncrement: false }),
    ownerId: text('owner_id'),
    name: text('name').notNull(),
    maxInteractions: integer('max_interactions'),
    // The only booleans with a *server* default. Written as SQL `0` rather than
    // `false`: both evaluate the same, but the DDL text is what the drift gate
    // compares.
    isPaused: integer('is_paused', { mode: 'boolean' }).default(sql`0`),
    isFinished: integer('is_finished', { mode: 'boolean' }).default(sql`0`),
    createdAt: sqlaDateTime('created_at'),
    lastActivityAt: sqlaDateTime('last_activity_at'),
    lastReadAt: sqlaDateTime('last_read_at'),
    worldId: integer('world_id').references((): AnySQLiteColumn => worlds.id, {
      onDelete: 'cascade',
    }),
  },
  (t) => [
    index('ix_rooms_id').on(t.id),
    index('ix_rooms_name').on(t.name),
    index('ix_rooms_owner_id').on(t.ownerId),
    index('ix_rooms_last_activity_at').on(t.lastActivityAt),
    index('ix_rooms_world_id').on(t.worldId),
    // NULL world_id compares distinct in SQLite, which is what lets chat-mode
    // rooms share a name across worlds without tripping this constraint.
    uniqueIndex('ux_rooms_owner_name_world').on(t.ownerId, t.name, t.worldId),
  ],
)

export const worlds = sqliteTable(
  'worlds',
  {
    id: integer('id').primaryKey({ autoIncrement: false }),
    name: text('name').notNull(),
    ownerId: text('owner_id'),
    userName: text('user_name'),
    language: text('language', { length: 2 }).$type<Language>(),
    phase: text('phase', { length: 10 }).$type<WorldPhase>(),
    genre: text('genre'),
    theme: text('theme'),
    statDefinitions: text('stat_definitions'),
    onboardingRoomId: integer('onboarding_room_id').references((): AnySQLiteColumn => rooms.id, {
      onDelete: 'set null',
    }),
    createdAt: sqlaDateTime('created_at'),
    updatedAt: sqlaDateTime('updated_at'),
    lastPlayedAt: sqlaDateTime('last_played_at'),
  },
  (t) => [
    index('ix_worlds_id').on(t.id),
    index('ix_worlds_name').on(t.name),
    index('ix_worlds_owner_id').on(t.ownerId),
    uniqueIndex('ux_worlds_owner_name').on(t.ownerId, t.name),
  ],
)

export const locations = sqliteTable(
  'locations',
  {
    id: integer('id').primaryKey({ autoIncrement: false }),
    worldId: integer('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    displayName: text('display_name'),
    description: text('description'),
    label: text('label'),
    // `$defaultFn`, not `.default()`: existing databases have no DEFAULT clause
    // here, and `.default()` would emit one and diverge a fresh install from
    // every database already on disk.
    positionX: integer('position_x').$defaultFn(() => 0),
    positionY: integer('position_y').$defaultFn(() => 0),
    // JSON array of location ids, as raw text: NULL, '' and '[]' all occur here
    // and callers already branch on that.
    adjacentLocations: text('adjacent_locations'),
    roomId: integer('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    isCurrent: integer('is_current', { mode: 'boolean' }).$defaultFn(() => false),
    isDiscovered: integer('is_discovered', { mode: 'boolean' }).$defaultFn(() => true),
    isDraft: integer('is_draft', { mode: 'boolean' }).$defaultFn(() => false),
  },
  (t) => [index('ix_locations_id').on(t.id), index('ix_location_world').on(t.worldId)],
)

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: false }),
    roomId: integer('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    content: text('content').notNull(),
    role: text('role', { length: 9 }).$type<MessageRole>().notNull(),
    participantType: text('participant_type'),
    participantName: text('participant_name'),
    thinking: text('thinking'),
    anthropicCalls: text('anthropic_calls'),
    // The only non-boolean column with a server-side default. Every insert
    // passes a value, so it fires for hand-written SQL only — but it is DDL.
    timestamp: sqlaDateTime('timestamp').notNull().default(sql`CURRENT_TIMESTAMP`),
    imageData: text('image_data'),
    imageMediaType: text('image_media_type'),
    images: text('images'),
    chatSessionId: integer('chat_session_id'),
    gameTimeSnapshot: text('game_time_snapshot'),
  },
  (t) => [
    index('ix_messages_id').on(t.id),
    index('ix_messages_chat_session_id').on(t.chatSessionId),
    index('idx_message_room_id').on(t.roomId),
    index('idx_message_agent_id').on(t.agentId),
    index('idx_message_room_timestamp').on(t.roomId, t.timestamp),
    index('idx_message_chat_session').on(t.roomId, t.chatSessionId),
  ],
)

export const roomAgents = sqliteTable(
  'room_agents',
  {
    roomId: integer('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    joinedAt: sqlaDateTime('joined_at'),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.agentId] })],
)

export const roomAgentSessions = sqliteTable(
  'room_agent_sessions',
  {
    roomId: integer('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // The Claude Agent SDK session id for this room/agent pair — what makes a
    // conversation resumable across process restarts.
    sessionId: text('session_id').notNull(),
    updatedAt: sqlaDateTime('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.agentId] })],
)

export const playerStates = sqliteTable(
  'player_states',
  {
    id: integer('id').primaryKey({ autoIncrement: false }),
    worldId: integer('world_id')
      .notNull()
      .unique()
      .references(() => worlds.id, { onDelete: 'cascade' }),
    currentLocationId: integer('current_location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    turnCount: integer('turn_count').$defaultFn(() => 0),
    stats: text('stats'),
    inventory: text('inventory'),
    effects: text('effects'),
    actionHistory: text('action_history'),
    isChatMode: integer('is_chat_mode', { mode: 'boolean' }).$defaultFn(() => false),
    chatModeStartMessageId: integer('chat_mode_start_message_id'),
    chatSessionId: integer('chat_session_id'),
  },
  (t) => [index('ix_player_states_id').on(t.id)],
)

/** Alembic's bookkeeping table: stamped on a fresh install, never written to. */
export const alembicVersion = sqliteTable('alembic_version', {
  versionNum: text('version_num', { length: 32 }).primaryKey(),
})

export const worldsRelations = relations(worlds, ({ many, one }) => ({
  locations: many(locations),
  rooms: many(rooms, { relationName: 'worldRooms' }),
  playerState: one(playerStates),
  onboardingRoom: one(rooms, {
    fields: [worlds.onboardingRoomId],
    references: [rooms.id],
    relationName: 'onboardingRoom',
  }),
}))

export const roomsRelations = relations(rooms, ({ many, one }) => ({
  messages: many(messages),
  agentSessions: many(roomAgentSessions),
  roomAgents: many(roomAgents),
  world: one(worlds, {
    fields: [rooms.worldId],
    references: [worlds.id],
    relationName: 'worldRooms',
  }),
}))

export const agentsRelations = relations(agents, ({ many }) => ({
  messages: many(messages),
  roomAgents: many(roomAgents),
  roomSessions: many(roomAgentSessions),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  room: one(rooms, { fields: [messages.roomId], references: [rooms.id] }),
  agent: one(agents, { fields: [messages.agentId], references: [agents.id] }),
}))

export const locationsRelations = relations(locations, ({ one }) => ({
  world: one(worlds, { fields: [locations.worldId], references: [worlds.id] }),
  room: one(rooms, { fields: [locations.roomId], references: [rooms.id] }),
}))

export const playerStatesRelations = relations(playerStates, ({ one }) => ({
  world: one(worlds, { fields: [playerStates.worldId], references: [worlds.id] }),
  currentLocation: one(locations, {
    fields: [playerStates.currentLocationId],
    references: [locations.id],
  }),
}))

export const roomAgentsRelations = relations(roomAgents, ({ one }) => ({
  room: one(rooms, { fields: [roomAgents.roomId], references: [rooms.id] }),
  agent: one(agents, { fields: [roomAgents.agentId], references: [agents.id] }),
}))

export const roomAgentSessionsRelations = relations(roomAgentSessions, ({ one }) => ({
  room: one(rooms, { fields: [roomAgentSessions.roomId], references: [rooms.id] }),
  agent: one(agents, { fields: [roomAgentSessions.agentId], references: [agents.id] }),
}))

export type Agent = typeof agents.$inferSelect
export type Room = typeof rooms.$inferSelect
export type World = typeof worlds.$inferSelect
export type Location = typeof locations.$inferSelect
export type Message = typeof messages.$inferSelect
export type PlayerState = typeof playerStates.$inferSelect
export type NewMessage = typeof messages.$inferInsert
