/**
 * Schema initialisation at startup. Three cases: an empty database gets every
 * migration; a populated one not under Drizzle control is *adopted* — verified
 * against `schema.ts`, then stamped, so the baseline never runs against tables
 * that already exist; one under Drizzle control gets what it has not seen.
 *
 * Nothing here writes DDL to a populated database. If the schema is short of
 * what `schema.ts` declares, startup fails rather than guessing at an ALTER.
 */

import { Database } from 'bun:sqlite'
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getLogger } from '../infrastructure/logging/logger'
import { describeDeclaredSchema, describeLiveSchema, diffSchemas } from './introspect'

const logger = getLogger('Database')

/** Drizzle's bookkeeping table; the name is fixed by `SQLiteSyncDialect`. */
const MIGRATIONS_TABLE = '__drizzle_migrations'

// Stamped into `alembic_version` on a fresh install. Vestigial, but a present
// and empty table reads as "under Alembic control but at no revision".
export const ALEMBIC_HEAD_REVISION = 'e872d9c86c83'

export function migrationsFolder(): string {
  return join(dirname(dirname(import.meta.dir)), 'drizzle')
}

export function loadMigrations(folder: string = migrationsFolder()): MigrationMeta[] {
  return readMigrationFiles({ migrationsFolder: folder })
}

export class SchemaDriftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaDriftError'
  }
}

function tableExists(sqlite: Database, name: string): boolean {
  return (
    sqlite
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)?.n ?? 0
  ) > 0
}

// `alembic_version` counts as an application table: a database holding only
// that was stamped and then had its tables dropped, not freshly installed.
function hasAnyTable(sqlite: Database): boolean {
  const row = sqlite
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' " +
        `AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '${MIGRATIONS_TABLE}'`,
    )
    .get()
  return (row?.n ?? 0) > 0
}

function ensureMigrationsTable(sqlite: Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (` +
      'id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  )
}

function lastAppliedMillis(sqlite: Database): number | null {
  if (!tableExists(sqlite, MIGRATIONS_TABLE)) return null
  const row = sqlite
    .query<{ created_at: number | null }, []>(
      `SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`,
    )
    .get()
  return row?.created_at == null ? null : Number(row.created_at)
}

/**
 * Apply migrations newer than what the database has seen. A deliberate
 * re-implementation of drizzle's `migrate()` so it and {@link stampMigrations}
 * share one applied-check: `created_at < folderMillis` on the newest row.
 */
export function applyMigrations(sqlite: Database, migrations: MigrationMeta[]): number {
  ensureMigrationsTable(sqlite)
  const lastMillis = lastAppliedMillis(sqlite)

  const pending = migrations.filter((m) => lastMillis === null || lastMillis < m.folderMillis)
  if (pending.length === 0) return 0

  sqlite.exec('BEGIN')
  try {
    for (const migration of pending) {
      for (const statement of migration.sql) {
        const trimmed = statement.trim()
        if (trimmed) sqlite.exec(trimmed)
      }
      sqlite
        .query(`INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES(?, ?)`)
        .run(migration.hash, migration.folderMillis)
    }
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }

  return pending.length
}

/** Called only after {@link verifySchema} confirms the tables are there. */
export function stampMigrations(sqlite: Database, migrations: MigrationMeta[]): void {
  ensureMigrationsTable(sqlite)
  const lastMillis = lastAppliedMillis(sqlite)

  for (const migration of migrations) {
    if (lastMillis !== null && lastMillis >= migration.folderMillis) continue
    sqlite
      .query(`INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES(?, ?)`)
      .run(migration.hash, migration.folderMillis)
  }
}

/** Only ever writes to an empty table; an existing revision is left alone. */
export function stampAlembicRevision(sqlite: Database, revision = ALEMBIC_HEAD_REVISION): void {
  if (!tableExists(sqlite, 'alembic_version')) return

  const existing = sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM alembic_version').get()
  if ((existing?.n ?? 0) > 0) return

  sqlite.query('INSERT INTO alembic_version (version_num) VALUES (?)').run(revision)
}

/**
 * Fail loudly if the live schema is missing anything `schema.ts` declares —
 * this is what makes adoption safe. Cross-dialect type spellings are accepted.
 */
export function verifySchema(sqlite: Database): void {
  const diffs = diffSchemas(describeDeclaredSchema(), describeLiveSchema(sqlite), {
    allowCrossDialect: true,
    expectedLabel: 'schema.ts',
    actualLabel: 'database',
  })

  for (const diff of diffs.filter((d) => d.severity === 'cosmetic')) {
    logger.warning(`  Schema differs from schema.ts (non-fatal): ${diff.description}`)
  }

  const fatal = diffs.filter((d) => d.severity === 'fatal')
  if (fatal.length === 0) return

  throw new SchemaDriftError(
    'Database schema does not match src/db/schema.ts:\n' +
      fatal.map((d) => `  - ${d.description}`).join('\n') +
      '\nRefusing to start against a half-migrated schema.',
  )
}

export interface InitDbOptions {
  migrations?: MigrationMeta[]
}

/** Returns which path was taken: "adopted" where "migrated" was due skips DDL. */
export function initDb(
  sqlite: Database,
  { migrations = loadMigrations() }: InitDbOptions = {},
): 'migrated' | 'adopted' | 'up-to-date' {
  const underDrizzle = tableExists(sqlite, MIGRATIONS_TABLE)
  const populated = hasAnyTable(sqlite)

  if (!populated) {
    logger.info('🆕 Fresh database - creating schema from migrations')
    applyMigrations(sqlite, migrations)
    stampAlembicRevision(sqlite)
    logger.info(`✅ Database schema created (${migrations.length} migration(s))`)
    return 'migrated'
  }

  if (!underDrizzle) {
    logger.info('⬆️  Existing database detected - verifying schema before adoption')
    verifySchema(sqlite)
    stampMigrations(sqlite, migrations)
    logger.info('✅ Existing database adopted at the current schema')
    return 'adopted'
  }

  const applied = applyMigrations(sqlite, migrations)
  if (applied === 0) {
    logger.info('✅ Database schema up to date')
    return 'up-to-date'
  }
  logger.info(`✅ Database schema upgraded (${applied} migration(s) applied)`)
  return 'migrated'
}

/**
 * Translate `DATABASE_URL` into a SQLite file path. Three slashes introduce a
 * path relative to the working directory and four an absolute one, which falls
 * out of stripping exactly three. A non-SQLite URL throws: falling back quietly
 * would create an empty database beside a real one and look like data loss.
 */
export function sqlitePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith('sqlite')) {
    throw new Error(
      `DATABASE_URL is not a SQLite URL: ${databaseUrl}\n` +
        'The TypeScript backend supports SQLite only. Set e.g. ' +
        'DATABASE_URL=sqlite+aiosqlite:///./claudeworld.db',
    )
  }

  const afterScheme = databaseUrl.slice(databaseUrl.indexOf(':') + 1)
  if (afterScheme === '//' || afterScheme === '') return ':memory:'
  return afterScheme.replace(/^\/\/\//, '')
}

export interface OpenAndInitOptions {
  path: string
  migrations?: MigrationMeta[]
}

/**
 * Kept separate from `openDb()`, which refuses to create: a read path must fail
 * loudly on a typo'd path rather than conjure an empty database.
 */
export function openAndInitDb({ path, migrations }: OpenAndInitOptions): Database {
  const isNew = !existsSync(path)
  const sqlite = new Database(path, { create: true, strict: true })

  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA busy_timeout = 5000')

  if (isNew) logger.info(`🆕 Creating database at ${path}`)
  initDb(sqlite, migrations ? { migrations } : {})

  return sqlite
}
