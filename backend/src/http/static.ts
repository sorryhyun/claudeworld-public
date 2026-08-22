/**
 * Single-port frontend serving.
 *
 * **This middleware runs before `authMiddleware`, and that is load-bearing.** A
 * deep link like `/game/abc` carries no `X-API-Key` — it is asking for the HTML
 * that will later log in — so auth running first would 401 every client-side
 * route instead of booting the app. The cost: the API prefixes must be named
 * explicitly in {@link API_PREFIXES}, because anything not on that list and not
 * on disk gets `index.html`.
 */

import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'

import { createMiddleware } from 'hono/factory'

import { getLogger } from '../infrastructure/logging/logger'
import type { AppEnv } from './types'

const logger = getLogger('StaticFiles')

/**
 * Top-level paths owned by the API rather than by the SPA. **Every top-level
 * router must appear here** or its 404s come back as HTML; entries with no
 * router yet keep those paths JSON 404s. Matching is segment-aware, so `/mcp`
 * does not cover `/mcp-tools`. `buildDevRoutes` in `serve.ts` reads this same
 * array — one copy covers both run modes.
 */
export const API_PREFIXES: readonly string[] = [
  '/auth',
  '/worlds',
  '/rooms',
  '/messages',
  '/agents',
  '/agent-configs',
  '/readme',
  '/debug',
  '/mcp',
  '/mcp-tools',
  '/docs',
  '/openapi.json',
  '/redoc',
]

// Segment-aware rather than a bare `startsWith`, so `/agent-configs` is not
// swallowed by the `/agents` entry.
export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

// Null — never a throw — for traversal attempts, directories and anything
// missing: all fall through to `index.html` at the call site.
export function resolveStaticFile(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }

  // A NUL byte truncates the path at the syscall boundary.
  if (decoded.includes('\0')) return null

  const candidate = resolve(join(root, normalize(decoded)))
  // `root + sep`, not `root`: a sibling `dist-backup` shares the prefix `dist`.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null

  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

// `assets/` is fingerprinted, so immutable for a year; `index.html` is the
// mutable pointer at it and must never be held, or a deploy leaves clients
// loading a stale bundle graph.
function cacheControlFor(urlPath: string, isIndex: boolean): string {
  if (isIndex) return 'no-cache'
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  return 'public, max-age=3600'
}

async function respondWithFile(
  filePath: string,
  urlPath: string,
  isIndex: boolean,
  method: string,
): Promise<Response> {
  const file = Bun.file(filePath)
  const headers = new Headers({
    'content-type': file.type || 'application/octet-stream',
    'cache-control': cacheControlFor(urlPath, isIndex),
  })

  // A HEAD response must carry no body, only the length.
  const size = file.size
  if (method === 'HEAD') {
    headers.set('content-length', String(size))
    return new Response(null, { headers })
  }

  return new Response(file, { headers })
}

/** Serve `distDir` (a directory containing `index.html`) for every non-API GET. */
export function createFrontendMiddleware(distDir: string) {
  const root = resolve(distDir)
  const indexPath = join(root, 'index.html')

  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method
    // A POST to an unknown path is a client bug, not a page load; falling
    // through keeps it a JSON 404 instead of a 200 full of HTML.
    if (method !== 'GET' && method !== 'HEAD') return next()

    const urlPath = new URL(c.req.url).pathname
    if (isApiPath(urlPath)) return next()

    const file = resolveStaticFile(root, urlPath)
    if (file !== null) {
      return respondWithFile(file, urlPath, file === indexPath, method)
    }

    // Client-side route or genuinely missing file: hand back the shell so deep
    // links work. `Bun.file()` on a missing path fails when the body is *read*,
    // after the 200, hence the explicit existence check.
    if (!existsSync(indexPath)) {
      logger.error(`Frontend build is missing ${indexPath}`)
      return c.json({ detail: 'Not Found' }, 404)
    }
    return respondWithFile(indexPath, urlPath, true, method)
  })
}
