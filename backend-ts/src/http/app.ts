/**
 * Hono application assembly.
 *
 * Ported from `create_app()` in `backend/core/app_factory.py`, minus everything
 * that has no Phase 1 counterpart: the agent manager, chat orchestrator,
 * background scheduler, SSE broadcaster, MCP mount and the PyInstaller static
 * file serving all arrive with the phases that build them.
 *
 * What is here is the skeleton those things hang off — CORS, authentication,
 * error shape and route mounting — and the auth router itself. Middleware order
 * is load-bearing and matches Python's: CORS first so that even a rejected
 * request is readable by the browser, authentication second.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { getCorsOrigins, getSettings } from '../config/settings'
import { getLogger } from '../infrastructure/logging/logger'
import { authMiddleware } from './middleware/auth'
import { createAuthRoutes } from './routes/auth'
import { createGameRoutes } from './routes/game'
import { HttpError } from './errors'
import type { AppState } from './state'
import type { AppEnv } from './types'

const logger = getLogger('AppFactory')

/**
 * @param state Everything that outlives a request — the database, the session
 *   pool, the orchestrator and the filesystem services. Optional only so the
 *   auth surface can be stood up on its own in tests; every game route needs it.
 */
export function createApp(state?: AppState): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const allowedOrigins = getCorsOrigins(getSettings())
  logger.info('🔒 CORS Configuration:')
  logger.info(`   Allowed origins: ${allowedOrigins.join(', ')}`)
  logger.info('   💡 To add more origins, set FRONTEND_URL or VERCEL_URL in .env')

  app.use(
    '*',
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      // `*` is not legal alongside `credentials: true`, so the request's own
      // requested headers are echoed instead — which is what Starlette's
      // `allow_headers=["*"]` does in practice.
      allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
    }),
  )

  app.use('*', authMiddleware)

  app.route('/auth', createAuthRoutes())

  if (state) {
    mountGameRoutes(app, state)
  } else {
    logger.warning('No app state supplied — serving the auth surface only')
  }

  // FastAPI's error envelope. The frontend reads `detail` off failed responses
  // regardless of which endpoint produced them, so 404s and 500s have to carry
  // it too, not just the handlers that raise HTTPException.
  app.notFound((c) => c.json({ detail: 'Not Found' }, 404))
  app.onError((error, c) => {
    // A handler that threw `HttpError` chose its status and its `detail`; the
    // frontend reads that string, so it has to survive rather than being
    // flattened into a 500 the way an unexpected throw is.
    if (error instanceof HttpError) {
      return c.json({ detail: error.detail }, error.status as 400)
    }
    logger.exception(`Unhandled error on ${c.req.method} ${c.req.path}`, error)
    return c.json({ detail: 'Internal Server Error' }, 500)
  })

  return app
}

/**
 * Mount the game surface.
 *
 * Split out so the route modules have exactly one place to be registered, and
 * so the mount paths stay visible next to each other — the frontend's URLs are
 * part of the frozen API contract, and a path typo here is invisible until a
 * page 404s.
 */
function mountGameRoutes(app: Hono<AppEnv>, state: AppState): void {
  // Mounted at the root rather than at `/worlds`: each module writes its own
  // `/worlds/...` paths so that both `/worlds` and `/worlds/` can be served,
  // which a sub-app mounted at `/worlds` cannot express. See
  // `routes/game/index.ts`.
  app.route('/', createGameRoutes(state))
}
