/**
 * How the process listens: port selection, and the dev-mode frontend.
 *
 * Both concerns live together because they are two halves of the same decision.
 * Serving the frontend from the API's own port is what makes the port itself
 * negotiable — the app only ever issues relative URLs, so nothing downstream
 * has to be told which port was won. That was not true while Vite proxied to a
 * hardcoded `127.0.0.1:8000`: a second server cannot follow a port it is not
 * told about, so the port had to be fixed for the proxy's benefit.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getLogger } from '../infrastructure/logging/logger'
import { API_PREFIXES } from './static'

const logger = getLogger('Serve')

/** Bun's HTML import — an opaque bundle handle the dev server knows how to serve. */
type HtmlBundle = Parameters<typeof Bun.serve>[0] extends { routes?: infer R }
  ? R extends Record<string, infer V>
    ? V
    : never
  : never

/**
 * `EADDRINUSE` from `Bun.serve`, distinguished from every other startup error.
 *
 * Bun throws a plain `Error` whose `code` is `EADDRINUSE`; older versions only
 * set the message, so both are checked. Anything else — a permission error on a
 * privileged port, a malformed hostname — must keep propagating, because
 * retrying on a different port would turn a misconfiguration into a server
 * listening somewhere nobody expects.
 */
function isAddressInUse(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(error.message)
}

export interface ListenOptions {
  hostname: string
  /** The port to prefer. `0` asks the OS for an ephemeral one outright. */
  port: number
  routes?: Record<string, unknown>
  /** Turns on Bun's bundler-side HMR for the `routes` HTML entry. */
  development?: { hmr: boolean }
  fetch: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response>
  /**
   * Where to remember a fallback port, so `bun --watch` restarts keep it.
   * Null disables the memory entirely, which is what a one-shot process wants.
   */
  stickyPortFile?: string | null
}

/**
 * Where a fallback port is remembered, for this run and no other.
 *
 * Keyed on the pid, which `bun --watch` keeps stable across restarts while
 * resetting everything inside the process. Two dev servers running at once
 * therefore remember separate ports, and neither inherits a port from a
 * `make dev` that has already exited.
 */
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
 * Listen on the preferred port, falling back to an OS-assigned one.
 *
 * The fallback asks for port `0` rather than probing `8001`, `8002`, … — the
 * kernel hands back a free port atomically, where a probe loop races anything
 * else starting at the same moment and can still lose. `sdk/mcp/endpoint.ts`
 * already binds this way for the same reason.
 *
 * A taken port used to be fatal, and the failure was easy to misread: the
 * backend died on startup while Vite came up fine on 5173 and proxied to
 * whatever else held 8000, so the app loaded and then answered HTML to every
 * API call. Falling back keeps the two halves together.
 */
export function listen(options: ListenOptions): Bun.Server<unknown> {
  const { port, stickyPortFile = stickyPortPath(), ...rest } = options
  const serve = (on: number): Bun.Server<unknown> =>
    Bun.serve({ ...rest, port: on } as Parameters<typeof Bun.serve>[0])

  try {
    return serve(port)
  } catch (error) {
    if (!isAddressInUse(error)) throw error
  }

  // The port this same run was relocated to before, if there was one. Reusing
  // it is what keeps a `bun --watch` restart on the URL already open in a
  // browser tab: port 0 hands back a *different* ephemeral port every time, so
  // without this every save would strand the tab on a dead port. It is only a
  // second preference — if something else took it in the meantime, fall
  // through to a fresh one rather than failing.
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

/**
 * The frontend's `index.html`, bundled on demand by Bun's dev server.
 *
 * Imported dynamically and only when dev mode is on. A static import would make
 * every backend-only entry point — the test suite, `bun run smoke`, the pilot —
 * bundle the entire React app just to reach `main.ts`, and would hard-fail a
 * backend checkout that has no `frontend/` next to it.
 */
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
 * `fetch` fallback — so the API prefixes have to be registered as routes of
 * their own rather than left to fall through. Bun's matcher is segment-aware
 * and ranks specific patterns above wildcards, which is what makes
 * `/mcp-tools` miss `/mcp/*` without the anchored regexes the Vite proxy
 * needed.
 *
 * Each prefix is registered twice because `/auth/*` does not match a bare
 * `/auth`.
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
