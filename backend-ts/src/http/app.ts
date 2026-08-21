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
import type { AppEnv } from './types'

const logger = getLogger('AppFactory')

export function createApp(): Hono<AppEnv> {
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

  // FastAPI's error envelope. The frontend reads `detail` off failed responses
  // regardless of which endpoint produced them, so 404s and 500s have to carry
  // it too, not just the handlers that raise HTTPException.
  app.notFound((c) => c.json({ detail: 'Not Found' }, 404))
  app.onError((error, c) => {
    logger.exception(`Unhandled error on ${c.req.method} ${c.req.path}`, error)
    return c.json({ detail: 'Internal Server Error' }, 500)
  })

  return app
}
