import type { UserRole } from '@/auth/roles'

/**
 * Per-request state set by the auth middleware and read by routers.
 * Declaring it once means a handler cannot invent a third variable by typo.
 */
export interface AppEnv {
  Variables: {
    userRole: UserRole
    userId: string
  }
}
