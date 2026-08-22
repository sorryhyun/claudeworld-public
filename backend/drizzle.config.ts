import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit configuration.
 *
 * `out` holds the SQL baseline plus its snapshot; both are committed. The
 * baseline is not a proposal — it is generated from `src/db/schema.ts`, which
 * is itself a transcription of the live schema at Alembic head `e872d9c86c83`.
 * Alembic's own history is deliberately *not* replayed: fresh installs get the
 * end state in one statement batch, and existing databases are adopted rather
 * than migrated (see `src/db/migrate.ts`).
 *
 * There is no `dbCredentials` block. Every command that touches a database goes
 * through `src/db/`, which resolves `DATABASE_URL` the way the Python backend
 * does; giving drizzle-kit a second, independently-configured path to the same
 * file is how a `push` ends up clobbering a real `claudeworld.db`.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Human-readable filenames; the baseline should be greppable by name.
  migrations: { prefix: 'index' },
})
