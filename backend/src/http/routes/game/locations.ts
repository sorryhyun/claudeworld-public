// The map as the left-hand panel sees it. `.../locations/current` would collide
// with a `GET .../locations/{id}` route if one were added, so it stays first.

import { Hono } from 'hono'

import { getLocation, getLocations, updateLocationLabel } from '../../../crud/locations'
import { getMessages, getMessagesSince } from '../../../crud/messages'
import { getPlayerState, setCurrentLocation } from '../../../crud/player-state'
import { getLogger } from '../../../infrastructure/logging/logger'
import { LocationUpdate, toLocation } from '../../../schemas/game'
import { RoomMappingService } from '../../../services/room-mapping'
import { HttpError } from '../../../domain/errors'
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

  // Discovered locations only by default. The filter is in memory rather than
  // SQL: a map is tens of rows and `?discovered_only=false` wants the same query.
  routes.get('/worlds/:world_id/locations', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const discoveredOnly = boolQueryParam(c, 'discovered_only', true)
    requireWorld(state, c, worldId)

    const all = getLocations(state.db, worldId)
    const visible = discoveredOnly ? all.filter((location) => location.isDiscovered) : all
    return c.json(visible.map(toLocation))
  })

  // 404 while the player is nowhere, which is the case during onboarding.
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
   * Move the player. Both writes are required: the row (`setCurrentLocation`
   * also flips `is_current` and marks the destination discovered) and
   * `_state.json`'s `current_room`, which the agent-side tools read — omitting
   * it is invisible until the next turn narrates the wrong place. No turn is
   * run here; the narrated version of travelling is the `travel` tool.
   */
  routes.post('/worlds/:world_id/locations/:location_id/travel', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const locationId = intPathParam(c, 'location_id')
    const world = requireWorld(state, c, worldId)

    const location = getLocation(state.db, locationId)
    // Stops a location id from one world moving the player inside another.
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

  // Deliberately not checked against the world: any authenticated caller can
  // relabel any location, and labels are cosmetic.
  routes.patch('/worlds/:world_id/locations/:location_id', async (c) => {
    const worldId = intPathParam(c, 'world_id')
    const locationId = intPathParam(c, 'location_id')
    const update = await parseBody(c, LocationUpdate)
    requireWorld(state, c, worldId)

    const location = updateLocationLabel(state.db, locationId, update.label)
    if (!location) throw new HttpError(404, 'Location not found')

    return c.json(toLocation(location))
  })

  // `since_id` switches to the incremental query; without it the *last* `limit`
  // messages are returned, trimmed in memory because `getMessages` is unbounded.
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
