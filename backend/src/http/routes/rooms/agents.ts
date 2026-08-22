/**
 * Agent membership in a room: three routes over the `room_agents` join table.
 * Adding is open to the room's owner; removing is admin-only, because it also
 * tears down the warm session that agent holds in that room.
 */

import { Hono } from 'hono'

import { addAgentToRoom, getAgentsInRoom } from '../../../crud/rooms'
import { getLogger } from '../../../infrastructure/logging/logger'
import { toAgent } from '../../../schemas/agents'
import { toRoom } from '../../../schemas/rooms'
import { HttpError } from '../../../domain/errors'
import { requireAdmin } from '../../middleware/auth'
import type { AppState } from '../../state'
import type { AppEnv } from '../../types'
import { intPathParam } from '../game/shared'
import { ensureRoomAccessFor } from './shared'

const logger = getLogger('RoomRouter.Agents')

export function createRoomAgentRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/rooms/:room_id/agents', (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)
    return c.json(getAgentsInRoom(state.db, roomId).map(toAgent))
  })

  routes.post('/rooms/:room_id/agents/:agent_id', (c) => {
    const roomId = intPathParam(c, 'room_id')
    const agentId = intPathParam(c, 'agent_id')
    ensureRoomAccessFor(c, state.db, roomId)

    const room = addAgentToRoom(state.db, roomId, agentId)
    // One message for both misses: telling which id was wrong would cost a
    // second query.
    if (room === null) throw new HttpError(404, 'Room or Agent not found')

    logger.info(`Agent ${agentId} added to room ${roomId}`)
    return c.json(toRoom(room))
  })

  routes.delete('/rooms/:room_id/agents/:agent_id', requireAdmin, async (c) => {
    const roomId = intPathParam(c, 'room_id')
    const agentId = intPathParam(c, 'agent_id')

    const removed = await state.agents.removeAgentFromRoomWithCleanup(state.db, roomId, agentId)
    if (!removed) throw new HttpError(404, 'Room or Agent not found')

    logger.info(`Agent ${agentId} removed from room ${roomId}`)
    return c.json({ message: 'Agent removed from room successfully' })
  })

  return routes
}
