/**
 * Chat room CRUD. Mounted at the root, so every path is written out in full and
 * the collection routes are registered on both `/rooms` and `/rooms/` — Hono is
 * strict about the trailing slash where the API contract is not. The 404 strings
 * differ per handler on purpose: `ensureRoomAccessFor` says "Room with id N not
 * found" where the handlers' guards say "Room not found", and the frontend
 * renders `detail`.
 */

import { Hono, type Context } from 'hono'

import {
  createRoom as createRoomRow,
  getRooms,
  updateRoom as updateRoomRow,
} from '../../../crud/rooms'
import { RoomAlreadyExistsError } from '../../../domain/errors'
import { getLogger } from '../../../infrastructure/logging/logger'
import { RoomCreate, RoomUpdate, toRoom, toRoomSummary } from '../../../schemas/rooms'
import { HttpError } from '../../errors'
import { requireAdmin } from '../../middleware/auth'
import { identityOf, type AppState } from '../../state'
import type { AppEnv } from '../../types'
import { intPathParam, parseBody } from '../game/shared'
import { ensureRoomAccessFor } from './shared'

const logger = getLogger('RoomRouter')

/** The guard string shared by update, pause and resume. */
function roomNotFound(): HttpError {
  return new HttpError(404, 'Room not found')
}

export function createRoomRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  function listRooms(c: Context<AppEnv>): Response {
    return c.json(getRooms(state.db, identityOf(c)).map(toRoomSummary))
  }

  async function createRoom(c: Context<AppEnv>): Promise<Response> {
    const body = await parseBody(c, RoomCreate)
    const identity = identityOf(c)
    const ownerId = identity.role === 'admin' ? 'admin' : identity.userId

    // Pre-checked, not caught: a chat room has `world_id = NULL`, and the unique
    // index over (owner_id, name, world_id) never fires for two NULLs.
    for (const existing of getRooms(state.db, identity)) {
      if (existing.name === body.name) throw new RoomAlreadyExistsError(body.name)
    }

    try {
      const created = createRoomRow(
        state.db,
        { name: body.name, maxInteractions: body.max_interactions },
        ownerId,
      )
      return c.json(toRoom(created))
    } catch (error) {
      // The pre-check races, but the index still holds — so a constraint error
      // becomes the same 409 rather than a 500.
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('UNIQUE constraint failed') && message.includes('rooms.')) {
        throw new RoomAlreadyExistsError(body.name)
      }
      throw error
    }
  }

  routes.get('/rooms', listRooms)
  routes.get('/rooms/', listRooms)
  routes.post('/rooms', createRoom)
  routes.post('/rooms/', createRoom)

  routes.get('/rooms/:room_id', (c) =>
    c.json(toRoom(ensureRoomAccessFor(c, state.db, intPathParam(c, 'room_id')))),
  )

  routes.patch('/rooms/:room_id', async (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)

    const body = await parseBody(c, RoomUpdate)
    const updated = updateRoomRow(state.db, roomId, {
      maxInteractions: body.max_interactions,
      isPaused: body.is_paused,
      isFinished: body.is_finished,
    })
    // Reachable only if the row vanished between the access check and here.
    if (updated === null) throw roomNotFound()
    return c.json(toRoom(updated))
  })

  // Pausing stops the room *and* the turn running in it: the flag alone only
  // prevents the next round, leaving mid-response agents to reply into a room
  // the user believes is stopped.
  routes.post('/rooms/:room_id/pause', async (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)

    const room = updateRoomRow(state.db, roomId, { isPaused: true })
    if (room === null) throw roomNotFound()

    await state.orchestrator.interruptRoom(roomId)
    logger.info(`Room ${roomId} paused`)
    return c.json(toRoom(room))
  })

  routes.post('/rooms/:room_id/resume', (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)

    const room = updateRoomRow(state.db, roomId, { isPaused: false })
    if (room === null) throw roomNotFound()

    logger.info(`Room ${roomId} resumed`)
    return c.json(toRoom(room))
  })

  // No `ensureRoomAccessFor` on either: `requireAdmin` has already run, and the
  // service call is what tears down the room's warm agent sessions.
  routes.delete('/rooms/:room_id', requireAdmin, async (c) => {
    const roomId = intPathParam(c, 'room_id')
    const deleted = await state.agents.deleteRoomWithCleanup(state.db, roomId)
    if (!deleted) throw roomNotFound()
    return c.json({ message: 'Room deleted successfully' })
  })

  routes.delete('/rooms/:room_id/messages', requireAdmin, async (c) => {
    const roomId = intPathParam(c, 'room_id')
    const cleared = await state.agents.clearRoomMessagesWithCleanup(state.db, roomId)
    // An empty room and a missing one answer identically, as the `detail` says.
    if (!cleared) throw new HttpError(404, 'Room not found or no messages to delete')
    return c.json({ message: 'All messages cleared successfully' })
  })

  return routes
}
