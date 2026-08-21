/**
 * Password validation against the bcrypt hashes in `.env`.
 *
 * Ported from the password half of `backend/infrastructure/auth.py`.
 *
 * `Bun.password.verify` reads the `$2b$` prefix and dispatches to bcrypt, so
 * hashes produced by `make setup` (Python's `bcrypt.hashpw`) verify unchanged —
 * hard constraint 4 of the migration plan, pinned by a test against a known
 * hash rather than left to inspection.
 *
 * One deliberate divergence: Python's `get_api_key_hash_from_env()` calls
 * `sys.exit(1)` when `API_KEY_HASH` is unset, from inside a request handler.
 * Killing the server on a login attempt is the wrong place for that check, so
 * it moved to {@link assertAuthConfigured}, which startup calls once. The
 * request path refuses the login and logs the same remediation.
 */

import { getLogger } from '../infrastructure/logging/logger'
import { resolveAuthConfig, type AuthConfig } from './config'
import type { UserRole } from './roles'

const logger = getLogger('Auth')

/**
 * Compare a plaintext password against a bcrypt hash.
 *
 * Never throws: a malformed hash in `.env` is a configuration error that should
 * deny the login and say so, not surface as a 500.
 */
async function verify(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash)
  } catch (error) {
    logger.error(`❌ Error validating password: ${String(error)}`)
    return false
  }
}

/** Whether `password` is the admin password. */
export async function validateApiKey(
  password: string,
  config: AuthConfig = resolveAuthConfig(),
): Promise<boolean> {
  if (!config.apiKeyHash) {
    logApiKeyHashMissing()
    return false
  }
  return verify(password, config.apiKeyHash)
}

/**
 * Resolve a password to a role, or null when it matches neither.
 *
 * Admin is checked first and unconditionally; guest only when guest login is
 * enabled *and* a guest hash is configured.
 */
export async function validatePasswordWithRole(
  password: string,
  config: AuthConfig = resolveAuthConfig(),
): Promise<UserRole | null> {
  if (!config.apiKeyHash) {
    logApiKeyHashMissing()
    return null
  }

  if (await verify(password, config.apiKeyHash)) return 'admin'

  if (config.guestLoginEnabled && config.guestPasswordHash) {
    if (await verify(password, config.guestPasswordHash)) return 'guest'
  }

  return null
}

function logApiKeyHashMissing(): void {
  logger.error('❌ ERROR: API_KEY_HASH is not set in environment variables!')
  logger.error('❌ Authentication cannot work without a password configured.')
  logger.error("💡 To fix: Run 'make setup' to configure a password in .env")
}

/**
 * Fail startup when authentication cannot possibly work.
 *
 * Both checks are fatal in Python too; doing them here means the process dies
 * at boot with an actionable message instead of at the first login attempt.
 */
export function assertAuthConfigured(config: AuthConfig = resolveAuthConfig()): void {
  const problems: string[] = []

  if (!config.apiKeyHash) {
    logApiKeyHashMissing()
    problems.push('API_KEY_HASH')
  }

  if (!config.jwtSecret) {
    logger.error('❌ ERROR: JWT_SECRET is not set in environment variables!')
    logger.error('❌ Without a stable secret, tokens will be invalidated on every server restart.')
    logger.error("💡 To fix: Run 'make setup', or add JWT_SECRET=<64 hex chars> to your .env file")
    problems.push('JWT_SECRET')
  }

  if (problems.length > 0) {
    throw new Error(`Authentication is not configured: ${problems.join(', ')} missing from .env`)
  }
}
