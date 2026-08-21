import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database }

export interface OpenDbOptions {
  /** Path to the SQLite file. */
  path: string
  /** Open without write access — used by read-only parity checks. */
  readonly?: boolean
}

/**
 * Open the ClaudeWorld SQLite database.
 *
 * `bun:sqlite` is synchronous, which removes the aiosqlite/greenlet layer the
 * Python side needs and with it the whole `retry_on_db_lock` /
 * `serialized_write` apparatus: those exist because many async tasks could
 * interleave mid-statement against one connection. Here a statement runs to
 * completion before any other code does, so a single connection is already the
 * serialization the Python code had to build by hand.
 *
 * WAL and `foreign_keys=ON` are both load-bearing rather than tuning. Python
 * sets `PRAGMA foreign_keys=ON` on every connect (SQLite defaults it *off*),
 * and the schema leans on it: deleting a world is expected to cascade to its
 * rooms, locations and player state. Without the pragma those deletes silently
 * orphan rows instead.
 */
/**
 * Wrap an already-open `bun:sqlite` handle as a Drizzle database.
 *
 * `openAndInitDb` returns the raw handle because migrations are applied with
 * plain SQL against it. Everything above the migration layer wants the typed
 * query builder, so the two are bridged in one place instead of each caller
 * remembering the `{ schema }` argument.
 */
export function wrapDb(sqlite: Database): Db {
  return drizzle(sqlite, { schema }) as Db
}

export function openDb({ path, readonly = false }: OpenDbOptions): Db {
  const sqlite = new Database(path, { readonly, create: false, strict: true })

  sqlite.exec('PRAGMA foreign_keys = ON')
  if (!readonly) {
    sqlite.exec('PRAGMA journal_mode = WAL')
    // Without a busy timeout a concurrent writer surfaces as an immediate
    // SQLITE_BUSY. The Python side retried such failures with backoff; letting
    // SQLite wait is the same policy expressed once, in the engine.
    sqlite.exec('PRAGMA busy_timeout = 5000')
  }

  return drizzle(sqlite, { schema }) as Db
}

export { schema }
export * from './schema'
