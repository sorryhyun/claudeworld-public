/**
 * CRUD operations for Location entities — port of `backend/crud/locations.py`.
 */

import { and, asc, eq, isNull, notInArray, or, sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db'
import {
  agents,
  locations,
  roomAgents,
  rooms,
  worlds,
  type Agent,
  type Location,
  type Room,
} from '../db/schema'
import { getLogger } from '../infrastructure/logging/logger'
import { RoomMappingService } from '../services/room-mapping'
import { addAgentToRoom, createRoom, getAgentsInRoom, removeAgentFromRoom } from './rooms'
import { addGameplayAgentsToRoom } from './worlds'
import { SYSTEM_AGENT_GROUPS } from '../domain/agent'

const logger = getLogger('LocationCRUD')

/**
 * Agent groups that are machinery rather than cast.
 *
 * A location's room contains the Action_Manager and friends alongside the NPCs
 * standing there, so anything user-facing has to subtract this set to get the
 * people the player can actually see. Defined in `domain/agent.ts`, where
 * Python keeps it (`domain/value_objects/enums.py:121`); re-exported because
 * callers already import it from here.
 */
export { SYSTEM_AGENT_GROUPS }

/** A location with its backing room resolved, as Python eager-loads it. */
export interface LocationWithRoom extends Location {
  room: Room | null
}

/** Mirror of `schemas.LocationCreate` (`schemas/game.py:174`). */
export interface LocationCreate {
  name: string
  displayName?: string | null
  description?: string | null
  positionX?: number
  positionY?: number
  /** Ids of locations reachable from here; empty is stored as NULL. */
  adjacentTo?: number[] | null
  isDiscovered?: boolean
  isDraft?: boolean
}

/** The owner a location's room is scoped to, or a thrown error. */
function requireWorldOwner(db: Db, worldId: number): string | null {
  const world = db.select({ ownerId: worlds.ownerId }).from(worlds).where(eq(worlds.id, worldId)).get()
  // Python raises ValueError here (`locations.py:39`), which surfaces as a 500.
  if (!world) throw new Error(`World ${worldId} not found`)
  return world.ownerId
}

/** `owner_id = ?` that also matches NULL, which SQL equality never does. */
function ownerMatches(ownerId: string | null) {
  return ownerId === null ? isNull(rooms.ownerId) : eq(rooms.ownerId, ownerId)
}

/**
 * Create a location and the room that backs it.
 *
 * Port of `locations.py:27`. Three writes — room, gameplay-agent membership,
 * location — and Python performs them across *separate* commits, so a crash
 * between them leaves a room with no location pointing at it. That is exactly
 * the orphan the `existing_room` lookup below exists to clean up after. Here
 * they are one transaction, which is the contract's rule for multi-statement
 * writes; the orphan lookup is still ported because databases written by the
 * Python backend already contain such rooms.
 *
 * Note the transaction is entered without rebinding `db`. `bun:sqlite` scopes a
 * transaction to the *connection*, not to the object handed to the callback, so
 * the helpers called below run inside it even though they were passed the outer
 * handle — and `createSystemMessage`'s own `db.transaction` nests as a
 * SAVEPOINT rather than failing on a second BEGIN.
 */
export function createLocation(db: Db, worldId: number, location: LocationCreate): Location {
  const ownerId = requireWorldOwner(db, worldId)
  const roomName = `Location: ${location.displayName || location.name}`

  return db.transaction(() => {
    const existingRoom = db
      .select()
      .from(rooms)
      .where(and(ownerMatches(ownerId), eq(rooms.name, roomName), eq(rooms.worldId, worldId)))
      .get()

    let roomId: number
    if (existingRoom) {
      logger.info(`Reusing existing room '${roomName}' (id=${existingRoom.id}) for location`)
      roomId = existingRoom.id
    } else {
      // `world_id` is set at creation rather than patched afterwards: it is part
      // of `ux_rooms_owner_name_world`, and a two-step write would briefly hold
      // a NULL there, colliding with every other world's room of the same name.
      roomId = createRoom(db, { name: roomName }, ownerId, worldId).id
    }

    if (addGameplayAgentsToRoom(db, roomId) === 0) {
      logger.warning(`No gameplay agents found to add to location room ${roomId}`)
    }

    return db
      .insert(locations)
      .values({
        worldId,
        name: location.name,
        displayName: location.displayName ?? null,
        description: location.description ?? null,
        positionX: location.positionX ?? 0,
        positionY: location.positionY ?? 0,
        // Python's `json.dumps(x) if x else None`: an empty list is falsy there,
        // so it lands as NULL rather than the string "[]".
        adjacentLocations:
          location.adjacentTo && location.adjacentTo.length > 0
            ? JSON.stringify(location.adjacentTo)
            : null,
        roomId,
        isDiscovered: location.isDiscovered ?? true,
        isDraft: location.isDraft ?? false,
      })
      .returning()
      .get()
  })
}

/**
 * Point a location at a brand-new room, for a fresh visit.
 *
 * Port of `locations.py:95`. The previous room is deliberately left in the
 * database, unreferenced: it holds the transcript of the last visit, and the
 * point of a new room is that the NPCs there start the scene without replaying
 * it. Do not "clean up" the old room — deleting it would cascade its messages
 * away and lose the history this function exists to preserve.
 *
 * The timestamp in the name is what keeps `ux_rooms_owner_name_world` happy
 * across repeat visits; second resolution is Python's and is kept, so two
 * visits inside the same second still collide in both backends.
 */
export function createNewRoomForLocation(db: Db, location: Location): Room {
  const ownerId = requireWorldOwner(db, location.worldId)
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .slice(0, 15)

  return db.transaction(() => {
    const room = createRoom(
      db,
      { name: `Location: ${location.displayName || location.name} [${stamp}]` },
      ownerId,
      location.worldId,
    )

    addGameplayAgentsToRoom(db, room.id)
    db.update(locations).set({ roomId: room.id }).where(eq(locations.id, location.id)).run()

    return room
  })
}

/** Get a location by ID, with its room. */
export function getLocation(db: Db, locationId: number): LocationWithRoom | null {
  const row = db
    .select({ location: locations, room: rooms })
    .from(locations)
    .leftJoin(rooms, eq(locations.roomId, rooms.id))
    .where(eq(locations.id, locationId))
    .get()

  return row ? { ...row.location, room: row.room } : null
}

/**
 * Find a location by `name` or `display_name`, case-insensitively.
 *
 * Port of `locations.py:153`. Four stages, in this order, first hit wins:
 *
 *   1. exact (lowercased) match on `name` — the folder name;
 *   2. exact match on `display_name` — the human-readable heading;
 *   3. separator-normalized match on `name`;
 *   4. separator-normalized match on `display_name`.
 *
 * The ordering is load-bearing rather than incidental. Names arrive here from
 * three sources that disagree — a directory listing, a model-written tool call,
 * and the database — and a world can legitimately contain both an `old_mill`
 * whose display name is "Old Mill" and a separate location literally named
 * "Old Mill". Callers rely on the exact-`name` candidate winning that race, so
 * collapsing these into one OR-ed query would silently pick the wrong room.
 *
 * Stage 3 tries *both* normalizations against `name` before stage 4 tries
 * either against `display_name`; that is Python's loop structure and it matters
 * for the same reason.
 *
 * The lowercasing is asymmetric on purpose: the search term is lowered in
 * JavaScript (Unicode-aware) while the column is lowered by SQLite's `lower()`
 * (ASCII-only). Python has exactly the same split — `str.lower()` against
 * `func.lower()` — so the two backends agree, including on the non-ASCII names
 * neither of them folds.
 *
 * One divergence: Python uses `scalar_one_or_none()`, which *raises* when two
 * locations match. Here the first row is returned. Duplicates should be
 * impossible, and a 500 on a lookup is a worse failure than an arbitrary pick.
 */
export function getLocationByName(
  db: Db,
  worldId: number,
  locationName: string,
): LocationWithRoom | null {
  const searchLower = locationName.toLowerCase()

  const probe = (column: AnySQLiteColumn, value: string): LocationWithRoom | null => {
    const row = db
      .select({ location: locations, room: rooms })
      .from(locations)
      .leftJoin(rooms, eq(locations.roomId, rooms.id))
      .where(and(eq(locations.worldId, worldId), sql`lower(${column}) = ${value}`))
      .get()
    return row ? { ...row.location, room: row.room } : null
  }

  const exactName = probe(locations.name, searchLower)
  if (exactName) return exactName

  const exactDisplay = probe(locations.displayName, searchLower)
  if (exactDisplay) return exactDisplay

  // `foo bar` <-> `foo_bar`. A variant identical to the original is skipped
  // rather than re-queried, matching Python's `if normalized != search_lower`.
  const normalized = [
    locationName.replaceAll(' ', '_').toLowerCase(),
    locationName.replaceAll('_', ' ').toLowerCase(),
  ].filter((candidate) => candidate !== searchLower)

  for (const candidate of normalized) {
    const hit = probe(locations.name, candidate)
    if (hit) return hit
  }

  for (const candidate of normalized) {
    const hit = probe(locations.displayName, candidate)
    if (hit) return hit
  }

  return null
}

/** All locations in a world, ordered by id. */
export function getLocations(db: Db, worldId: number): Location[] {
  return db
    .select()
    .from(locations)
    .where(eq(locations.worldId, worldId))
    .orderBy(asc(locations.id))
    .all()
}

/**
 * Delete a location and the room backing it. False when it did not exist.
 *
 * Port of `locations.py:237`. Deleting the room is the point, not a courtesy:
 * `messages`, `room_agents` and `room_agent_sessions` all cascade from it, so
 * this is what actually reclaims the transcript. Rooms from *earlier* visits
 * (see {@link createNewRoomForLocation}) are not reachable from the location
 * row and survive — Python leaks them the same way.
 *
 * One transaction, because the two deletes are one intent; `locations.room_id`
 * is `ON DELETE SET NULL`, so a crash between them in Python's version leaves
 * the room orphaned rather than half-deleted.
 */
export function deleteLocation(db: Db, locationId: number): boolean {
  const location = db
    .select({ roomId: locations.roomId })
    .from(locations)
    .where(eq(locations.id, locationId))
    .get()

  if (!location) return false

  db.transaction(() => {
    db.delete(locations).where(eq(locations.id, locationId)).run()
    if (location.roomId !== null) {
      db.delete(rooms).where(eq(rooms.id, location.roomId)).run()
    }
  })

  logger.info(`Deleted location ${locationId} (room_id=${location.roomId})`)
  return true
}

/**
 * The filesystem side of {@link syncLocationsWithFilesystem}.
 *
 * Passed in rather than imported so the CRUD layer keeps no dependency on the
 * service layer — Python reaches for `LocationStorage` and `RoomMappingService`
 * with function-local imports precisely because the module-level ones would be
 * circular.
 */
export interface LocationFilesystemSync {
  /**
   * `LocationStorage.load_all_locations`. Only the keys are read, so a
   * `LocationStorage` instance satisfies this structurally.
   */
  loadAllLocations(worldName: string): Record<string, unknown>
  /**
   * `RoomMappingService.delete_room_mapping`
   * (`services/room_mapping_service.py:357`).
   *
   * Not yet ported to `services/room-mapping.ts`; until it is, callers can pass
   * a no-op, at the cost of leaving a dangling entry in `_state.json`.
   */
  deleteRoomMapping(worldName: string, roomKey: string): void
}

/**
 * Delete database locations that no longer exist on disk. Returns how many.
 *
 * Port of `locations.py:275`. The filesystem is the source of truth for the
 * map: `locations/_index.yaml` plus a directory per location. A row whose
 * directory is gone would otherwise keep appearing in the minimap and stay
 * reachable by `travel`.
 *
 * Matching is on `name` (the folder name), never `display_name` — renaming a
 * location's heading must not delete it.
 */
export function syncLocationsWithFilesystem(
  db: Db,
  worldId: number,
  worldName: string,
  filesystem: LocationFilesystemSync,
): number {
  const onDisk = new Set(Object.keys(filesystem.loadAllLocations(worldName)))

  let deleted = 0
  for (const location of getLocations(db, worldId)) {
    if (onDisk.has(location.name)) continue

    logger.info(`Deleting orphaned location '${location.name}' from world '${worldName}'`)
    // The `_state.json` room mapping is cleaned first: if the delete below
    // throws, a stale mapping is harmless, whereas a mapping pointing at a
    // deleted room id is what makes the next turn open the wrong transcript.
    filesystem.deleteRoomMapping(worldName, RoomMappingService.locationToRoomKey(location.name))
    deleteLocation(db, location.id)
    deleted += 1
  }

  if (deleted > 0) {
    logger.info(`Synced locations for world '${worldName}': deleted ${deleted} orphaned locations`)
  }

  return deleted
}

/**
 * Mirror of `schemas.LocationUpdate` (`schemas/game.py:184`) as a patch.
 *
 * Python applies it with `model_dump(exclude_unset=True)`, which keys the patch
 * on *which fields the caller set*, not on which are non-None — so `label=None`
 * clears the column while an omitted `label` leaves it alone. Pydantic tracks
 * that; Zod does not, and neither does a plain object. The rule here is
 * therefore explicit: a key whose value is `undefined` (or absent) is skipped,
 * and `null` writes NULL. Collapsing the two would make a nullable column
 * impossible to clear.
 *
 * `name` is not nullable here even though Python's schema allows `None`: the
 * column is NOT NULL, so Python's version fails at commit time. Making it a
 * type error is the same outcome, sooner.
 */
export interface LocationUpdate {
  name?: string
  displayName?: string | null
  description?: string | null
  label?: string | null
  positionX?: number | null
  positionY?: number | null
  isDiscovered?: boolean | null
  isDraft?: boolean | null
}

/** Apply a patch to a location. Null when the location does not exist. */
export function updateLocation(
  db: Db,
  locationId: number,
  update: LocationUpdate,
): Location | null {
  const existing = db.select().from(locations).where(eq(locations.id, locationId)).get()
  if (!existing) return null

  const patch: Partial<typeof locations.$inferInsert> = {}
  if (update.name !== undefined) patch.name = update.name
  if (update.displayName !== undefined) patch.displayName = update.displayName
  if (update.description !== undefined) patch.description = update.description
  if (update.label !== undefined) patch.label = update.label
  if (update.positionX !== undefined) patch.positionX = update.positionX
  if (update.positionY !== undefined) patch.positionY = update.positionY
  if (update.isDiscovered !== undefined) patch.isDiscovered = update.isDiscovered
  if (update.isDraft !== undefined) patch.isDraft = update.isDraft

  // Drizzle refuses an empty SET clause; SQLAlchemy just commits nothing and
  // returns the untouched row, which is what the early return reproduces.
  if (Object.keys(patch).length === 0) return existing

  const updated = db
    .update(locations)
    .set(patch)
    .where(eq(locations.id, locationId))
    .returning()
    .get()

  logger.info(`Updated location ${locationId}: ${Object.keys(patch).join(', ')}`)
  return updated
}

/**
 * Set (or clear) a location's user-assigned label.
 *
 * Separate from {@link updateLocation} because the label is the one field the
 * player edits directly, and `null` here unambiguously means "remove it".
 */
export function updateLocationLabel(
  db: Db,
  locationId: number,
  label: string | null,
): Location | null {
  return (
    db.update(locations).set({ label }).where(eq(locations.id, locationId)).returning().get() ?? null
  )
}

/**
 * Record that another location is reachable from this one. Idempotent.
 *
 * Port of `locations.py:378`. The edge is stored one-way, as a JSON array of
 * ids on the source row; Python does not add the reverse edge and neither does
 * this, so a two-way passage needs two calls.
 *
 * Returns the location unchanged when the edge already exists — Python commits
 * nothing in that case but still returns the row.
 */
export function addAdjacentLocation(
  db: Db,
  locationId: number,
  adjacentLocationId: number,
): Location | null {
  const existing = db.select().from(locations).where(eq(locations.id, locationId)).get()
  if (!existing) return null

  const adjacents = parseAdjacentIds(existing.adjacentLocations)
  if (adjacents.includes(adjacentLocationId)) return existing

  adjacents.push(adjacentLocationId)
  return db
    .update(locations)
    .set({ adjacentLocations: JSON.stringify(adjacents) })
    .where(eq(locations.id, locationId))
    .returning()
    .get()
}

/**
 * Decode `adjacent_locations`.
 *
 * The column holds NULL, `''` or a JSON array depending on which code path
 * wrote it, and `json.loads` is only reached in Python behind an `if` that
 * treats the first two as empty. Non-numeric entries are dropped rather than
 * trusted: the column is written by tool handlers as well as by this module.
 */
function parseAdjacentIds(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : []
  } catch {
    return []
  }
}

export interface GetCharactersAtLocationOptions {
  /** Python's `exclude_system_agents`, default `True`. */
  excludeSystemAgents?: boolean
}

/**
 * The character agents standing at a location.
 *
 * Presence is modelled as membership of the location's room — there is no
 * agent→location column — so a location with no room has nobody at it.
 *
 * Agents whose `group` is NULL survive the filter: `a.group not in
 * SYSTEM_AGENT_GROUPS` is true for None in Python, and an ungrouped agent is a
 * hand-made character rather than machinery.
 */
export function getCharactersAtLocation(
  db: Db,
  locationId: number,
  { excludeSystemAgents = true }: GetCharactersAtLocationOptions = {},
): Agent[] {
  const location = db
    .select({ roomId: locations.roomId })
    .from(locations)
    .where(eq(locations.id, locationId))
    .get()

  if (!location || location.roomId === null) return []

  const present = getAgentsInRoom(db, location.roomId)
  if (!excludeSystemAgents) return present
  return present.filter((agent) => agent.group === null || !SYSTEM_AGENT_GROUPS.has(agent.group))
}

// ============================================================================
// Character ↔ location, expressed as room membership
// ============================================================================

/**
 * Put a character at a location. False when the location has no room.
 *
 * Port of `locations.py:410`. Note the truth value: Python returns True as soon
 * as the location has a room, *without* checking whether the agent existed —
 * `add_agent_to_room` returning None is discarded. Reproduced, because callers
 * treat False as "this location cannot hold characters", not as "that agent is
 * missing".
 */
export function addCharacterToLocation(db: Db, agentId: number, locationId: number): boolean {
  const location = db
    .select({ roomId: locations.roomId })
    .from(locations)
    .where(eq(locations.id, locationId))
    .get()

  if (!location || location.roomId === null) return false

  addAgentToRoom(db, location.roomId, agentId)
  return true
}

/** Take a character away from a location. False when it has no room. */
export function removeCharacterFromLocation(db: Db, agentId: number, locationId: number): boolean {
  const location = db
    .select({ roomId: locations.roomId })
    .from(locations)
    .where(eq(locations.id, locationId))
    .get()

  if (!location || location.roomId === null) return false

  removeAgentFromRoom(db, location.roomId, agentId)
  return true
}

/**
 * Walk a character from one location to another.
 *
 * `fromLocationId` is optional because a character can be placed on the map for
 * the first time. The result reports only the *arrival*: Python returns
 * `add_character_to_location`'s value and ignores the removal's, so a departure
 * from a roomless location does not make the move look failed.
 *
 * Not a transaction, and deliberately so — Python commits the two membership
 * changes separately, and the intermediate state (present at neither end) is
 * not observable by a reader that is not mid-turn.
 */
export function moveCharacterToLocation(
  db: Db,
  agentId: number,
  fromLocationId: number | null,
  toLocationId: number,
): boolean {
  if (fromLocationId) {
    removeCharacterFromLocation(db, agentId, fromLocationId)
  }
  return addCharacterToLocation(db, agentId, toLocationId)
}

/**
 * Every location in a world where the given agent is present.
 *
 * **Rewritten as a join, not transcribed.** Python (`locations.py:488-523`)
 * selects every location in the world with `selectinload(room).selectinload(
 * room.agents)` and then filters in a Python loop — that is one query per
 * location's room plus the full agent list of each, discarded immediately. Its
 * async runtime hides the cost by yielding between awaits; `bun:sqlite` is
 * synchronous, so the same shape would block the event loop for the duration,
 * stalling in-flight SDK streaming on a world with a large map. The join below
 * asks the database the question that was actually being asked.
 *
 * The `room_agents` join is against `locations.room_id` directly rather than
 * through `rooms`: the foreign key guarantees a membership row implies a room,
 * so the extra hop would only cost a lookup.
 */
export function getAgentLocationsInWorld(db: Db, agentId: number, worldId: number): Location[] {
  return db
    .select({ location: locations })
    .from(locations)
    .innerJoin(roomAgents, eq(roomAgents.roomId, locations.roomId))
    .where(and(eq(locations.worldId, worldId), eq(roomAgents.agentId, agentId)))
    // Python's query has no ORDER BY, so rows arrive in primary-key order;
    // stating it keeps the two backends' output identical instead of relying on
    // SQLite's choice of plan.
    .orderBy(asc(locations.id))
    .all()
    .map((row) => row.location)
}

/**
 * One character in the world-wide cast listing.
 *
 * The keys are snake_case because this object is the response body of
 * `GET /worlds/{id}/characters` verbatim — a frozen contract with the frontend,
 * not an internal shape. Renaming a key here breaks the character panel.
 */
export interface WorldCharacter {
  id: number
  name: string
  profile_pic: string | null
  in_a_nutshell: string | null
  location_id: number
  location_name: string
}

export interface GetAllCharactersInWorldOptions {
  /** Python's `exclude_system_agents`, default `True`. */
  excludeSystemAgents?: boolean
}

/**
 * Every character across a world's locations, one row each.
 *
 * **Rewritten as a join**, for the reason given on
 * {@link getAgentLocationsInWorld}: Python (`locations.py:559-612`) loads every
 * location, every location's room, and every room's full agent list, then does
 * the filtering and the de-duplication in a loop. On a synchronous driver that
 * is a single uninterruptible block proportional to the size of the map.
 *
 * De-duplication stays in JavaScript rather than becoming a `GROUP BY`: an
 * agent standing in two rooms must be reported at the *first* location by id,
 * and keeping that as an explicit "first wins" pass is both clearer than a
 * correlated aggregate and exactly what Python's loop does.
 *
 * The system-agent filter needs the explicit NULL branch. `group NOT IN (...)`
 * evaluates to NULL — and therefore excludes the row — when `group` is NULL,
 * whereas Python's `None in {...}` is plainly False and keeps it. Ungrouped
 * agents are hand-made characters, so dropping them would empty the cast list
 * of exactly the worlds that have one.
 */
export function getAllCharactersInWorld(
  db: Db,
  worldId: number,
  { excludeSystemAgents = true }: GetAllCharactersInWorldOptions = {},
): WorldCharacter[] {
  const notSystem = or(isNull(agents.group), notInArray(agents.group, [...SYSTEM_AGENT_GROUPS]))

  const rows = db
    .select({
      id: agents.id,
      name: agents.name,
      profilePic: agents.profilePic,
      inANutshell: agents.inANutshell,
      locationId: locations.id,
      displayName: locations.displayName,
      locationName: locations.name,
    })
    .from(locations)
    .innerJoin(roomAgents, eq(roomAgents.roomId, locations.roomId))
    .innerJoin(agents, eq(agents.id, roomAgents.agentId))
    .where(
      excludeSystemAgents
        ? and(eq(locations.worldId, worldId), notSystem)
        : eq(locations.worldId, worldId),
    )
    .orderBy(asc(locations.id))
    .all()

  const characters: WorldCharacter[] = []
  const seen = new Set<number>()

  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    characters.push({
      id: row.id,
      name: row.name,
      profile_pic: row.profilePic,
      in_a_nutshell: row.inANutshell,
      location_id: row.locationId,
      location_name: row.displayName || row.locationName,
    })
  }

  return characters
}
