/**
 * Server entrypoint.
 *
 * The counterpart of `backend/main.py` plus the `lifespan` half of
 * `create_app()`. Startup order matters and follows Python's: logging, then the
 * configuration checks that can refuse to start, then the database, then the
 * listener — so a misconfigured install fails with an actionable message rather
 * than accepting requests it cannot serve.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { assertAuthConfigured } from './auth/passwords'
import { DEFAULT_DATABASE_URL, getSettings } from './config/settings'
import { wrapDb } from './db'
import { openAndInitDb, sqlitePathFromUrl } from './db/migrate'
import { createApp } from './http/app'
import { createAppState } from './http/state'
import { getLogger, setupLogging } from './infrastructure/logging/logger'
import { openBrowser, resolveOpenBrowser } from './http/open-browser'
import { buildDevRoutes, listen, loadDevFrontend } from './http/serve'

const logger = getLogger('Main')

/**
 * Where the SQLite file lives.
 *
 * `connection.py` defaults `DATABASE_URL` to PostgreSQL and relies on the
 * Makefile to pass a SQLite URL. There is no Postgres support here, so an unset
 * variable resolves to `<projectRoot>/claudeworld.db` — the file the Makefile
 * would have pointed at — instead of failing on a default nobody chose.
 */
export function resolveDatabasePath(): string {
  const settings = getSettings()
  if (settings.databaseUrl === DEFAULT_DATABASE_URL) {
    return join(settings.paths.projectRoot, 'claudeworld.db')
  }
  return sqlitePathFromUrl(settings.databaseUrl)
}

/**
 * The built frontend to serve on the API's own port, or null for API-only.
 *
 * Resolution order: `SERVE_FRONTEND=false` disables it outright, then
 * `FRONTEND_DIST` if set, then `<projectRoot>/frontend/dist`. Auto-detecting
 * the default is what makes `make serve` a two-step recipe (build, run) rather
 * than something that also has to thread a path through the environment; the
 * explicit override is for a relocated install where the bundle does not sit
 * next to the source tree.
 *
 * A missing directory is not an error — `make dev` bundles `frontend/` in-process
 * ({@link resolveFrontendDev}) and never builds `dist/` — but an override that
 * points nowhere is worth a warning, because the person who set it expected
 * pages, not JSON 404s.
 */
export function resolveFrontendDir(env: Record<string, string | undefined> = process.env): string | null {
  if (env.SERVE_FRONTEND?.trim().toLowerCase() === 'false') return null

  const override = env.FRONTEND_DIST?.trim()
  const dir = override
    ? resolve(override)
    : join(getSettings().paths.projectRoot, 'frontend', 'dist')

  if (existsSync(join(dir, 'index.html'))) return dir

  if (override) {
    logger.warning(`FRONTEND_DIST=${override} has no index.html — serving the API only`)
  }
  return null
}

/**
 * Whether to bundle and serve `frontend/` in-process with HMR.
 *
 * Opt-in (`make dev` sets it) rather than inferred from `NODE_ENV`, because the
 * cost of guessing wrong is asymmetric: a production process that decides it is
 * in dev mode would bundle the React app on the fly and ship unminified code,
 * while `make serve` and the packaged build both want the prebuilt `dist/` that
 * {@link resolveFrontendDir} finds.
 */
export function resolveFrontendDev(env: Record<string, string | undefined> = process.env): boolean {
  return env.FRONTEND_DEV?.trim().toLowerCase() === 'true'
}

export async function startServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const settings = getSettings()
  setupLogging({ debugMode: settings.debugAgents })

  logger.info('🚀 Application startup...')

  assertAuthConfigured()

  const databasePath = resolveDatabasePath()
  logger.info(`💾 Database: ${databasePath}`)
  const sqlite = openAndInitDb({ path: databasePath })

  // `openAndInitDb` hands back the raw `bun:sqlite` handle it migrated; the
  // routers work through Drizzle, so it is wrapped once here rather than in
  // every module that needs it.
  const state = createAppState({ db: wrapDb(sqlite) })

  // Python does this in the `lifespan` startup, right before it accepts
  // requests (`app_factory.py:99-100`). Without it the `agents` table stays
  // empty on a database that has only ever seen this backend, and the first
  // symptom is a *turn* failing — `createWorld` finds no `Onboarding_Manager`
  // row, so it adds nobody to the onboarding room, and `runGameplayTurn` then
  // throws "is in the onboarding phase but has no Onboarding Manager".
  const seeded = Object.keys(state.agentFactory.seedFromConfigs(state.db))
  if (seeded.length) {
    logger.info(`🌱 Seeded ${seeded.length} agent(s) from config files: ${seeded.join(', ')}`)
  }

  // Also from Python's `lifespan`, and after the seeding for the same reason it
  // is there: the first tick can fire two seconds later, and a round wants the
  // `agents` table already populated.
  state.scheduler.start()

  const frontendDir = resolveFrontendDir()
  const app = createApp(state, { frontendDir })

  // The second argument is what `getConnInfo` reads the peer address from;
  // without threading it through, rate limiting would bucket every client
  // together.
  const fetchApi = (request: Request, bunServer: Bun.Server<unknown>): Response | Promise<Response> =>
    app.fetch(request, { server: bunServer })

  // Dev mode bundles the frontend in this process, with HMR, instead of serving
  // a prebuilt `dist/`. That is what collapses `make dev` to one command on one
  // port — and, because the page is then same-origin by construction, what lets
  // the port itself be negotiable below.
  const devHtml = resolveFrontendDev() ? await loadDevFrontend() : null

  const server = listen({
    port: Number(process.env.PORT ?? 8000),
    hostname: process.env.HOST ?? '0.0.0.0',
    ...(devHtml ? { routes: buildDevRoutes(devHtml, fetchApi), development: { hmr: true } } : {}),
    fetch: fetchApi,
  })
  // `Bun.Server.port` is optional only because a server can be bound to a unix
  // socket instead; this one always binds TCP. Read it back rather than reusing
  // the requested value — they differ whenever the fallback in `listen` fired.
  const port = server.port ?? 0

  logger.info(`✅ Application startup complete — listening on http://${server.hostname}:${port}`)
  const url = `http://localhost:${port}`
  if (devHtml) {
    logger.info(`🌐 Frontend (HMR) and API share this origin — open ${url}`)
  } else if (frontendDir) {
    logger.info(`🌐 Frontend and API are on the same origin — open ${url}`)
  }

  // After the listener, never before: the port in `url` is the one that was
  // actually won, which on a fallback is not the one anybody asked for. This
  // is the only place that knows it, so it is the only place that can point a
  // browser at it. Serving a page is a precondition — an API-only process has
  // nothing to show.
  if ((devHtml || frontendDir) && resolveOpenBrowser()) {
    openBrowser(url)
  }

  return {
    port,
    stop: async () => {
      logger.info('🛑 Application shutdown...')
      server.stop()
      // Before the database closes: stopping a turn writes to it (session ids,
      // partial responses), and a turn still unwinding against a closed handle
      // throws where Python's lifespan simply awaited the task.
      await state.shutdown()
      sqlite.close()
      logger.info('✅ Application shutdown complete')
    },
  }
}

if (import.meta.main) {
  const { stop } = await startServer()
  const shutdown = (): void => {
    void stop().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
