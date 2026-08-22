// Middleware order is load-bearing: CORS first, so even a rejected request is
// readable by the browser, authentication second.

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
import { HttpError } from '../domain/errors'
import { createEmbeddedFrontendMiddleware, createFrontendMiddleware } from './static'
import type { AppState } from './state'
import type { AppEnv } from './types'

const logger = getLogger('AppFactory')

export interface CreateAppOptions {
  /**
   * A built frontend to serve alongside the API; null serves the API only.
   * Passed in, not discovered here, so a stale `frontend/dist` cannot turn the
   * test suite's expected JSON 404s into HTML.
   */
  readonly frontendDir?: string | null
  /**
   * The frontend the compiled executable carries inside it, as rooted URL path
   * → embedded file path. Takes precedence over {@link frontendDir}: a binary
   * dropped into a directory that happens to contain a `frontend/dist` must
   * still serve the build it was compiled with.
   */
  readonly embeddedFrontend?: Record<string, string> | null
}

/** @param state Optional only so tests can stand up the auth surface alone. */
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
      // `*` is not legal alongside `credentials: true`.
      allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
    }),
  )

  // Ahead of auth on purpose: a deep link carries no API key, and the page it
  // wants is the one that will *do* the logging in.
  if (options.embeddedFrontend) {
    const count = Object.keys(options.embeddedFrontend).length
    logger.info(`📦 Serving ${count} frontend files embedded in the executable`)
    app.use('*', createEmbeddedFrontendMiddleware(options.embeddedFrontend))
  } else if (options.frontendDir) {
    logger.info(`📦 Serving frontend from ${options.frontendDir}`)
    app.use('*', createFrontendMiddleware(options.frontendDir))
  }

  app.use('*', authMiddleware)

  app.route('/auth', createAuthRoutes(state?.pool))

  app.route('/', createReadmeRoutes(state?.projectRoot ?? getSettings().paths.projectRoot))
  app.route('/', createDebugRoutes())

  if (state) {
    mountGameRoutes(app, state)
  } else {
    logger.warning('No app state supplied — serving the auth surface only')
  }

  // The frontend reads `detail` off every failed response, 404s and 500s too.
  app.notFound((c) => c.json({ detail: 'Not Found' }, 404))
  app.onError((error, c) => {
    // A thrown `HttpError` chose its status and `detail`; both must survive.
    if (error instanceof HttpError) {
      return c.json({ detail: error.detail }, error.status as 400)
    }
    logger.exception(`Unhandled error on ${c.req.method} ${c.req.path}`, error)
    return c.json({ detail: 'Internal Server Error' }, 500)
  })

  return app
}

// Split out so the mount paths stay visible together: they are the frozen API
// contract, and a typo is invisible until a page 404s.
function mountGameRoutes(app: Hono<AppEnv>, state: AppState): void {
  // Mounted at the root: each module writes its own paths, so both `/worlds` and
  // `/worlds/` are served — a sub-app mounted at `/worlds` cannot.
  app.route('/', createGameRoutes(state))
  // Same story for `/rooms` and `/agents`.
  app.route('/', createChatRoutes(state))
  app.route('/', createAgentRoutes(state))
  // Prefix declared on the router itself; needs state, unlike the mounts above.
  app.route('/', createMcpToolsRoutes(state))
}
