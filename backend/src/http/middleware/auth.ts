/**
 * JWT authentication middleware.
 *
 * Ported from `AuthMiddleware` in `backend/infrastructure/auth.py`. The
 * exclusion rules are copied one for one, including the ones that have no
 * counterpart on this stack yet: the parity contract freezes the API surface,
 * and an endpoint that is unauthenticated in Python must not become
 * authenticated here just because it does not exist yet.
 *
 * Python needed a pure-ASGI middleware rather than `BaseHTTPMiddleware` so SSE
 * and the MCP endpoint could stream. Hono middleware is already a plain
 * `(context, next)` wrapper with no buffering, so that concern does not arise.
 */

import { createMiddleware } from 'hono/factory'

import { roleFromPayload, userIdFromPayload, validateJwtToken } from '../../auth/jwt'
import type { AppEnv } from '../types'

/** Paths that never require a token. */
const EXCLUDED_PATHS: ReadonlySet<string> = new Set([
  '/',
  // FastAPI's docs routes. There is no equivalent here yet; they stay listed so
  // that adding an OpenAPI page later does not silently put it behind auth.
  '/docs',
  '/openapi.json',
  '/redoc',
  '/auth/login',
  '/auth/health',
])

const EXCLUDED_PREFIXES: readonly string[] = ['/mcp', '/assets']

const STATIC_EXTENSIONS: readonly string[] = [
  '.css',
  '.js',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.map',
]

/** Whether a request may proceed without a token. */
export function isExcluded(path: string, method: string): boolean {
  if (EXCLUDED_PATHS.has(path)) return true
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  if (STATIC_EXTENSIONS.some((extension) => path.endsWith(extension))) return true

  // Profile pictures are rendered by <img> tags, which cannot send a header.
  if (path.startsWith('/agents/') && path.endsWith('/profile-pic')) return true

  // The SSE stream authenticates with a single-use ticket in the query string
  // instead, because EventSource cannot send custom headers either.
  if (path.startsWith('/rooms/') && path.includes('/stream') && method === 'GET') return true

  // Preflight carries no credentials by definition.
  if (method === 'OPTIONS') return true

  return false
}

/**
 * Reject unauthenticated requests, and attach role and user id to the rest.
 *
 * The 401 body is `{"detail": ...}` — FastAPI's `HTTPException` shape, which
 * the frontend reads directly (`errorData.detail`) — and it carries CORS
 * headers of its own. Hono's CORS middleware runs before this one and would
 * normally cover that, but the header set is reproduced here for the same
 * reason Python does it: a 401 that the browser hides behind a CORS error tells
 * the user "network problem" when the truth is "your session expired".
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (isExcluded(path, c.req.method)) return next()

  const token = c.req.header('x-api-key') || null
  const payload = token ? await validateJwtToken(token) : null

  if (!payload) {
    const origin = c.req.header('origin')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (origin) {
      headers['access-control-allow-origin'] = origin
      headers['access-control-allow-credentials'] = 'true'
      headers['access-control-allow-methods'] = '*'
      headers['access-control-allow-headers'] = '*'
    }
    return new Response(JSON.stringify({ detail: 'Invalid or missing authentication token' }), {
      status: 401,
      headers,
    })
  }

  c.set('userRole', roleFromPayload(payload) ?? 'admin')
  c.set('userId', userIdFromPayload(payload) ?? 'admin')

  return next()
})

/**
 * Require the admin role.
 *
 * Port of the `require_admin` dependency. Guests may chat; everything that
 * mutates rooms, agents or messages goes through this.
 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('userRole') !== 'admin') {
    return c.json(
      {
        detail:
          'This action requires admin privileges. Guests can chat but cannot modify rooms, agents, or messages.',
      },
      403,
    )
  }
  return next()
})
