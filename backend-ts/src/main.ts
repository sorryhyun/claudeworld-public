/**
 * Server entrypoint.
 *
 * The counterpart of `backend/main.py` plus the `lifespan` half of
 * `create_app()`. Startup order matters and follows Python's: logging, then the
 * configuration checks that can refuse to start, then the database, then the
 * listener — so a misconfigured install fails with an actionable message rather
 * than accepting requests it cannot serve.
 */

import { join } from 'node:path'

import { assertAuthConfigured } from './auth/passwords'
import { DEFAULT_DATABASE_URL, getSettings } from './config/settings'
import { openAndInitDb, sqlitePathFromUrl } from './db/migrate'
import { createApp } from './http/app'
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

export function startServer(): { port: number; stop: () => void } {
  const settings = getSettings()
  setupLogging({ debugMode: settings.debugAgents })

  logger.info('🚀 Application startup...')

  assertAuthConfigured()

  const databasePath = resolveDatabasePath()
  logger.info(`💾 Database: ${databasePath}`)
  const sqlite = openAndInitDb({ path: databasePath })

  const app = createApp()
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

  return {
    port,
    stop: () => {
      logger.info('🛑 Application shutdown...')
      server.stop()
      sqlite.close()
      logger.info('✅ Application shutdown complete')
    },
  }
}

if (import.meta.main) {
  const { stop } = startServer()
  process.on('SIGINT', () => {
    stop()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    stop()
    process.exit(0)
  })
}
