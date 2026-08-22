/**
 * Chat room CRUD — port of `backend/routers/rooms.py`.
 *
 * Mounted at the root; every path here is written out in full. The collection
 * routes are registered on both `/rooms` and `/rooms/` for the reason spelled
 * out in `routes/game/index.ts`: Python's canonical path carries the trailing
 * slash and Starlette redirects onto it, while Hono is strict and does not.
 *
 * The 404 strings differ from handler to handler and are Python's verbatim —
 * `ensure_room_access` raises `RoomNotFoundError` ("Room with id N not found")
 * while the handlers' own guards say "Room not found". The frontend renders
 * `detail`, so the inconsistency is observable and is reproduced, not tidied.
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

/** Python's guard string, shared by update, pause and resume. */
function roomNotFound(): HttpError {
  return new HttpError(404, 'Room not found')
}

export function createRoomRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  // ---------------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------------

  function listRooms(c: Context<AppEnv>): Response {
    return c.json(getRooms(state.db, identityOf(c)).map(toRoomSummary))
  }

  async function createRoom(c: Context<AppEnv>): Promise<Response> {
    const body = await parseBody(c, RoomCreate)
    const identity = identityOf(c)
    const ownerId = identity.role === 'admin' ? 'admin' : identity.userId

    // Checked before the insert rather than caught after it, and this is
    // deliberate: a chat room has `world_id = NULL`, and the unique index that
    // would catch a duplicate is over (owner_id, name, world_id) — where SQL's
    // NULL != NULL means two chat rooms with the same name never collide.
    // Python does the same pre-check for exactly this reason (`rooms.py:44`).
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
      // The pre-check races: two requests can both pass it. The index still
      // holds, so a constraint error becomes the same 409 rather than a 500.
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

  // ---------------------------------------------------------------------------
  // Single room
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Pause / resume
  // ---------------------------------------------------------------------------

  /**
   * Pausing stops the room *and* the turn already running in it.
   *
   * The flag alone would only prevent the next round; agents mid-response would
   * keep generating, and their replies would land in a room the user believes
   * is stopped. `interruptRoom` is what makes the button mean what it says.
   */
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

  // ---------------------------------------------------------------------------
  // Destructive, admin only
  // ---------------------------------------------------------------------------

  // No `ensureRoomAccess` on either: `requireAdmin` has already run, and
  // Python's handlers take no identity at all — they go straight to the
  // service, which is what also tears down the room's warm agent sessions.
  routes.delete('/rooms/:room_id', requireAdmin, async (c) => {
    const roomId = intPathParam(c, 'room_id')
    const deleted = await state.agents.deleteRoomWithCleanup(state.db, roomId)
    if (!deleted) throw roomNotFound()
    return c.json({ message: 'Room deleted successfully' })
  })

  routes.delete('/rooms/:room_id/messages', requireAdmin, async (c) => {
    const roomId = intPathParam(c, 'room_id')
    const cleared = await state.agents.clearRoomMessagesWithCleanup(state.db, roomId)
    // Python conflates the two cases here, and says so in its `detail`: an
    // empty room and a missing one answer identically.
    if (!cleared) throw new HttpError(404, 'Room not found or no messages to delete')
    return c.json({ message: 'All messages cleared successfully' })
  })

  return routes
}
