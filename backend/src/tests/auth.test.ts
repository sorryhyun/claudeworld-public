/**
 * Port of `backend/tests/unit/test_auth.py`, plus the cross-backend
 * compatibility checks the Python suite had no reason to write.
 *
 * The bcrypt hash and the PyJWT tokens below are the actual artifacts of the
 * Python implementation, not re-derived here. That is the point: hard
 * constraint 4 of the migration plan says existing `.env` hashes must keep
 * verifying and existing tokens must keep validating, and only a fixture
 * produced by the other implementation can test that.
 */

import { describe, expect, test } from 'bun:test'

import type { AuthConfig } from '../auth/config'
import {
  DEFAULT_EXPIRATION_HOURS,
  generateGuestUserId,
  generateJwtToken,
  getRoleFromToken,
  getUserIdFromToken,
  validateJwtToken,
} from '../auth/jwt'
import { assertAuthConfigured, validateApiKey, validatePasswordWithRole } from '../auth/passwords'

/**
 * Produced by `bcrypt.hashpw(b"test_password", bcrypt.gensalt())` in Python and
 * pasted verbatim out of `backend/tests/unit/test_auth.py`, where it stands in
 * for a hash `make setup` wrote into someone's `.env`.
 */
const PYTHON_BCRYPT_HASH = '$2b$12$H0fCIM9buSuQsCFErTRi0Omz//QVZxCKJW5Dapi2u3ealuUFzvF9O'
const PYTHON_PASSWORD = 'test_password'

const SECRET = 'migration-parity-secret'

/** Tokens minted by PyJWT with {@link SECRET}; `exp` is in the year 2286. */
const PYJWT_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjk5OTk5OTk5OTksImlhdCI6MTcwMDAwMDAwMCwidHlwZSI6ImFjY2Vzc190b2tlbiIsInJvbGUiOiJndWVzdCIsInVzZXJfaWQiOiJndWVzdC1hYmMxMjNkZWY0NTYifQ.nweKgfy--RVK0kwXEqEdT9ehdFCOKNm7TyOgTV7diyw'
const PYJWT_LEGACY_NO_USER_ID =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjk5OTk5OTk5OTksImlhdCI6MTcwMDAwMDAwMCwidHlwZSI6ImFjY2Vzc190b2tlbiIsInJvbGUiOiJndWVzdCJ9.dZrkE_Ii4j4vA_2MjF-2AvXSdgfM7yjoDl0KbuU4yM8'
const PYJWT_LEGACY_NO_ROLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjk5OTk5OTk5OTksImlhdCI6MTcwMDAwMDAwMCwidHlwZSI6ImFjY2Vzc190b2tlbiJ9.0rt5lOQfxMiLnGQCUPBcNX_vAiPkUu9uHGZc9VVL8hg'

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    apiKeyHash: PYTHON_BCRYPT_HASH,
    guestPasswordHash: null,
    guestLoginEnabled: true,
    jwtSecret: SECRET,
    ...overrides,
  }
}

describe('password validation', () => {
  test('a bcrypt hash written by Python verifies here', async () => {
    expect(await validateApiKey(PYTHON_PASSWORD, config())).toBe(true)
  })

  test('the wrong password does not', async () => {
    expect(await validateApiKey('wrong_password', config())).toBe(false)
  })

  test('an empty password does not', async () => {
    expect(await validateApiKey('', config())).toBe(false)
  })

  test('a malformed hash denies rather than throws', async () => {
    expect(await validateApiKey(PYTHON_PASSWORD, config({ apiKeyHash: 'not-a-bcrypt-hash' }))).toBe(false)
  })

  test('no configured hash denies rather than crashing the request', async () => {
    expect(await validateApiKey(PYTHON_PASSWORD, config({ apiKeyHash: null }))).toBe(false)
    expect(await validatePasswordWithRole(PYTHON_PASSWORD, config({ apiKeyHash: null }))).toBeNull()
  })
})

describe('role resolution', () => {
  test('the admin password resolves to admin', async () => {
    expect(await validatePasswordWithRole(PYTHON_PASSWORD, config())).toBe('admin')
  })

  test('an unknown password resolves to nothing', async () => {
    expect(await validatePasswordWithRole('wrong_password', config())).toBeNull()
  })

  test('the guest password resolves to guest, and admin still works', async () => {
    const guestHash = await Bun.password.hash('guest_password', 'bcrypt')
    const withGuest = config({ guestPasswordHash: guestHash })

    expect(await validatePasswordWithRole('guest_password', withGuest)).toBe('guest')
    expect(await validatePasswordWithRole(PYTHON_PASSWORD, withGuest)).toBe('admin')
  })

  test('a guest password is refused when guest login is disabled', async () => {
    const guestHash = await Bun.password.hash('guest_password', 'bcrypt')
    const disabled = config({ guestPasswordHash: guestHash, guestLoginEnabled: false })

    expect(await validatePasswordWithRole('guest_password', disabled)).toBeNull()
    // Admin is checked before the guest gate, so it is unaffected.
    expect(await validatePasswordWithRole(PYTHON_PASSWORD, disabled)).toBe('admin')
  })
})

describe('startup configuration check', () => {
  test('passes when both secrets are present', () => {
    expect(() => assertAuthConfigured(config())).not.toThrow()
  })

  test('names every missing variable at once', () => {
    expect(() => assertAuthConfigured(config({ apiKeyHash: null, jwtSecret: null }))).toThrow(
      /API_KEY_HASH, JWT_SECRET/,
    )
  })
})

describe('JWT generation', () => {
  test('defaults to an admin token', async () => {
    const payload = await validateJwtToken(await generateJwtToken({ secret: SECRET }), SECRET)

    expect(payload).not.toBeNull()
    expect(payload?.role).toBe('admin')
    expect(payload?.type).toBe('access_token')
    expect(payload?.user_id).toBe('admin')
  })

  test('carries the requested role and user id', async () => {
    const token = await generateJwtToken({ role: 'guest', userId: 'guest-123', secret: SECRET })
    const payload = await validateJwtToken(token, SECRET)

    expect(payload?.role).toBe('guest')
    expect(payload?.user_id).toBe('guest-123')
  })

  test('gives an unnamed guest a distinct id', async () => {
    const first = await validateJwtToken(await generateJwtToken({ role: 'guest', secret: SECRET }), SECRET)
    const second = await validateJwtToken(await generateJwtToken({ role: 'guest', secret: SECRET }), SECRET)

    expect(first?.user_id).toMatch(/^guest-[0-9a-f]{12}$/)
    expect(first?.user_id).not.toBe(second?.user_id)
  })

  test('expires the requested number of hours after issuance', async () => {
    const payload = await validateJwtToken(
      await generateJwtToken({ expirationHours: 1, secret: SECRET }),
      SECRET,
    )

    expect(payload!.exp - payload!.iat).toBe(3600)
  })

  test('defaults to a seven-day lifetime', async () => {
    const payload = await validateJwtToken(await generateJwtToken({ secret: SECRET }), SECRET)

    expect(payload!.exp - payload!.iat).toBe(DEFAULT_EXPIRATION_HOURS * 3600)
  })
})

describe('JWT validation', () => {
  test('a valid token yields the full claim set', async () => {
    const payload = await validateJwtToken(await generateJwtToken({ secret: SECRET }), SECRET)

    expect(Object.keys(payload!).sort()).toEqual(['exp', 'iat', 'role', 'type', 'user_id'])
  })

  test('a malformed token is rejected', async () => {
    expect(await validateJwtToken('invalid.token.here', SECRET)).toBeNull()
  })

  test('an expired token is rejected', async () => {
    const expired = await generateJwtToken({ expirationHours: -1, secret: SECRET })

    expect(await validateJwtToken(expired, SECRET)).toBeNull()
  })

  test('a token signed with a different secret is rejected', async () => {
    const foreign = await generateJwtToken({ secret: 'some-other-secret' })

    expect(await validateJwtToken(foreign, SECRET)).toBeNull()
  })
})

describe('claim extraction', () => {
  test('reads the role', async () => {
    expect(await getRoleFromToken(await generateJwtToken({ role: 'admin', secret: SECRET }), SECRET)).toBe('admin')
    expect(await getRoleFromToken(await generateJwtToken({ role: 'guest', secret: SECRET }), SECRET)).toBe('guest')
  })

  test('reads the user id', async () => {
    const token = await generateJwtToken({ role: 'guest', userId: 'guest-abc', secret: SECRET })

    expect(await getUserIdFromToken(token, SECRET)).toBe('guest-abc')
  })
})

describe('tokens issued by the Python backend', () => {
  test('validate unchanged', async () => {
    const payload = await validateJwtToken(PYJWT_TOKEN, SECRET)

    expect(payload).not.toBeNull()
    expect(payload?.type).toBe('access_token')
    expect(payload?.role).toBe('guest')
    expect(payload?.user_id).toBe('guest-abc123def456')
  })

  test('a legacy token without user_id falls back to the role name', async () => {
    expect(await getUserIdFromToken(PYJWT_LEGACY_NO_USER_ID, SECRET)).toBe('guest')
  })

  test('a legacy token without a role reads as admin', async () => {
    // Loosening this would lock out every unexpired token issued before roles
    // existed, which is why it is asserted rather than tightened.
    expect(await getRoleFromToken(PYJWT_LEGACY_NO_ROLE, SECRET)).toBe('admin')
    expect(await getUserIdFromToken(PYJWT_LEGACY_NO_ROLE, SECRET)).toBe('admin')
  })
})

describe('generateGuestUserId', () => {
  test('matches the shape of Python secrets.token_hex(6)', () => {
    expect(generateGuestUserId()).toMatch(/^guest-[0-9a-f]{12}$/)
  })
})
