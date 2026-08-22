/**
 * Location routes — port of `backend/routers/game/locations.py`.
 *
 * The map, as the left-hand panel sees it: which places are known, where the
 * player is, moving between them, renaming one, and reading back a place's
 * transcript.
 *
 * Registration order matters here for one pair. `GET .../locations/current` and
 * `GET .../locations/{location_id}/messages` do not collide, but
 * `.../locations/current` *would* collide with a `GET .../locations/{id}` route
 * if one were ever added — there is none in Python, and adding one would need
 * `current` to stay first.
 */

import { Hono } from 'hono'

import { getLocation, getLocations, updateLocationLabel } from '../../../crud/locations'
import { getMessages, getMessagesSince } from '../../../crud/messages'
import { getPlayerState, setCurrentLocation } from '../../../crud/player-state'
import { getLogger } from '../../../infrastructure/logging/logger'
import { LocationUpdate, toLocation } from '../../../schemas/game'
import { RoomMappingService } from '../../../services/room-mapping'
import { HttpError } from '../../errors'
import type { AppState } from '../../state'
import type { AppEnv } from '../../types'
import {
  boolQueryParam,
  intPathParam,
  intQueryParam,
  intQueryParamOr,
  parseBody,
  requireWorld,
  toPollMessage,
} from './shared'

const logger = getLogger('GameRouter.Locations')

export function createLocationRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  /**
   * The world's locations, discovered ones only by default.
   *
   * The filter is applied in memory rather than in SQL, as in Python — the map
   * of a world is tens of rows, and `?discovered_only=false` (used by the world
   * inspector) wants the same query.
   */
  routes.get('/worlds/:world_id/locations', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const discoveredOnly = boolQueryParam(c, 'discovered_only', true)
    requireWorld(state, c, worldId)

    const all = getLocations(state.db, worldId)
    const visible = discoveredOnly ? all.filter((location) => location.isDiscovered) : all
    return c.json(visible.map(toLocation))
  })

  /** Where the player is standing. 404 while they are nowhere (onboarding). */
  routes.get('/worlds/:world_id/locations/current', (c) => {
    const worldId = intPathParam(c, 'world_id')
    requireWorld(state, c, worldId)

    const playerState = getPlayerState(state.db, worldId)
    if (!playerState?.currentLocationId) throw new HttpError(404, 'No current location')

    const location = getLocation(state.db, playerState.currentLocationId)
    if (!location) throw new HttpError(404, 'Location not found')

    return c.json(toLocation(location))
  })

  /**
   * Move the player to another location.
   *
   * Two writes, in this order and both required: the database row (which also
   * flips `is_current` and marks the destination discovered, inside
   * `setCurrentLocation`), and `_state.json`'s `current_room`, which is what the
   * agent-side tools read to decide whose room they are acting in. Leaving the
   * second out is invisible until the next turn narrates the wrong place.
   *
   * Note this endpoint does *not* run a turn. It is the map-click path; the
   * narrated version of travelling is the Action Manager's `travel` tool.
   */
  routes.post('/worlds/:world_id/locations/:location_id/travel', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const locationId = intPathParam(c, 'location_id')
    const world = requireWorld(state, c, worldId)

    const location = getLocation(state.db, locationId)
    // The world check is what stops a location id from one world being used to
    // move the player inside another.
    if (!location || location.worldId !== worldId) {
      throw new HttpError(404, 'Location not found')
    }

    setCurrentLocation(state.db, worldId, locationId)
    state.services.rooms.setCurrentRoom(
      world.name,
      RoomMappingService.locationToRoomKey(location.name),
    )

    logger.info(`Traveled to location ${location.displayName || location.name}`)

    return c.json({
      status: 'traveled',
      destination: location.displayName || location.name,
      location_id: locationId,
    })
  })

  /**
   * Set a location's user label — the only field a player may edit on the map.
   *
   * **The location is not checked against the world.** Python looks the world up
   * for the access check and then updates by location id alone, so an
   * authenticated caller can relabel any location in any world. Reproduced
   * rather than tightened: labels are cosmetic, and the parity harness compares
   * statuses.
   */
  routes.patch('/worlds/:world_id/locations/:location_id', async (c) => {
    const worldId = intPathParam(c, 'world_id')
    const locationId = intPathParam(c, 'location_id')
    const update = await parseBody(c, LocationUpdate)
    requireWorld(state, c, worldId)

    const location = updateLocationLabel(state.db, locationId, update.label)
    if (!location) throw new HttpError(404, 'Location not found')

    return c.json(toLocation(location))
  })

  /**
   * A location's transcript.
   *
   * `since_id` switches to the incremental query; without it the *last* `limit`
   * messages are returned, trimmed in memory because `getMessages` is
   * deliberately unbounded. The message shape is the poll endpoint's, not
   * `schemas.Message` — see {@link toPollMessage}.
   */
  routes.get('/worlds/:world_id/locations/:location_id/messages', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const locationId = intPathParam(c, 'location_id')
    const limit = intQueryParamOr(c, 'limit', 50)
    const sinceId = intQueryParam(c, 'since_id')
    requireWorld(state, c, worldId)

    const location = getLocation(state.db, locationId)
    if (!location?.roomId) throw new HttpError(404, 'Location not found')

    const messages = sinceId
      ? getMessagesSince(state.db, location.roomId, sinceId, limit)
      : trimToLast(getMessages(state.db, location.roomId), limit)

    return c.json({ messages: messages.map(toPollMessage) })
  })

  return routes
}

function trimToLast<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(-limit) : items
}
