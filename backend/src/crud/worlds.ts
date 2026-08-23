/** CRUD operations for World entities. */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '@/db'
import {
  agents,
  locations,
  playerStates,
  rooms,
  worlds,
  WORLD_PHASES,
  type Agent,
  type Language,
  type Location,
  type Room,
  type World,
  type WorldPhase,
} from '@/db/schema'
import { invalidateRoomCache } from './cache-invalidation'
import type { PlayerStateWithLocation } from './player-state'
import { addAgentToRoom, createRoom } from './rooms'
import { toLangKey } from '@/domain/enums'
import { PlayerStateSerializer } from '@/domain/player-state-serializer'
import { getLogger } from '@/infrastructure/logging/logger'
import type { PlayerService } from '@/services/player-service'
import type { RoomMappingService } from '@/services/room-mapping'
import type { WorldConfig } from '@/services/world-service'

const logger = getLogger('WorldCRUD')

// Only the two tape participants; the designer sub-agents are dispatched
// through the SDK instead, and room membership would only add noise.
export const GAMEPLAY_AGENT_NAMES = ['Action_Manager', 'Narrator'] as const

export interface WorldWithRelations extends World {
  locations: Location[]
  playerState: PlayerStateWithLocation | null
  onboardingRoom: Room | null
}

export interface WorldCreate {
  name: string
  /** The player's display name *inside* the world, not a user id. */
  userName?: string | null
  language?: Language
}

// One transaction, because a world without a player state cannot be rendered.
// The callback keeps using `db` rather than `tx` on purpose: `bun:sqlite` has
// one connection, so {@link createRoom} joins this transaction as it stands.
export function createWorld(db: Db, world: WorldCreate, ownerId: string): WorldWithRelations {
  const onboardingRoomName = `Onboarding: ${world.name}`

  const worldId = db.transaction(() => {
    // Owner-scoped: names are unique per (owner, name, world_id), so a global
    // lookup could adopt another tenant's room as this world's.
    const existingRoom =
      db
        .select()
        .from(rooms)
        .where(and(eq(rooms.ownerId, ownerId), eq(rooms.name, onboardingRoomName)))
        .get() ?? null

    if (existingRoom) logger.info(`Reusing existing onboarding room: ${onboardingRoomName}`)
    const onboardingRoom = existingRoom ?? createRoom(db, { name: onboardingRoomName }, ownerId)

    // No SQL DEFAULT and no `$defaultFn`: omitting these writes NULLs into the
    // columns the world list sorts on.
    const now = new Date()
    const created = db
      .insert(worlds)
      .values({
        name: world.name,
        ownerId,
        userName: world.userName ?? null,
        language: world.language ?? 'en',
        phase: 'onboarding',
        onboardingRoomId: onboardingRoom.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()

    // The FK cycle (`worlds.onboarding_room_id` ↔ `rooms.world_id`) needs two
    // statements, so the reverse link is set after the insert.
    db.update(rooms).set({ worldId: created.id }).where(eq(rooms.id, onboardingRoom.id)).run()

    // Literal `"{}"` / `"[]"`, not the `jsonOrNull` convention of `messages.ts`.
    db.insert(playerStates)
      .values({
        worldId: created.id,
        turnCount: 0,
        stats: '{}',
        inventory: '[]',
        effects: '[]',
        actionHistory: '[]',
      })
      .run()

    return created.id
  })

  // Non-null: the row was just inserted in a committed transaction.
  return getWorld(db, worldId)!
}

export function getWorld(db: Db, worldId: number): WorldWithRelations | null {
  const world = db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return null

  const playerStateRow = db
    .select({ state: playerStates, currentLocation: locations })
    .from(playerStates)
    .leftJoin(locations, eq(playerStates.currentLocationId, locations.id))
    .where(eq(playerStates.worldId, worldId))
    .get()

  return {
    ...world,
    locations: db
      .select()
      .from(locations)
      .where(eq(locations.worldId, worldId))
      .orderBy(asc(locations.id))
      .all(),
    playerState: playerStateRow
      ? { ...playerStateRow.state, currentLocation: playerStateRow.currentLocation }
      : null,
    onboardingRoom:
      world.onboardingRoomId === null
        ? null
        : (db.select().from(rooms).where(eq(rooms.id, world.onboardingRoomId)).get() ?? null),
  }
}

// `ownerId` is required: names are unique per *owner* (`ux_worlds_owner_name`),
// so an ownerless lookup is a cross-tenant read. `null` means "the ownerless
// worlds" and needs the `IS NULL` branch — `eq(col, null)` matches nothing.
export function getWorldByName(db: Db, name: string, ownerId: string | null): World | null {
  const where = and(
    eq(worlds.name, name),
    ownerId === null ? isNull(worlds.ownerId) : eq(worlds.ownerId, ownerId),
  )!
  return db.select().from(worlds).where(where).get() ?? null
}

// Most recently played first. `NULLS FIRST` is explicit because SQLite sorts
// NULL lowest, burying a freshly created world under every old save.
export function getWorldsByOwner(db: Db, ownerId: string): World[] {
  return db
    .select()
    .from(worlds)
    .where(eq(worlds.ownerId, ownerId))
    .orderBy(sql`${worlds.lastPlayedAt} desc nulls first`)
    .all()
}

export interface WorldUpdate {
  phase?: WorldPhase | null
  genre?: string | null
  theme?: string | null
  userName?: string | null
  statDefinitions?: Record<string, unknown> | null
}

// `undefined`/`null` both mean "leave alone", so a field cannot be cleared back
// to NULL here. An empty `statDefinitions` is stored as `"{}"`, keeping "no stat
// system" (NULL) distinguishable from "configured as empty".
export function updateWorld(db: Db, worldId: number, update: WorldUpdate): World | null {
  const world = db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return null

  const patch: Partial<typeof worlds.$inferInsert> = {
    // Always stamped, even when nothing else changed.
    updatedAt: new Date(),
  }
  if (update.phase !== undefined && update.phase !== null) patch.phase = update.phase
  if (update.genre !== undefined && update.genre !== null) patch.genre = update.genre
  if (update.theme !== undefined && update.theme !== null) patch.theme = update.theme
  if (update.userName !== undefined && update.userName !== null) patch.userName = update.userName
  if (update.statDefinitions !== undefined && update.statDefinitions !== null) {
    patch.statDefinitions = JSON.stringify(update.statDefinitions)
  }

  return db.update(worlds).set(patch).where(eq(worlds.id, worldId)).returning().get() ?? null
}

export function updateWorldLastPlayed(db: Db, worldId: number): void {
  db.update(worlds).set({ lastPlayedAt: new Date() }).where(eq(worlds.id, worldId)).run()
}

export function getGameplayAgents(db: Db): Agent[] {
  return db
    .select()
    .from(agents)
    .where(inArray(agents.name, [...GAMEPLAY_AGENT_NAMES]))
    .all()
}

// Idempotent. The count is *not* "how many were newly added" — it feeds a log.
export function addGameplayAgentsToRoom(db: Db, roomId: number): number {
  let count = 0
  for (const agent of getGameplayAgents(db)) {
    if (addAgentToRoom(db, roomId, agent.id)) count += 1
  }
  return count
}

// The order orphans rows rather than failing when it is wrong: break the FK
// cycle (`worlds.onboarding_room_id` ↔ `rooms.world_id`), then world-scoped
// agents while `world_name` is known, then the world, then its rooms — that
// last step is redundant under `PRAGMA foreign_keys=ON` but nothing else.
export function deleteWorld(db: Db, worldId: number): boolean {
  const world = db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return false

  const roomIds = db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.worldId, worldId))
    .all()
    .map((r) => r.id)

  db.transaction((tx) => {
    tx.update(worlds).set({ onboardingRoomId: null }).where(eq(worlds.id, worldId)).run()

    const deletedAgents = tx
      .delete(agents)
      .where(eq(agents.worldName, world.name))
      .returning({ id: agents.id })
      .all()
    if (deletedAgents.length > 0) {
      logger.info(`Deleted ${deletedAgents.length} agents for world '${world.name}'`)
    }

    tx.delete(worlds).where(eq(worlds.id, worldId)).run()

    if (roomIds.length > 0) tx.delete(rooms).where(inArray(rooms.id, roomIds)).run()
  })

  // SQLite reuses rowids: a later room inheriting a deleted one's id would be
  // served its cached `is_paused` / `is_finished`, which gate the scheduler.
  for (const roomId of roomIds) invalidateRoomCache(roomId)

  return true
}

// `players` reads `player.json`; `rooms` writes the mapping into `_state.json`.
export interface ImportWorldServices {
  players: PlayerService
  rooms: RoomMappingService
}

// `world.json` is user-editable; throwing beats defaulting to `onboarding`,
// which would restart a finished campaign.
function toWorldPhase(phase: string): WorldPhase {
  if ((WORLD_PHASES as readonly string[]).includes(phase)) return phase as WorldPhase
  throw new Error(`Unknown world phase: ${phase}`)
}

// The `_state.json` write sits *inside* the transaction, so a failure rolls the
// rows back rather than leaving a database claiming a room nothing maps.
export function importWorldFromFilesystem(
  db: Db,
  fsConfig: WorldConfig,
  ownerId: string,
  services: ImportWorldServices,
): WorldWithRelations {
  const phase = toWorldPhase(fsConfig.phase)

  const worldId = db.transaction(() => {
    // `db` rather than `tx`; see {@link createWorld}.
    const room = createRoom(db, { name: `World: ${fsConfig.name}` }, ownerId)

    const created = db
      .insert(worlds)
      .values({
        name: fsConfig.name,
        ownerId,
        userName: fsConfig.userName,
        language: toLangKey(fsConfig.language),
        phase,
        genre: fsConfig.genre,
        theme: fsConfig.theme,
        onboardingRoomId: room.id,
        // The config loader already defaults these to "now" when the YAML omits them.
        createdAt: fsConfig.createdAt,
        updatedAt: fsConfig.updatedAt,
      })
      .returning()
      .get()

    db.update(rooms).set({ worldId: created.id }).where(eq(rooms.id, room.id)).run()

    // A world can exist on disk with no `player.json` yet.
    const fsPlayer = services.players.loadPlayerState(fsConfig.name)
    db.insert(playerStates)
      .values({
        worldId: created.id,
        turnCount: fsPlayer?.turnCount ?? 0,
        stats: fsPlayer ? PlayerStateSerializer.serializeStats(fsPlayer.stats) : '{}',
        inventory: fsPlayer ? PlayerStateSerializer.serializeInventory(fsPlayer.inventory) : '[]',
        effects: fsPlayer ? PlayerStateSerializer.serializeEffects(fsPlayer.effects) : '[]',
        // `recent_actions` on disk, `action_history` in the column.
        actionHistory: fsPlayer
          ? PlayerStateSerializer.serializeActionHistory(fsPlayer.recentActions)
          : '[]',
      })
      .run()

    // The key differs by phase because the casts do: gameplay tape vs interviewer.
    if (phase === 'active') {
      services.rooms.setRoomMapping(fsConfig.name, 'main', room.id, [...GAMEPLAY_AGENT_NAMES])
    } else {
      services.rooms.setRoomMapping(fsConfig.name, 'onboarding', room.id, ['Onboarding_Manager'])
    }

    return created.id
  })

  logger.info(`Imported world '${fsConfig.name}' from filesystem (phase=${phase})`)
  return getWorld(db, worldId)!
}
