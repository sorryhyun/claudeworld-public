/**
 * User roles. These exact strings appear in JWT payloads and JSON responses,
 * so the union is a wire contract, not just a type.
 */

export const USER_ROLES = ['admin', 'guest'] as const

/** `admin` has full access; `guest` may chat but not modify rooms or agents. */
export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
}
