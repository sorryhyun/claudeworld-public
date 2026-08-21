/**
 * The game surface — port of `backend/routers/game/__init__.py`.
 *
 * Python assembles five routers under `APIRouter(prefix="/worlds")` and
 * `app_factory.py` includes the result with no further prefix, so every path
 * below begins `/worlds`. That prefix is written out in each module rather than
 * applied here, for two reasons:
 *
 * - Hono's router is strict about trailing slashes and does not redirect, so the
 *   collection routes have to be registered as both `/worlds` and `/worlds/` to
 *   answer everything Starlette answers. A mounted sub-app cannot express the
 *   second spelling.
 * - The paths are a frozen contract with `frontend/`, and a literal path is
 *   greppable from the frontend call site in a way `mergePath` is not.
 *
 * **Registration order is Python's and is load-bearing.** Hono runs matching
 * handlers in the order they were registered, so `worlds` must come first: it
 * owns `GET /worlds/importable`, which also matches its own
 * `GET /worlds/:world_id`. The remaining four do not overlap each other.
 */

import { Hono } from 'hono'

import type { AppState } from '../../state'
import type { AppEnv } from '../../types'
import { createActionRoutes } from './actions'
import { createLocationRoutes } from './locations'
import { createPollingRoutes } from './polling'
import { createStateRoutes } from './state'
import { createWorldRoutes } from './worlds'

export function createGameRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.route('/', createWorldRoutes(state))
  routes.route('/', createActionRoutes(state))
  routes.route('/', createLocationRoutes(state))
  routes.route('/', createStateRoutes(state))
  routes.route('/', createPollingRoutes(state))

  return routes
}
