/**
 * Schema initialisation at startup.
 *
 * Ported from `init_db()` in `backend/infrastructure/database/connection.py`
 * and the operations in `alembic_runner.py`. Same three cases, one of them
 * different in kind because Alembic's history is not replayed here:
 *
 * 1. **Empty** — fresh install. Apply every Drizzle migration from scratch.
 * 2. **Populated but not under Drizzle control** — an existing `claudeworld.db`
 *    that Alembic (or an earlier Python release) created. It is *adopted*, not
 *    migrated: the schema is verified against `schema.ts` and then stamped, so
 *    the baseline never runs against tables that already exist.
 * 3. **Under Drizzle control** — apply whatever migrations it has not seen.
 *
 * Case 2 is the one that upholds hard constraint 1 of the migration plan: an
 * existing database opens unmodified. Nothing here writes DDL to a populated
 * database — if the schema is short of what `schema.ts` declares, startup
 * fails rather than guessing at an ALTER.
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

/**
 * The Alembic revision the Drizzle baseline reproduces.
 *
 * A database created here stamps this into `alembic_version`, so that a
 * TypeScript-created database is indistinguishable from an Alembic-created one.
 * Without it the table exists but is empty, and Python's `init_db` reads that
 * as "under Alembic control but at no revision", runs the baseline revision,
 * and dies on `CREATE TABLE agents` because the table is already there.
 *
 * That is the rollback story from the migration plan made real rather than
 * assumed: the database works with either backend at all times, including one
 * that a fresh TypeScript install created.
 */
export const ALEMBIC_HEAD_REVISION = 'e872d9c86c83'

/** Committed migration folder, resolved relative to this module. */
export function migrationsFolder(): string {
  // src/db/ -> src/ -> backend-ts/
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

// ============================================================================
// Database state
// ============================================================================

function tableExists(sqlite: Database, name: string): boolean {
  return (
    sqlite
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)?.n ?? 0
  ) > 0
}

/**
 * Whether this database has any application tables at all.
 *
 * `alembic_version` counts as an application table here, unlike in Python where
 * it is excluded — a database holding only `alembic_version` was stamped by
 * Alembic and then had its tables dropped, which is not a fresh install and
 * should not be treated as one.
 */
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

/** The `folderMillis` of the newest applied migration, or null. */
function lastAppliedMillis(sqlite: Database): number | null {
  if (!tableExists(sqlite, MIGRATIONS_TABLE)) return null
  const row = sqlite
    .query<{ created_at: number | null }, []>(
      `SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`,
    )
    .get()
  return row?.created_at == null ? null : Number(row.created_at)
}

// ============================================================================
// Operations
// ============================================================================

/**
 * Apply migrations newer than what the database has already seen.
 *
 * Deliberately a re-implementation of drizzle's `migrate()` rather than a call
 * to it: {@link stampMigrations} has to write rows into the same table with the
 * same semantics, and having both halves in one place is what keeps them
 * consistent. The applied-check is drizzle's own — `created_at < folderMillis`
 * against the newest row — so a database stamped here is indistinguishable from
 * one drizzle migrated.
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

/**
 * Record migrations as applied without running them.
 *
 * The adoption path for a database whose schema already matches — the direct
 * analogue of `alembic stamp head`. Called only after {@link verifySchema}
 * confirms the tables really are there.
 */
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

/**
 * Record the Alembic head in `alembic_version`, if nothing is recorded yet.
 *
 * Only ever writes to an empty table: a database that already carries a
 * revision is left exactly as it is, whatever revision that happens to be.
 */
export function stampAlembicRevision(sqlite: Database, revision = ALEMBIC_HEAD_REVISION): void {
  if (!tableExists(sqlite, 'alembic_version')) return

  const existing = sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM alembic_version').get()
  if ((existing?.n ?? 0) > 0) return

  sqlite.query('INSERT INTO alembic_version (version_num) VALUES (?)').run(revision)
}

/**
 * Fail loudly if the live schema is missing anything `schema.ts` declares.
 *
 * The gate that keeps drift from being silent, and the reason case 2 above is
 * safe: adopting a database means trusting that its schema matches, so the
 * trust is checked rather than assumed.
 *
 * Cross-dialect type spellings are accepted here — the database being checked
 * was created by SQLAlchemy, which writes `VARCHAR` and `BOOLEAN`.
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

// ============================================================================
// Startup
// ============================================================================

export interface InitDbOptions {
  migrations?: MigrationMeta[]
}

/**
 * Bring a database to the current schema, whatever state it starts in.
 *
 * Returns which of the three paths was taken, mostly so tests can assert on it
 * — a silent "adopted" where "migrated" was expected is the failure mode that
 * would quietly skip DDL on a fresh install.
 */
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

// ============================================================================
// Opening
// ============================================================================

/**
 * Translate `DATABASE_URL` into a SQLite file path.
 *
 * Accepts the SQLAlchemy spellings verbatim so one `.env` drives both backends:
 * `sqlite+aiosqlite:///../claudeworld.db`, `sqlite:///./x.db`, `sqlite:////abs.db`.
 * SQLAlchemy's convention is that three slashes introduce a path relative to the
 * process's working directory and four an absolute one, which falls out of
 * stripping exactly three.
 *
 * A PostgreSQL URL — which is what `connection.py` defaults to when
 * `DATABASE_URL` is unset — throws. There is no Postgres support here, and
 * quietly falling back to a SQLite file would create an empty database beside a
 * real one and look like data loss.
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
  /** Path to the SQLite file; created when absent. */
  path: string
  migrations?: MigrationMeta[]
}

/**
 * Open (creating if needed) and initialise a database, returning the raw handle.
 *
 * Kept separate from `openDb()` in `./index.ts`, which deliberately refuses to
 * create: every read path should fail loudly on a typo'd path rather than
 * conjure an empty database, and startup is the one place that should not.
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
