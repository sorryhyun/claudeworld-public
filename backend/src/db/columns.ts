import { customType } from 'drizzle-orm/sqlite-core'

/** DATETIME in the format existing databases already hold: naive text like
 * `2026-08-06 04:14:54.931812`, always UTC without saying so. Drizzle's
 * `integer({ mode: 'timestamp' })` would store Unix seconds and `text` would hand
 * back raw strings; either makes an existing `claudeworld.db` unreadable. */
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
  // Pad to 6 digits so column width and sort order match existing rows.
  const us = String(value.getUTCMilliseconds()).padStart(3, '0') + '000'
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${us}`
}

export function parseSqlaDateTime(value: string): Date {
  // Both the microsecond form and the second-only CURRENT_TIMESTAMP form.
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  return new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`)
}

/** NULL and `''` are both live "no value" states in existing databases, and
 * `fromDriver` returns the fallback rather than throwing: a malformed blob in one
 * row should not take down a whole listing query. */
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
