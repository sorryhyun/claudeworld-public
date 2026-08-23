/**
 * Resolved authentication configuration. The env-over-`.env` layering lives
 * here, once, so everything else in `src/auth/` is a pure function of an
 * explicit config object — and an override applies without a restart.
 */

import { getSettings, isGuestLoginEnabled, type EnvRecord } from '@/config/settings'

export interface AuthConfig {
  /** Bcrypt hash of the admin password, from `API_KEY_HASH`. */
  apiKeyHash: string | null
  guestPasswordHash: string | null
  guestLoginEnabled: boolean
  /** HS256 signing secret, from `JWT_SECRET`. */
  jwtSecret: string | null
}

export function resolveAuthConfig(env: EnvRecord = process.env): AuthConfig {
  const settings = getSettings()
  return {
    apiKeyHash: env.API_KEY_HASH || settings.apiKeyHash,
    guestPasswordHash: env.GUEST_PASSWORD_HASH || settings.guestPasswordHash,
    guestLoginEnabled: isGuestLoginEnabled(env, settings),
    jwtSecret: env.JWT_SECRET || settings.jwtSecret,
  }
}
