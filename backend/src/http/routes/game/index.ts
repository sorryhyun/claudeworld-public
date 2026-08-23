/**
 * Five routers, each spelling its own `/worlds/...` paths rather than being
 * mounted under a prefix: Hono does not redirect on trailing slashes, so
 * collection routes must register both `/worlds` and `/worlds/`, which a mounted
 * sub-app cannot express. **Registration order is load-bearing** — Hono matches in
 * registration order, so `worlds` must come first: it owns
 * `GET /worlds/importable`, which also matches its own `GET /worlds/:world_id`.
 */

import { Hono } from 'hono'

import type { AppState } from '@/http/state'
import type { AppEnv } from '@/http/types'
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
