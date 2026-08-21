/**
 * User roles.
 *
 * Port of `UserRole` from `backend/domain/value_objects/enums.py`. It lives
 * here rather than in a `domain/` layer because the migration plan does not
 * port `domain/` as a layer — its enums live next to the code that enforces
 * them, the way the world/message enums live in `db/schema.ts`.
 *
 * Python's is a `str, Enum`, so it serialises to exactly these strings in JWT
 * payloads and JSON responses. A string union reproduces that with no runtime
 * object at all.
 */

export const USER_ROLES = ['admin', 'guest'] as const

/** `admin` has full access; `guest` may chat but not modify rooms or agents. */
export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
}
