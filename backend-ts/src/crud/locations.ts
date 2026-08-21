/**
 * CRUD operations for Location entities — port of `backend/crud/locations.py`.
 */

import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { locations, rooms, type Agent, type Location, type Room } from '../db/schema'
import { getAgentsInRoom } from './rooms'

/**
 * Agent groups that are machinery rather than cast.
 *
 * A location's room contains the Action_Manager and friends alongside the NPCs
 * standing there, so anything user-facing has to subtract this set to get the
 * people the player can actually see.
 */
export const SYSTEM_AGENT_GROUPS: ReadonlySet<string> = new Set(['gameplay', 'onboarding'])

/** A location with its backing room resolved, as Python eager-loads it. */
export interface LocationWithRoom extends Location {
  room: Room | null
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

/** All locations in a world, ordered by id. */
export function getLocations(db: Db, worldId: number): Location[] {
  return db
    .select()
    .from(locations)
    .where(eq(locations.worldId, worldId))
    .orderBy(asc(locations.id))
    .all()
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
