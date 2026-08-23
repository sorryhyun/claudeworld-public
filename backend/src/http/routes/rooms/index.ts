/**
 * The chat-room surface. Mounted at the root rather than at `/rooms` so each
 * module writes its own `/rooms/...` paths and both `/rooms` and `/rooms/` are
 * answerable. Hono matches in registration order, so keep the order below when
 * adding a route that could overlap an existing one.
 */

import { Hono } from 'hono'

import type { AppState } from '@/http/state'
import type { AppEnv } from '@/http/types'
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
