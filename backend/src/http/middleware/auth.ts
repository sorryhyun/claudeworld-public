/**
 * JWT authentication middleware. Every exclusion below is a deliberate hole,
 * paired with the check that replaces it; removing either half breaks the pair.
 * The static middleware runs *before* this one, because a deep link carries no
 * `X-API-Key`.
 */

import { createMiddleware } from 'hono/factory'

import { roleFromPayload, userIdFromPayload, validateJwtToken } from '../../auth/jwt'
import type { AppEnv } from '../types'

/** Paths that never require a token. */
const EXCLUDED_PATHS: ReadonlySet<string> = new Set([
  '/',
  // Listed so adding an OpenAPI page later does not silently authenticate it.
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

export function isExcluded(path: string, method: string): boolean {
  if (EXCLUDED_PATHS.has(path)) return true
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  if (STATIC_EXTENSIONS.some((extension) => path.endsWith(extension))) return true

  // Profile pictures are rendered by <img> tags, which cannot send a header.
  if (path.startsWith('/agents/') && path.endsWith('/profile-pic')) return true

  // The SSE stream authenticates with a single-use ticket instead; EventSource
  // cannot send custom headers either.
  if (path.startsWith('/rooms/') && path.includes('/stream') && method === 'GET') return true

  // Preflight carries no credentials by definition.
  if (method === 'OPTIONS') return true

  return false
}

/**
 * The 401 repeats the CORS headers deliberately: one the browser hides behind a
 * CORS error reads as "network problem" when the truth is "session expired".
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

/** Guests may chat; everything that mutates goes through this. */
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
