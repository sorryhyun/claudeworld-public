/** CRUD operations for Location entities. */

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

// A location's room holds the Action_Manager and friends alongside its NPCs, so
// anything user-facing subtracts this set.
export { SYSTEM_AGENT_GROUPS }

export interface LocationWithRoom extends Location {
  room: Room | null
}

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

function requireWorldOwner(db: Db, worldId: number): string | null {
  const world = db.select({ ownerId: worlds.ownerId }).from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) throw new Error(`World ${worldId} not found`)
  return world.ownerId
}

/** `owner_id = ?` that also matches NULL, which SQL equality never does. */
function ownerMatches(ownerId: string | null) {
  return ownerId === null ? isNull(rooms.ownerId) : eq(rooms.ownerId, ownerId)
}

// The `existingRoom` lookup adopts orphans left by older databases. `db` is not
// rebound inside the transaction: `bun:sqlite` scopes one to the *connection*,
// so the helpers below join it and a nested `db.transaction` is a SAVEPOINT.
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
      // `world_id` at creation, not patched after: it is part of
      // `ux_rooms_owner_name_world`, and the intermediate NULL would collide.
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

// A fresh visit gets a new room; the previous one is left unreferenced on
// purpose, since it holds the last visit's transcript. The timestamp keeps
// `ux_rooms_owner_name_world` happy — two visits in one second still collide.
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
 * Find a location by `name` or `display_name`, case-insensitively. Four stages,
 * first hit wins: exact `name`, exact `display_name`, then separator-normalized
 * forms of each. The ordering is load-bearing — a world can hold both an
 * `old_mill` displayed as "Old Mill" and a location literally named "Old Mill",
 * so one OR-ed query, or stage 4 before stage 3, picks the wrong room. The
 * lowercasing is asymmetric: the term in JavaScript (Unicode-aware), the column
 * by SQLite's `lower()` (ASCII-only).
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

  // `foo bar` <-> `foo_bar`, skipping a variant identical to the original.
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

export function getLocations(db: Db, worldId: number): Location[] {
  return db
    .select()
    .from(locations)
    .where(eq(locations.worldId, worldId))
    .orderBy(asc(locations.id))
    .all()
}

// Deleting the room is the point: `messages`, `room_agents` and
// `room_agent_sessions` all cascade from it. Rooms from *earlier* visits are
// unreachable from the location row and survive.
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

// Injected rather than imported: the CRUD layer keeps no dependency on services.
export interface LocationFilesystemSync {
  /** Only the keys are read, so a `LocationStorage` satisfies this. */
  loadAllLocations(worldName: string): Record<string, unknown>
  /** Not yet in `services/room-mapping.ts`; a no-op leaks `_state.json` entries. */
  deleteRoomMapping(worldName: string, roomKey: string): void
}

// The filesystem is the source of truth for the map. Matching is on `name` (the
// folder name), never `display_name` — renaming a heading must not delete it.
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
    // Mapping first: a stale one is harmless if the delete throws, while a
    // mapping onto a deleted room id opens the wrong transcript next turn.
    filesystem.deleteRoomMapping(worldName, RoomMappingService.locationToRoomKey(location.name))
    deleteLocation(db, location.id)
    deleted += 1
  }

  if (deleted > 0) {
    logger.info(`Synced locations for world '${worldName}': deleted ${deleted} orphaned locations`)
  }

  return deleted
}

// `undefined` skips the field, `null` writes NULL — collapsing the two would
// make a nullable column impossible to clear.
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

  // Drizzle refuses an empty SET clause.
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

export function updateLocationLabel(
  db: Db,
  locationId: number,
  label: string | null,
): Location | null {
  return (
    db.update(locations).set({ label }).where(eq(locations.id, locationId)).returning().get() ?? null
  )
}

// Idempotent, and the edge is one-way — a two-way passage needs two calls.
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

// `adjacent_locations` holds NULL, `''` or a JSON array depending on which path
// wrote it, and tool handlers write it too — so non-numeric entries are dropped.
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
  excludeSystemAgents?: boolean
}

// Presence is membership of the location's room — there is no agent→location
// column — so a roomless location has nobody. A NULL `group` survives the
// filter: that is a hand-made character, not machinery.
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

// False means "this location cannot hold characters"; the agent is not checked.
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

// `fromLocationId` is null for a first placement; the result is the arrival's.
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

// One join rather than a per-location loop: `bun:sqlite` is synchronous, so a
// query per location blocks the event loop and stalls in-flight SDK streaming.
export function getAgentLocationsInWorld(db: Db, agentId: number, worldId: number): Location[] {
  return db
    .select({ location: locations })
    .from(locations)
    .innerJoin(roomAgents, eq(roomAgents.roomId, locations.roomId))
    .where(and(eq(locations.worldId, worldId), eq(roomAgents.agentId, agentId)))
    .orderBy(asc(locations.id))
    .all()
    .map((row) => row.location)
}

// The snake_case keys are `GET /worlds/{id}/characters`' response body verbatim
// — renaming one here breaks the frontend's character panel.
export interface WorldCharacter {
  id: number
  name: string
  profile_pic: string | null
  in_a_nutshell: string | null
  location_id: number
  location_name: string
}

export interface GetAllCharactersInWorldOptions {
  excludeSystemAgents?: boolean
}

// De-duplication stays in JavaScript because an agent in two rooms belongs at
// the *first* location by id, and the filter needs its explicit NULL branch:
// `group NOT IN (...)` is NULL for a NULL group, dropping hand-made characters.
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
