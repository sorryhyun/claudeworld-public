import { customType } from 'drizzle-orm/sqlite-core'

/**
 * SQLAlchemy-compatible DATETIME.
 *
 * The parity contract says an existing `claudeworld.db` opens unmodified, and
 * that makes the storage format part of the contract rather than an
 * implementation detail. SQLAlchemy's SQLite DateTime writes naive text —
 * `2026-08-06 04:14:54.931812`, microseconds always present, no `T`, no offset —
 * and it drops tzinfo on the way in even for the `DateTime(timezone=True)`
 * columns this schema uses, so every stored value is UTC-without-saying-so.
 *
 * Drizzle's own `integer({ mode: 'timestamp' })` would store Unix seconds and
 * `text` would hand back raw strings; either one makes rows written by this
 * backend unreadable to the Python one. So the format is reproduced exactly,
 * and reads re-attach the UTC that SQLAlchemy discarded.
 */
export const sqlaDateTime = customType<{
  data: Date
  driverData: string
}>({
  dataType: () => 'DATETIME',
  toDriver: (value: Date): string => formatSqlaDateTime(value),
  fromDriver: (value: string): Date => parseSqlaDateTime(value),
})

const TWO = (n: number) => String(n).padStart(2, '0')

export function formatSqlaDateTime(value: Date): string {
  const y = value.getUTCFullYear()
  const mo = TWO(value.getUTCMonth() + 1)
  const d = TWO(value.getUTCDate())
  const h = TWO(value.getUTCHours())
  const mi = TWO(value.getUTCMinutes())
  const s = TWO(value.getUTCSeconds())
  // JS resolution stops at milliseconds; pad to SQLAlchemy's 6 digits so the
  // column width and sort order stay identical to Python-written rows.
  const us = String(value.getUTCMilliseconds()).padStart(3, '0') + '000'
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${us}`
}

export function parseSqlaDateTime(value: string): Date {
  // Tolerate both the microsecond form SQLAlchemy writes and the second-only
  // form SQLite's own CURRENT_TIMESTAMP default produces for `messages.timestamp`.
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  return new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`)
}

/**
 * TEXT column holding a JSON document.
 *
 * The Python side stores these with `json.dumps` and reads them with
 * `json.loads`, leaving NULL and the string `''` as distinct "no value" states
 * that both have to survive a round trip. `fromDriver` therefore returns the
 * fallback rather than throwing on unparseable input: a malformed blob in one
 * row should not take down a whole listing query.
 */
export const jsonText = <T>(fallback: () => T) =>
  customType<{ data: T; driverData: string }>({
    dataType: () => 'TEXT',
    toDriver: (value: T): string => JSON.stringify(value),
    fromDriver: (value: string): T => {
      if (value === null || value === undefined || value === '') return fallback()
      try {
        return JSON.parse(value) as T
      } catch {
        return fallback()
      }
    },
  })
