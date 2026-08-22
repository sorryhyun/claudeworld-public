/**
 * Resolved authentication configuration.
 *
 * The env-and-settings layering lives here, once, so that everything else in
 * `src/auth/` is a pure function of an explicit config object. Python does the
 * layering inline in every accessor (`os.getenv(...) or get_settings().x`),
 * which is why its own tests have to reach for `monkeypatch.setenv` and why
 * they cannot express "no password configured" at all without mutating the
 * process.
 *
 * The precedence is Python's: the live process environment wins over `.env`,
 * so a runtime override takes effect without a restart even though settings are
 * cached at first use.
 */

import { getSettings, isGuestLoginEnabled, type EnvRecord } from '../config/settings'

export interface AuthConfig {
  /** Bcrypt hash of the admin password, from `API_KEY_HASH`. */
  apiKeyHash: string | null
  /** Bcrypt hash of the guest password, from `GUEST_PASSWORD_HASH`. */
  guestPasswordHash: string | null
  /** Whether guest passwords are accepted at all. */
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
