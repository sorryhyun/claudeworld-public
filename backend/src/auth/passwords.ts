/**
 * Password validation against the bcrypt hashes in `.env`. `Bun.password.verify`
 * reads the `$2b$` prefix and dispatches to bcrypt, so any implementation's
 * hashes — including those already in a user's `.env` — verify unchanged; a test
 * pins that. A missing `API_KEY_HASH` is fatal at startup
 * ({@link assertAuthConfigured}), not on the request path, which only refuses.
 */

import { getLogger } from '../infrastructure/logging/logger'
import { resolveAuthConfig, type AuthConfig } from './config'
import type { UserRole } from './roles'

const logger = getLogger('Auth')

// Never throws: a malformed hash in `.env` should deny the login and say so,
// not surface as a 500.
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
 * Resolve a password to a role, or null. Admin is checked first and
 * unconditionally; guest only when guest login is enabled *and* a hash is set.
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
 * Fail startup when authentication cannot possibly work, so the process dies at
 * boot with an actionable message instead of at the first login attempt.
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
