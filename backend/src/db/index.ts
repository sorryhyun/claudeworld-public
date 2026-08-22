import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database }

export interface OpenDbOptions {
  path: string
  /** Open without write access — used by read-only parity checks. */
  readonly?: boolean
}

// `openAndInitDb` returns a raw handle because migrations are plain SQL.
export function wrapDb(sqlite: Database): Db {
  return drizzle(sqlite, { schema }) as Db
}

/**
 * Open the ClaudeWorld SQLite database. `bun:sqlite` is synchronous, so one
 * connection is already all the write serialization needed. `foreign_keys=ON`
 * is load-bearing rather than tuning: SQLite defaults it *off*, and deleting a
 * world must cascade to its rooms, locations and player state.
 */
export function openDb({ path, readonly = false }: OpenDbOptions): Db {
  const sqlite = new Database(path, { readonly, create: false, strict: true })

  sqlite.exec('PRAGMA foreign_keys = ON')
  if (!readonly) {
    sqlite.exec('PRAGMA journal_mode = WAL')
    // Without a busy timeout a concurrent writer surfaces as an immediate
    // SQLITE_BUSY; letting SQLite wait states the retry policy once.
    sqlite.exec('PRAGMA busy_timeout = 5000')
  }

  return drizzle(sqlite, { schema }) as Db
}

export { schema }
export * from './schema'
