/**
 * The migration path and the drift gate.
 *
 * Loosely a port of `backend/tests/unit/test_alembic_migrations.py`, but the
 * interesting cases are different: Alembic's history is not replayed here, so
 * the thing to prove is not "every revision applies" but "a fresh install and
 * an existing database end up at the same schema, and neither is written to
 * when it should not be".
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeDeclaredSchema, describeLiveSchema, diffSchemas, typeAffinity } from '@/db/introspect'
import {
  ALEMBIC_HEAD_REVISION,
  applyMigrations,
  initDb,
  loadMigrations,
  SchemaDriftError,
  sqlitePathFromUrl,
  verifySchema,
} from '@/db/migrate'

const migrations = loadMigrations()

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cw-migrate-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function freshDb(name = 'test.db'): Database {
  const db = new Database(join(workDir, name), { create: true, strict: true })
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
}

describe('sqlitePathFromUrl', () => {
  test.each([
    ['sqlite+aiosqlite:///../claudeworld.db', '../claudeworld.db'],
    ['sqlite:///./claudeworld.db', './claudeworld.db'],
    ['sqlite:///claudeworld.db', 'claudeworld.db'],
    // SQLAlchemy's fourth slash is what makes a path absolute.
    ['sqlite:////var/lib/claudeworld.db', '/var/lib/claudeworld.db'],
    ['sqlite://', ':memory:'],
  ])('%s -> %s', (url, expected) => {
    expect(sqlitePathFromUrl(url)).toBe(expected)
  })

  test('refuses a PostgreSQL URL rather than inventing a SQLite file', () => {
    // connection.py defaults to this when DATABASE_URL is unset; silently
    // falling back would create an empty database beside the real one.
    expect(() => sqlitePathFromUrl('postgresql+asyncpg://postgres@localhost/claudeworld')).toThrow(
      /SQLite only/,
    )
  })
})

describe('fresh install', () => {
  test('creates every table from the migrations', () => {
    const db = freshDb()

    expect(initDb(db, { migrations })).toBe('migrated')
    expect(tableNames(db)).toEqual([
      '__drizzle_migrations',
      'agents',
      'alembic_version',
      'locations',
      'messages',
      'player_states',
      'room_agent_sessions',
      'room_agents',
      'rooms',
      'worlds',
    ])
    db.close()
  })

  test('produces exactly the schema src/db/schema.ts declares', () => {
    const db = freshDb()
    initDb(db, { migrations })

    // The `alembic check` analogue: if schema.ts was edited without generating
    // a migration, this is where it surfaces.
    expect(diffSchemas(describeDeclaredSchema(), describeLiveSchema(db))).toEqual([])
    db.close()
  })

  test('stamps the Alembic head so the Python backend can still open it', () => {
    const db = freshDb()
    initDb(db, { migrations })

    // Without the stamp, Python reads "under Alembic control, at no revision",
    // re-runs the baseline revision and dies on `CREATE TABLE agents`.
    expect(
      db.query<{ version_num: string }, []>('SELECT version_num FROM alembic_version').get()?.version_num,
    ).toBe(ALEMBIC_HEAD_REVISION)
    db.close()
  })

  test('is idempotent', () => {
    const db = freshDb()
    initDb(db, { migrations })

    expect(initDb(db, { migrations })).toBe('up-to-date')
    db.close()
  })
})

describe('adopting an existing database', () => {
  /** A database as the Python backend would have left it: no drizzle table. */
  function pythonStyleDb(): Database {
    const db = freshDb('existing.db')
    applyMigrations(db, migrations)
    db.exec('DROP TABLE __drizzle_migrations')
    db.exec("INSERT INTO alembic_version (version_num) VALUES ('e872d9c86c83')")
    return db
  }

  test('is adopted, not migrated', () => {
    const db = pythonStyleDb()

    expect(initDb(db, { migrations })).toBe('adopted')
    db.close()
  })

  test('leaves the data untouched', () => {
    const db = pythonStyleDb()
    db.exec("INSERT INTO worlds (id, name) VALUES (7, 'Existing World')")

    initDb(db, { migrations })

    expect(db.query<{ name: string }, []>('SELECT name FROM worlds WHERE id = 7').get()?.name).toBe(
      'Existing World',
    )
    // Hard constraint 1: the database opens unmodified. `alembic_version` in
    // particular must survive, so a rollback to the Python backend still works.
    expect(
      db.query<{ version_num: string }, []>('SELECT version_num FROM alembic_version').get()?.version_num,
    ).toBe('e872d9c86c83')
    db.close()
  })

  test('does not re-run the baseline over existing tables', () => {
    const db = pythonStyleDb()

    // A second CREATE TABLE would throw; this is the failure adoption prevents.
    expect(() => initDb(db, { migrations })).not.toThrow()
    db.close()
  })

  test('a stamped database takes the fast path next time', () => {
    const db = pythonStyleDb()
    initDb(db, { migrations })

    expect(initDb(db, { migrations })).toBe('up-to-date')
    db.close()
  })

  test('refuses to adopt a database that is missing a table', () => {
    const db = pythonStyleDb()
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('DROP TABLE player_states')

    expect(() => initDb(db, { migrations })).toThrow(SchemaDriftError)
    db.close()
  })

  test('refuses to adopt a database that is missing a column', () => {
    const db = pythonStyleDb()
    db.exec('ALTER TABLE worlds DROP COLUMN theme')

    expect(() => initDb(db, { migrations })).toThrow(/missing column 'worlds.theme'/)
    db.close()
  })
})

describe('drift detection', () => {
  test('an extra column in schema.ts is fatal', () => {
    const db = freshDb()
    initDb(db, { migrations })
    db.exec('ALTER TABLE agents DROP COLUMN priority')

    const diffs = diffSchemas(describeDeclaredSchema(), describeLiveSchema(db))
    expect(diffs).toContainEqual({ severity: 'fatal', description: "missing column 'agents.priority'" })
    db.close()
  })

  test('a column the migrations added but schema.ts does not know about is reported', () => {
    const db = freshDb()
    initDb(db, { migrations })
    db.exec('ALTER TABLE agents ADD COLUMN nickname TEXT')

    const diffs = diffSchemas(describeDeclaredSchema(), describeLiveSchema(db), { actualLabel: 'database' })
    expect(diffs).toContainEqual({
      severity: 'cosmetic',
      description: "extra column 'agents.nickname' in database",
    })
    db.close()
  })

  test('a dropped index is reported', () => {
    const db = freshDb()
    initDb(db, { migrations })
    db.exec('DROP INDEX ix_rooms_world_id')

    expect(diffSchemas(describeDeclaredSchema(), describeLiveSchema(db))).toContainEqual({
      severity: 'cosmetic',
      description: "missing index 'ix_rooms_world_id' on 'rooms'",
    })
    db.close()
  })

  test('verifySchema passes on a freshly migrated database', () => {
    const db = freshDb()
    initDb(db, { migrations })

    expect(() => verifySchema(db)).not.toThrow()
    db.close()
  })
})

describe('type affinity', () => {
  test.each([
    ['VARCHAR', 'TEXT'],
    ['VARCHAR(32)', 'TEXT'],
    ['text(9)', 'TEXT'],
    ['TEXT', 'TEXT'],
    ['INTEGER', 'INTEGER'],
    ['integer', 'INTEGER'],
    // SQLite's own rules put BOOLEAN in NUMERIC, not INTEGER — which is why
    // SQLAlchemy's `BOOLEAN` and Drizzle's `integer` need an explicit
    // equivalence when comparing across backends.
    ['BOOLEAN', 'NUMERIC'],
    ['DATETIME', 'NUMERIC'],
  ] as const)('%s has %s affinity', (declared, affinity) => {
    expect(typeAffinity(declared)).toBe(affinity)
  })

  test('SQLAlchemy and Drizzle spellings compare equal only when allowed', () => {
    const sqlAlchemyStyle = freshDb('sqlalchemy.db')
    sqlAlchemyStyle.exec('CREATE TABLE t (flag BOOLEAN, label VARCHAR(20))')
    const drizzleStyle = freshDb('drizzle.db')
    drizzleStyle.exec('CREATE TABLE t (flag integer, label text(20))')

    const left = describeLiveSchema(sqlAlchemyStyle)
    const right = describeLiveSchema(drizzleStyle)

    expect(diffSchemas(left, right, { allowCrossDialect: true })).toEqual([])
    expect(diffSchemas(left, right, { allowCrossDialect: false })).toHaveLength(1)

    sqlAlchemyStyle.close()
    drizzleStyle.close()
  })
})
