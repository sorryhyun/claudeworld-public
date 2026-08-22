// Server entrypoint. Startup order matters — logging, config checks that can
// refuse to start, database, listener — so a misconfigured install fails
// loudly instead of accepting requests it cannot serve.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { assertAuthConfigured } from './auth/passwords'
import { DEFAULT_DATABASE_URL, getSettings } from './config/settings'
import { wrapDb } from './db'
import { openAndInitDb, sqlitePathFromUrl } from './db/migrate'
import { createApp } from './http/app'
import { createAppState } from './http/state'
import { getLogger, setupLogging } from './infrastructure/logging/logger'
import { embeddedFrontend } from './exe/assets'
import { openBrowser, resolveOpenBrowser } from './http/open-browser'
import { buildDevRoutes, listen, loadDevFrontend } from './http/serve'
import { migrateWorldDataToJson } from './services/world-json-migration'

const logger = getLogger('Main')

/** An unset `DATABASE_URL` resolves to `<projectRoot>/claudeworld.db`. */
export function resolveDatabasePath(): string {
  const settings = getSettings()
  if (settings.databaseUrl === DEFAULT_DATABASE_URL) {
    return join(settings.paths.projectRoot, 'claudeworld.db')
  }
  return sqlitePathFromUrl(settings.databaseUrl)
}

// The built frontend to serve on the API's own port, or null for API-only. A
// missing directory is fine — `make dev` never builds `dist/` — but an
// explicit `FRONTEND_DIST` pointing nowhere warns.
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

// Opt-in, not inferred from `NODE_ENV`: a production process guessing dev mode
// would bundle React on the fly and ship unminified code.
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

  // Before any world is read: an install upgraded from a YAML-era release has
  // `worlds/` preserved on disk and nothing left that can read it.
  migrateWorldDataToJson(settings.paths.worldsDir)

  // The raw `bun:sqlite` handle, wrapped once here so no other module has to.
  const state = createAppState({ db: wrapDb(sqlite) })

  // Before requests are accepted, or the `agents` table stays empty and the
  // first symptom is a turn failing mid-onboarding.
  const seeded = Object.keys(state.agentFactory.seedFromConfigs(state.db))
  if (seeded.length) {
    logger.info(`🌱 Seeded ${seeded.length} agent(s) from config files: ${seeded.join(', ')}`)
  }

  // After the seeding: the first tick can fire two seconds later and a round
  // wants the `agents` table already populated.
  state.scheduler.start()

  // The binary's own frontend first: `Bun.embeddedFiles` is empty in a repo run,
  // so this is null there and the disk lookup decides as before.
  const embedded = embeddedFrontend()
  const frontendDir = embedded ? null : resolveFrontendDir()
  const app = createApp(state, { frontendDir, embeddedFrontend: embedded })

  // `getConnInfo` reads the peer address off the second argument; without it
  // rate limiting buckets every client together.
  const fetchApi = (request: Request, bunServer: Bun.Server<unknown>): Response | Promise<Response> =>
    app.fetch(request, { server: bunServer })

  // Bundling the frontend in-process collapses `make dev` to one port and —
  // the page being same-origin — lets that port be negotiable.
  // `loadDevFrontend` imports `frontend/index.html` dynamically: a static
  // import would make backend-only entry points bundle React.
  const devHtml = resolveFrontendDev() ? await loadDevFrontend() : null

  const server = listen({
    port: Number(process.env.PORT ?? 8000),
    hostname: process.env.HOST ?? '0.0.0.0',
    ...(devHtml ? { routes: buildDevRoutes(devHtml, fetchApi), development: { hmr: true } } : {}),
    fetch: fetchApi,
  })
  // Read back rather than reusing the requested value: they differ whenever the
  // port fallback in `listen` fired.
  const port = server.port ?? 0

  logger.info(`✅ Application startup complete — listening on http://${server.hostname}:${port}`)
  const url = `http://localhost:${port}`
  if (devHtml) {
    logger.info(`🌐 Frontend (HMR) and API share this origin — open ${url}`)
  } else if (embedded || frontendDir) {
    logger.info(`🌐 Frontend and API are on the same origin — open ${url}`)
  }

  // After the listener, never before: `url` carries the port actually won.
  if ((devHtml || embedded || frontendDir) && resolveOpenBrowser()) {
    openBrowser(url)
  }

  return {
    port,
    stop: async () => {
      logger.info('🛑 Application shutdown...')
      server.stop()
      // Before the database closes: stopping a turn writes to it.
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
