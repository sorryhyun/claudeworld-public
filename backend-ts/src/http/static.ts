/**
 * Single-port frontend serving.
 *
 * Port of the `sys.frozen` branch at the bottom of
 * `backend/core/app_factory.py`, generalised from "only inside the PyInstaller
 * bundle" to "whenever a built frontend is pointed at". That is what lets one
 * `bun src/main.ts` answer both `GET /worlds` and `GET /` on port 8000, with no
 * second server and no CORS in the picture at all.
 *
 * **This middleware runs before {@link authMiddleware}, and that is
 * load-bearing.** A deep link like `/game/abc` carries no `X-API-Key` — the
 * browser is asking for the HTML that will later log in — so if auth ran first
 * every client-side route would 401 instead of booting the app. Auth's
 * `EXCLUDED_PATHS` already lists `/`, `/assets` and the static file extensions
 * for the same reason; running ahead of it covers the SPA routes that no
 * extension list can enumerate.
 *
 * The consequence of ordering it first is that the API prefixes have to be
 * named explicitly ({@link API_PREFIXES}): anything not on that list and not on
 * disk gets `index.html`, exactly as Python's SPA 404 handler does. A new
 * top-level router therefore has to be added to that list, or its 404s come
 * back as HTML.
 */

import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'

import { createMiddleware } from 'hono/factory'

import { getLogger } from '../infrastructure/logging/logger'
import type { AppEnv } from './types'

const logger = getLogger('StaticFiles')

/**
 * Top-level paths owned by the API rather than by the SPA.
 *
 * Mirrors `API_PREFIXES` in `app_factory.py`, including the routers that only
 * exist in the Python tree (`/messages`) and the FastAPI docs paths that have
 * no counterpart here yet: a request the Python backend answers with a JSON 404
 * must not start answering with HTML just because this backend has not grown
 * that router.
 *
 * Matching here is *segment-aware* ({@link isApiPath}), unlike Python's bare
 * `str.startswith` — so `/mcp` does not cover `/mcp-tools` and the two are
 * listed separately, as they are in `frontend/vite.config.ts`. Python gets away
 * with one entry; this list cannot.
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

/**
 * Whether a path belongs to the API.
 *
 * Segment-aware rather than a bare `startsWith`, so `/agent-configs` is not
 * swallowed by the `/agents` entry — and so a future SPA route called
 * `/authors` is not mistaken for `/auth`.
 */
export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/**
 * Map a URL path to a file inside `root`, or null if it does not resolve to one.
 *
 * Returns null rather than throwing for traversal attempts (`/../.env`), for
 * directories, and for anything that simply is not there — every one of those
 * cases has the same answer at the call site: fall through to `index.html`.
 */
export function resolveStaticFile(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    // A malformed %-escape cannot name a file we are willing to serve.
    return null
  }

  // A NUL byte truncates the path at the syscall boundary, so `/app.js\0.png`
  // would pass an extension check and open something else.
  if (decoded.includes('\0')) return null

  const candidate = resolve(join(root, normalize(decoded)))
  // `root + sep` and not `root`: a sibling directory named `dist-backup` shares
  // the prefix `dist` but is outside the tree.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null

  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

/**
 * `Cache-Control` for a built asset.
 *
 * Vite fingerprints everything under `assets/`, so those are immutable for a
 * year; `index.html` is the mutable pointer at them and must never be held,
 * or a deploy leaves clients loading a stale bundle graph. Everything else
 * (`favicon.svg`, `locales/*.json`) is unhashed but cheap to revalidate.
 */
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

  // Bun streams a `BunFile` body without reading it, but a HEAD response must
  // not carry one at all — so the length is reported and the body dropped.
  const size = file.size
  if (method === 'HEAD') {
    headers.set('content-length', String(size))
    return new Response(null, { headers })
  }

  return new Response(file, { headers })
}

/**
 * Serve `distDir` for every non-API GET.
 *
 * @param distDir A directory containing `index.html` — `frontend/dist`.
 */
export function createFrontendMiddleware(distDir: string) {
  const root = resolve(distDir)
  const indexPath = join(root, 'index.html')

  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method
    // A POST to an unknown path is a client bug, not a page load; letting it
    // fall through keeps it a JSON 404 instead of a 200 full of HTML.
    if (method !== 'GET' && method !== 'HEAD') return next()

    const urlPath = new URL(c.req.url).pathname
    if (isApiPath(urlPath)) return next()

    const file = resolveStaticFile(root, urlPath)
    if (file !== null) {
      return respondWithFile(file, urlPath, file === indexPath, method)
    }

    // Client-side route (or a genuinely missing file): hand back the shell and
    // let the router sort it out, which is what makes deep links work.
    //
    // `Bun.file()` on a missing path fails when the body is *read*, i.e. after
    // the 200 has gone out, so the check is here rather than around a throw.
    if (!existsSync(indexPath)) {
      logger.error(`Frontend build is missing ${indexPath}`)
      return c.json({ detail: 'Not Found' }, 404)
    }
    return respondWithFile(indexPath, urlPath, true, method)
  })
}
