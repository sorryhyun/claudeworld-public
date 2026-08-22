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
 * A missing directory is not an error — `make dev` runs Vite on 5173 and never
 * builds `dist/` — but an override that points nowhere is worth a warning,
 * because the person who set it expected pages, not JSON 404s.
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

export function startServer(): { port: number; stop: () => Promise<void> } {
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
  const port = Number(process.env.PORT ?? 8000)

  const server = Bun.serve({
    port,
    hostname: process.env.HOST ?? '0.0.0.0',
    // The second argument is what `getConnInfo` reads the peer address from;
    // without threading it through, rate limiting would bucket every client
    // together.
    fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
  })

  logger.info(`✅ Application startup complete — listening on http://${server.hostname}:${port}`)
  if (frontendDir) {
    logger.info(`🌐 Frontend and API are on the same origin — open http://localhost:${port}`)
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
  const { stop } = startServer()
  const shutdown = (): void => {
    void stop().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
