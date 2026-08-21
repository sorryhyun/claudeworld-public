/**
 * CRUD operations for World entities — port of `backend/crud/worlds.py`.
 */

import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db'
import {
  agents,
  locations,
  playerStates,
  rooms,
  worlds,
  type Agent,
  type Location,
  type Room,
  type World,
} from '../db/schema'
import type { PlayerStateWithLocation } from './player-state'
import { addAgentToRoom } from './rooms'

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
 * Get a world by name.
 *
 * World names are unique per owner, not globally (`ux_worlds_owner_name`), so
 * Python always passes an owner. `ownerId` is optional here because the Phase 0
 * callers run single-tenant; omitting it searches across owners and can return
 * an arbitrary one of several same-named worlds.
 */
export function getWorldByName(db: Db, name: string, ownerId?: string | null): World | null {
  const nameMatch = eq(worlds.name, name)
  const where =
    ownerId === undefined || ownerId === null ? nameMatch : and(nameMatch, eq(worlds.ownerId, ownerId))
  return db.select().from(worlds).where(where).get() ?? null
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
