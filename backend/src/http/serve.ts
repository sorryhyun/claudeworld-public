// Port selection and the dev-mode frontend. Serving the frontend from the API's
// own port is what makes the port negotiable: the app only issues relative URLs.

import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getLogger } from '@/infrastructure/logging/logger'
import { KEEPALIVE_INTERVAL_MS } from '@/infrastructure/sse'
import { API_PREFIXES } from './static'

const logger = getLogger('Serve')

/**
 * How long Bun may hold a connection with no traffic on it. Set explicitly
 * because Bun's default is 10 seconds — *shorter* than the SSE keepalive, so
 * every quiet room had its stream cut mid-chunk (`ERR_INCOMPLETE_CHUNKED_ENCODING`
 * in the browser) and reconnected a second later. `routes/rooms/sse.ts` has no
 * catch-up replay, so anything broadcast in that gap only ever reached the
 * client through the polling fallback — arriving after the turn had visibly
 * finished. Derived from the keepalive rather than written as a literal so the
 * two cannot drift back past each other; Bun caps the value at 255 seconds.
 */
export const IDLE_TIMEOUT_SECONDS = Math.min(255, Math.ceil((KEEPALIVE_INTERVAL_MS / 1000) * 3))

type HtmlBundle = Parameters<typeof Bun.serve>[0] extends { routes?: infer R }
  ? R extends Record<string, infer V>
    ? V
    : never
  : never

// Bun sets `code` on newer versions and only the message on older ones. Any
// *other* startup error must propagate: retrying elsewhere would turn a
// misconfiguration into a server nobody expects.
function isAddressInUse(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(error.message)
}

export interface ListenOptions {
  hostname: string
  port: number
  routes?: Record<string, unknown>
  development?: { hmr: boolean }
  fetch: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response>
  /** Where to remember a fallback port; null disables the memory entirely. */
  stickyPortFile?: string | null
}

// Keyed on the pid, which `bun --watch` keeps stable across restarts, so two dev
// servers remember separate ports and neither inherits one from an exited run.
export function stickyPortPath(pid: number = process.pid, dir: string = tmpdir()): string {
  return join(dir, `claudeworld-port-${pid}`)
}

function readStickyPort(path: string | null | undefined): number | null {
  if (!path) return null
  try {
    const port = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

/**
 * Listen on the preferred port, falling back to an OS-assigned one. The fallback
 * asks for port `0` rather than probing upward: the kernel hands one back
 * atomically, where a probe loop races and can still lose.
 */
export function listen(options: ListenOptions): Bun.Server<unknown> {
  const { port, stickyPortFile = stickyPortPath(), ...rest } = options
  const serve = (on: number): Bun.Server<unknown> =>
    Bun.serve({ ...rest, port: on, idleTimeout: IDLE_TIMEOUT_SECONDS } as Parameters<
      typeof Bun.serve
    >[0])

  try {
    return serve(port)
  } catch (error) {
    if (!isAddressInUse(error)) throw error
  }

  // Reusing the port this run was relocated to before keeps a `bun --watch`
  // restart on the URL already open in a browser tab, since port 0 hands back a
  // *different* port every time. Only a second preference.
  const remembered = readStickyPort(stickyPortFile)
  if (remembered !== null && remembered !== port) {
    try {
      const server = serve(remembered)
      logger.warning(`Port ${port} is already in use — listening on ${remembered} again`)
      return server
    } catch (error) {
      if (!isAddressInUse(error)) throw error
    }
  }

  const server = serve(0)
  logger.warning(`Port ${port} is already in use — listening on ${server.port} instead`)
  if (stickyPortFile && server.port) {
    try {
      writeFileSync(stickyPortFile, `${server.port}\n`)
    } catch {
      // Costs a new port (and a stale tab) on the next restart, nothing more.
    }
  }
  return server
}

// The import is dynamic: a static one would make every backend-only entry point
// bundle the whole React app to reach `main.ts`, and hard-fail a checkout with
// no `frontend/` beside it.
export async function loadDevFrontend(): Promise<HtmlBundle | null> {
  try {
    const module = await import('../../../frontend/index.html')
    return module.default as HtmlBundle
  } catch (error) {
    logger.warning(`FRONTEND_DEV is set but frontend/index.html could not be loaded: ${String(error)}`)
    return null
  }
}

/**
 * Route table putting the SPA on `/*` and the API on everything it owns.
 *
 * A bare `/*` would shadow `fetch` entirely — Bun's router always beats the
 * `fetch` fallback — so every API prefix must be registered as its own route,
 * twice, because `/auth/*` does not match a bare `/auth`. Bun's matcher is
 * segment-aware, which is what makes `/mcp-tools` miss `/mcp/*`.
 */
export function buildDevRoutes(
  html: HtmlBundle,
  fetchApi: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response>,
): Record<string, unknown> {
  const routes: Record<string, unknown> = {}
  for (const prefix of API_PREFIXES) {
    const handler = (request: Request, server: Bun.Server<unknown>) => fetchApi(request, server)
    routes[prefix] = handler
    routes[`${prefix}/*`] = handler
  }
  routes['/*'] = html
  return routes
}
