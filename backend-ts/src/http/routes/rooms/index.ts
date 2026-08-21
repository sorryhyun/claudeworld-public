/**
 * The chat-room surface — port of the `rooms`, `room_agents`, `messages` and
 * `sse` routers in `backend/routers/`.
 *
 * Mounted at the root rather than at `/rooms`, for the reason `routes/game`
 * gives: each module writes its own `/rooms/...` paths so that both `/rooms`
 * and `/rooms/` can be answered, which a sub-app mounted at `/rooms` cannot
 * express.
 *
 * **Registration order is load-bearing.** Hono runs matching handlers in
 * registration order, and several paths here overlap:
 *
 * - `POST /rooms/:room_id/stream/ticket` must precede nothing in particular,
 *   but `GET /rooms/:room_id/agents` and `GET /rooms/:room_id/messages` would
 *   both be shadowed by a `GET /rooms/:room_id` registered before them if that
 *   route were a prefix match — it is not, Hono matches full paths, but the
 *   ordering below still mirrors Python's `include_router` order so that any
 *   future overlap resolves the same way in both backends.
 */

import { Hono } from 'hono'

import type { AppState } from '../../state'
import type { AppEnv } from '../../types'
import { createRoomAgentRoutes } from './agents'
import { createRoomMessageRoutes } from './messages'
import { createRoomRoutes } from './rooms'
import { createSseRoutes } from './sse'

export function createChatRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.route('/', createRoomRoutes(state))
  routes.route('/', createRoomAgentRoutes(state))
  routes.route('/', createRoomMessageRoutes(state))
  routes.route('/', createSseRoutes(state))

  return routes
}
