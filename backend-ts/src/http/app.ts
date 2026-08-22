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
import { createAgentRoutes } from './routes/agents'
import { createChatRoutes } from './routes/rooms'
import { createDebugRoutes } from './routes/debug'
import { createGameRoutes } from './routes/game'
import { createMcpToolsRoutes } from './routes/mcp-tools'
import { createReadmeRoutes } from './routes/readme'
import { HttpError } from './errors'
import { createFrontendMiddleware } from './static'
import type { AppState } from './state'
import type { AppEnv } from './types'

const logger = getLogger('AppFactory')

export interface CreateAppOptions {
  /**
   * Directory of a built frontend (`frontend/dist`) to serve alongside the API,
   * so one port answers both. Null/undefined serves the API only.
   *
   * Passed in rather than discovered here: `createApp()` is what the test suite
   * drives, and a `frontend/dist` left behind by a `bun run build` would
   * otherwise turn every expected JSON 404 into HTML depending on whether the
   * developer had built recently. {@link resolveFrontendDir} in `main.ts` owns
   * the decision.
   */
  readonly frontendDir?: string | null
}

/**
 * @param state Everything that outlives a request — the database, the session
 *   pool, the orchestrator and the filesystem services. Optional only so the
 *   auth surface can be stood up on its own in tests; every game route needs it.
 */
export function createApp(state?: AppState, options: CreateAppOptions = {}): Hono<AppEnv> {
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

  // Ahead of auth on purpose: a deep link into a client-side route carries no
  // API key, and the page it needs is the one that will *do* the logging in.
  // See the module header in `static.ts`.
  if (options.frontendDir) {
    logger.info(`📦 Serving frontend from ${options.frontendDir}`)
    app.use('*', createFrontendMiddleware(options.frontendDir))
  }

  app.use('*', authMiddleware)

  app.route('/auth', createAuthRoutes(state?.pool))

  // Neither of these needs app state, and Python mounts both unconditionally —
  // `/readme` is what the help modal reads, and `/debug/cache/*` is how a
  // running backend is poked at. Both stay behind auth, as in Python.
  app.route('/', createReadmeRoutes(state?.projectRoot ?? getSettings().paths.projectRoot))
  app.route('/', createDebugRoutes())

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
  // Same story for `/rooms` and `/agents`.
  app.route('/', createChatRoutes(state))
  app.route('/', createAgentRoutes(state))
  // Python mounts this one with no prefix too; the `/mcp-tools/` prefix is
  // declared on the router itself. It needs state, so it cannot sit beside the
  // stateless `/readme` and `/debug` mounts above.
  app.route('/', createMcpToolsRoutes(state))
}
