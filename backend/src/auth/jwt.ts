/**
 * JWT issue and verify: HS256, five claims, one shared secret. The wire format
 * is frozen — tokens already in users' `localStorage` have to keep verifying, so
 * changing the algorithm or claim set logs everyone out. `src/tests/jwt.test.ts`
 * pins it against an externally minted token.
 */

import { jwtVerify, SignJWT } from 'jose'

import { getLogger } from '../infrastructure/logging/logger'
import { resolveAuthConfig } from './config'
import { isUserRole, type UserRole } from './roles'

const logger = getLogger('Auth')

/** Seven days. */
export const DEFAULT_EXPIRATION_HOURS = 168

/** The `type` claim every token carries; verified on the way back in. */
const TOKEN_TYPE = 'access_token'

export interface TokenPayload {
  exp: number
  iat: number
  type: string
  role: string
  user_id?: string
}

// Throws rather than exiting: `assertAuthConfigured`, run once at boot, is what
// turns a missing secret into a refusal to start.
function encodeSecret(secret: string | null | undefined): Uint8Array {
  const resolved = secret ?? resolveAuthConfig().jwtSecret
  if (!resolved) throw new Error('JWT_SECRET is not set')
  return new TextEncoder().encode(resolved)
}

export interface GenerateTokenOptions {
  role?: UserRole
  expirationHours?: number
  /** Guests get a random one so two are distinguishable; admins are `admin`. */
  userId?: string
  /** Signing secret; defaults to `JWT_SECRET`. */
  secret?: string
}

/** Six random bytes as twelve hex characters. */
export function generateGuestUserId(): string {
  return `guest-${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('hex')}`
}

export async function generateJwtToken({
  role = 'admin',
  expirationHours = DEFAULT_EXPIRATION_HOURS,
  userId,
  secret,
}: GenerateTokenOptions = {}): Promise<string> {
  const resolvedUserId = userId ?? (role === 'guest' ? generateGuestUserId() : 'admin')

  // Seconds, floored: `exp`/`iat` are integer seconds on the wire, and deriving
  // the expiry from this value keeps the window exactly `expirationHours`.
  const issuedAt = Math.floor(Date.now() / 1000)

  return new SignJWT({ type: TOKEN_TYPE, role, user_id: resolvedUserId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + Math.round(expirationHours * 3600))
    .sign(encodeSecret(secret))
}

/**
 * Verify a token and return its claims, or null. Every failure mode collapses to
 * null on purpose: the caller's only decision is 401-or-not, and distinguishing
 * "expired" from "forged" in the response tells an attacker which they achieved.
 */
export async function validateJwtToken(
  token: string,
  secret?: string,
): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, encodeSecret(secret), { algorithms: ['HS256'] })
    return payload as unknown as TokenPayload
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_JWT_EXPIRED') {
      logger.warning('⚠️  JWT token has expired')
    } else {
      logger.warning(`⚠️  Invalid JWT token: ${String(error)}`)
    }
    return null
  }
}

/**
 * Anything that is not exactly `"guest"` reads as admin, including a token
 * minted before the claim existed; tightening this would lock out every
 * unexpired token issued before roles were added.
 */
export function roleFromPayload(payload: TokenPayload | null): UserRole | null {
  if (!payload) return null
  const role = payload.role ?? 'admin'
  return role === 'guest' ? 'guest' : 'admin'
}

export async function getRoleFromToken(token: string, secret?: string): Promise<UserRole | null> {
  return roleFromPayload(await validateJwtToken(token, secret))
}

/**
 * Tokens predating the claim fall back to the role name, so an old guest token
 * yields the bare string `guest`, not the `guest-<hex>` form new ones get.
 */
export function userIdFromPayload(payload: TokenPayload | null): string | null {
  if (!payload) return null
  if (payload.user_id === undefined) return payload.role === 'guest' ? 'guest' : 'admin'
  return payload.user_id
}

export async function getUserIdFromToken(token: string, secret?: string): Promise<string | null> {
  return userIdFromPayload(await validateJwtToken(token, secret))
}

export { isUserRole }
