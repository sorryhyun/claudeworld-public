import type { UserRole } from '../auth/roles'

/**
 * Per-request state, the Hono equivalent of Starlette's `request.state`.
 *
 * The two variables here are exactly the two the Python middleware sets, and
 * routers read them under the same names in spirit (`user_role` → `userRole`).
 * Declaring them once means a handler cannot invent a third by typo.
 */
export interface AppEnv {
  Variables: {
    userRole: UserRole
    userId: string
  }
}
