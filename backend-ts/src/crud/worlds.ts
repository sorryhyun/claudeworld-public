/**
 * CRUD operations for World entities — port of `backend/crud/worlds.py`.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db'
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
} from '../db/schema'
import { invalidateRoomCache } from './cached'
import type { PlayerStateWithLocation } from './player-state'
import { addAgentToRoom, createRoom } from './rooms'
import { toLangKey } from '../domain/enums'
import { PlayerStateSerializer } from '../domain/player-state-serializer'
import { getLogger } from '../infrastructure/logging/logger'
import type { PlayerService } from '../services/player-service'
import type { RoomMappingService } from '../services/room-mapping'
import type { WorldConfig } from '../services/world-service'

const logger = getLogger('WorldCRUD')

/**
 * Gameplay agents that belong in every location room.
 *
 * Only the two tape participants are listed. The sub-agents (Item_Designer,
 * Character_Designer, Location_Designer) are reached through the SDK Task tool
 * instead, so putting them in a room would only add noise to its transcript.
 */
export const GAMEPLAY_AGENT_NAMES = ['Action_Manager', 'Narrator'] as const

/** A world with the relationships `crud/worlds.py::get_world` eager-loads. */
export interface WorldWithRelations extends World {
  locations: Location[]
  playerState: PlayerStateWithLocation | null
  onboardingRoom: Room | null
}

/** Mirror of `schemas.WorldCreate` (`schemas/game.py:24`, fields on `WorldBase`). */
export interface WorldCreate {
  name: string
  /** The player's display name *inside* the world, not a user id. */
  userName?: string | null
  /** Defaults to English, as `WorldBase.language` does. */
  language?: Language
}

/**
 * Create a world with its onboarding room and an empty player state —
 * `worlds.py:65`.
 *
 * Three rows across three tables, so the whole thing is one transaction: a
 * world without a player state is a world the game panel cannot render, and a
 * partial create is exactly what the "reuse the existing onboarding room" branch
 * below exists to clean up after.
 *
 * Note the callback ignores its `tx` argument and keeps using `db`. That is not
 * an oversight: `bun:sqlite` has a single connection, and Drizzle's
 * `transaction()` runs `BEGIN`/`COMMIT` on it, so every statement issued
 * through `db` inside the callback is already inside this transaction. It is
 * what lets {@link createRoom} — which takes a `Db`, not a transaction — take
 * part atomically instead of committing a stray room on its own.
 */
export function createWorld(db: Db, world: WorldCreate, ownerId: string): WorldWithRelations {
  const onboardingRoomName = `Onboarding: ${world.name}`

  const worldId = db.transaction(() => {
    // Scoped to the owner, matching `worlds.py:75-80`: room names are unique
    // per (owner, name, world_id), so a global lookup could adopt another
    // tenant's room as this world's onboarding room.
    const existingRoom =
      db
        .select()
        .from(rooms)
        .where(and(eq(rooms.ownerId, ownerId), eq(rooms.name, onboardingRoomName)))
        .get() ?? null

    if (existingRoom) logger.info(`Reusing existing onboarding room: ${onboardingRoomName}`)
    const onboardingRoom = existingRoom ?? createRoom(db, { name: onboardingRoomName }, ownerId)

    // `created_at` / `updated_at` are set by hand because SQLAlchemy applies
    // `World.created_at`'s `default=` in the ORM, emitting no DDL default, and
    // the Drizzle mirror deliberately carries no `$defaultFn` for these two.
    // Leaving them out would write NULLs where Python writes timestamps, and
    // the world list sorts on them.
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

    // The reverse link, set after the insert because the FK cycle
    // (`World.onboarding_room_id` ↔ `Room.world_id`) cannot be satisfied in one
    // statement. Python does the same with a mid-transaction flush.
    db.update(rooms).set({ worldId: created.id }).where(eq(rooms.id, onboardingRoom.id)).run()

    // Literal `"{}"` / `"[]"`, not NULL. The `jsonOrNull` convention in
    // `crud/messages.ts` comes from Python's truthiness checks there; here
    // `worlds.py:108-115` hardcodes the strings, and `PlayerStateSerializer`
    // is likewise faithful to `json.dumps`.
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

/** Get a world by ID, with locations, player state and onboarding room. */
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

/**
 * Get a world by name and owner — `worlds.py:139`.
 *
 * `ownerId` is required, and that is a deliberate tightening of the Phase 0
 * signature, which made it optional. World names are unique per *owner*
 * (`ux_worlds_owner_name`), not globally, so a lookup without an owner is a
 * cross-tenant read: with two users who each named a world "asdf" it returns
 * whichever row SQLite reaches first, and every downstream call then operates
 * on someone else's world. Python has never allowed it.
 *
 * `null` is still accepted, because `owner_id` is nullable and Python's
 * `World.owner_id == None` renders `IS NULL` — so passing null means "the
 * ownerless worlds", not "any owner". Drizzle's `eq(col, null)` would render
 * `= NULL` and match nothing, hence the explicit branch.
 */
export function getWorldByName(db: Db, name: string, ownerId: string | null): World | null {
  const where = and(
    eq(worlds.name, name),
    ownerId === null ? isNull(worlds.ownerId) : eq(worlds.ownerId, ownerId),
  )!
  return db.select().from(worlds).where(where).get() ?? null
}

/**
 * Every world an owner has, most recently played first — `worlds.py:151`.
 *
 * `NULLS FIRST` is written out rather than left to the engine. SQLite sorts
 * NULL as smaller than every value, so a bare `DESC` puts never-played worlds
 * *last*; PostgreSQL defaults them first under `DESC`. Python asks for
 * `nullsfirst()` explicitly, which means a freshly created world appears at the
 * top of the picker instead of below every old save — the ordering a user
 * notices immediately after clicking "create".
 */
export function getWorldsByOwner(db: Db, ownerId: string): World[] {
  return db
    .select()
    .from(worlds)
    .where(eq(worlds.ownerId, ownerId))
    .orderBy(sql`${worlds.lastPlayedAt} desc nulls first`)
    .all()
}

/** Mirror of `schemas.WorldUpdate` (`schemas/game.py:30`). */
export interface WorldUpdate {
  phase?: WorldPhase | null
  genre?: string | null
  theme?: string | null
  userName?: string | null
  /** Serialized into the `stat_definitions` TEXT column. */
  statDefinitions?: Record<string, unknown> | null
}

/**
 * Patch a world's configuration — `worlds.py:164`. `null` for an unknown id.
 *
 * Every field is optional and `undefined`/`null` means "leave alone", matching
 * Python's `if update.x is not None`. There is deliberately no way to clear a
 * field back to NULL through this function; the onboarding flow only ever fills
 * them in.
 *
 * `statDefinitions` is the one case where this file does *not* follow the
 * empty-collection-becomes-NULL convention. That convention exists because the
 * Python code it mirrors guards with a bare `if x:`, which is false for `{}` —
 * but `worlds.py:184` guards with `is not None`, so Python stores an empty
 * definition set as the string `"{}"`, and a reader distinguishing "no stat
 * system configured" (NULL) from "configured as empty" (`"{}"`) would see the
 * two backends disagree. Faithfulness wins over the convention here.
 */
export function updateWorld(db: Db, worldId: number, update: WorldUpdate): World | null {
  const world = db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return null

  const patch: Partial<typeof worlds.$inferInsert> = {
    // Always stamped, even when nothing else changed — `worlds.py:187`.
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

/** Stamp `last_played_at`; a no-op when the world does not exist. */
export function updateWorldLastPlayed(db: Db, worldId: number): void {
  db.update(worlds).set({ lastPlayedAt: new Date() }).where(eq(worlds.id, worldId)).run()
}

/** Look up the gameplay agents by name. Missing ones are simply absent. */
export function getGameplayAgents(db: Db): Agent[] {
  return db
    .select()
    .from(agents)
    .where(inArray(agents.name, [...GAMEPLAY_AGENT_NAMES]))
    .all()
}

/**
 * Ensure the gameplay agents are members of a room. Idempotent.
 *
 * Returns Python's count verbatim, which is *not* "how many were newly added":
 * `add_agent_to_room` returns a truthy room whenever the room and agent both
 * exist, so an agent that was already a member still increments the counter.
 * The value only ever feeds a log line, and diverging from it would make the
 * two backends' logs disagree.
 */
export function addGameplayAgentsToRoom(db: Db, roomId: number): number {
  let count = 0
  for (const agent of getGameplayAgents(db)) {
    if (addAgentToRoom(db, roomId, agent.id)) count += 1
  }
  return count
}

/**
 * Delete a world and everything hanging off it — `worlds.py:210`.
 *
 * Order is the whole content of this function, and getting it wrong orphans
 * rows rather than failing:
 *
 * 1. **Break the FK cycle first.** `World.onboarding_room_id` points at a room
 *    whose `world_id` points back. Clearing the world's side before anything is
 *    deleted means neither delete has to reason about the other.
 * 2. **World-scoped agents next.** They are matched by `world_name`, so they
 *    have to go while the world's name is still known. `messages.agent_id` is
 *    `ON DELETE SET NULL`, so a world's transcript survives with the speaker's
 *    name still on the row (`participant_name`), which is what the export path
 *    reads.
 * 3. **The world**, which cascades to its locations and player state.
 * 4. **Its rooms explicitly.** Python's comment claims SQLite does not enforce
 *    the `Room.world_id` cascade; with `PRAGMA foreign_keys=ON` it does, so
 *    this is usually a no-op. It is kept because it is free, and because a
 *    database opened without the pragma would otherwise leak every room and
 *    message of a deleted world.
 */
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

  // Not in Python, which caches rooms but never invalidates them here. A cached
  // room object outliving its row is a real hazard: SQLite reuses rowids, so a
  // later room can inherit a deleted one's id and be served the dead entry's
  // `is_paused` / `is_finished`, which gate whether the scheduler keeps talking.
  // Dropping cache entries is always safe, so the divergence is one-directional.
  for (const roomId of roomIds) invalidateRoomCache(roomId)

  return true
}

/** Filesystem services {@link importWorldFromFilesystem} needs. */
export interface ImportWorldServices {
  /** Reads `worlds/{name}/player.yaml`. */
  players: PlayerService
  /** Writes the room mapping into `worlds/{name}/_state.json`. */
  rooms: RoomMappingService
}

/**
 * `WorldPhase(phase)` from `worlds.py:291`.
 *
 * `world.yaml` is user-editable, so an unreadable phase is a real possibility.
 * Python raises `ValueError` here and so does this — the column is a
 * three-value enum and silently defaulting to `onboarding` would restart a
 * finished campaign from its intro.
 */
function toWorldPhase(phase: string): WorldPhase {
  if ((WORLD_PHASES as readonly string[]).includes(phase)) return phase as WorldPhase
  throw new Error(`Unknown world phase: ${phase}`)
}

/**
 * Adopt an on-disk world into the database — `worlds.py:259`.
 *
 * The filesystem is the source of truth for a world; this creates the database
 * rows that let it be *opened* — a room to hold the conversation, the world's
 * metadata, and a player state seeded from `player.yaml`.
 *
 * Two divergences from Python, both forced by the port's service shape:
 *
 * - `PlayerService` and `RoomMappingService` are static classes in Python and
 *   instances here (each is bound to a `worlds/` root, which is what makes
 *   tests hermetic), so they are injected rather than imported.
 * - `language` goes through {@link toLangKey}, which folds an unrecognised
 *   value to English. Python stores whatever the YAML said; the column is typed
 *   here, and a junk language code only ever affected prompt wording anyway.
 *
 * The `_state.json` write sits *inside* the transaction, as in Python: if the
 * filesystem write throws, the rows roll back and the world can be imported
 * again. The reverse order would leave a database that claims a room the state
 * file does not map.
 */
export function importWorldFromFilesystem(
  db: Db,
  fsConfig: WorldConfig,
  ownerId: string,
  services: ImportWorldServices,
): WorldWithRelations {
  const phase = toWorldPhase(fsConfig.phase)

  const worldId = db.transaction(() => {
    // See {@link createWorld} on why `db` rather than the `tx` handle: one
    // connection, so `createRoom` joins this transaction as it stands.
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
        // Already defaulted to "now" by the config loader when the YAML omits
        // them, which is where Python's `or datetime.now(timezone.utc)` lands.
        createdAt: fsConfig.createdAt,
        updatedAt: fsConfig.updatedAt,
      })
      .returning()
      .get()

    db.update(rooms).set({ worldId: created.id }).where(eq(rooms.id, room.id)).run()

    // A world can exist on disk with no `player.yaml` yet — the empty defaults
    // below are what Python's `if fs_player_state else` branches write.
    const fsPlayer = services.players.loadPlayerState(fsConfig.name)
    db.insert(playerStates)
      .values({
        worldId: created.id,
        turnCount: fsPlayer?.turnCount ?? 0,
        stats: fsPlayer ? PlayerStateSerializer.serializeStats(fsPlayer.stats) : '{}',
        inventory: fsPlayer ? PlayerStateSerializer.serializeInventory(fsPlayer.inventory) : '[]',
        effects: fsPlayer ? PlayerStateSerializer.serializeEffects(fsPlayer.effects) : '[]',
        // `recent_actions` on disk, `action_history` in the column: the two
        // names are for the same list and the rename happens here.
        actionHistory: fsPlayer
          ? PlayerStateSerializer.serializeActionHistory(fsPlayer.recentActions)
          : '[]',
      })
      .run()

    // The room key differs by phase because the two phases have different
    // casts: an active world's room holds the gameplay tape, an unfinished
    // one's holds the interviewer. `set_room_mapping` restamps `created_at`, so
    // re-importing a world simply refreshes the mapping.
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
