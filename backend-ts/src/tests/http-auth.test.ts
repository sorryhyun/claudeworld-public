/**
 * The auth router and middleware as the frontend sees them.
 *
 * `backend/tests/unit/test_auth.py` only covers the functions; the routes and
 * the middleware exclusion table were never tested in Python. They are tested
 * here because the parity contract is about the *HTTP surface* — status codes,
 * body keys and which paths are open — and those are what the React app in
 * `frontend/` reads without knowing which backend answered.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { resetSettings } from '../config/settings'
import { isExcluded } from '../http/middleware/auth'

const PYTHON_BCRYPT_HASH = '$2b$12$H0fCIM9buSuQsCFErTRi0Omz//QVZxCKJW5Dapi2u3ealuUFzvF9O'
const PASSWORD = 'test_password'
const GUEST_PASSWORD = 'guest_password'

const originalEnv = { ...process.env }

// The routes read configuration through `resolveAuthConfig()`, which layers the
// live process env over cached settings — so the env is set here, before the
// app module is imported, and the settings cache is dropped so `.env` on the
// developer's machine cannot win.
process.env.API_KEY_HASH = PYTHON_BCRYPT_HASH
process.env.GUEST_PASSWORD_HASH = await Bun.password.hash(GUEST_PASSWORD, 'bcrypt')
process.env.ENABLE_GUEST_LOGIN = 'true'
process.env.JWT_SECRET = 'http-test-secret'
resetSettings()

const { createApp } = await import('../http/app')
const app = createApp()

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function loginAs(password: string): Promise<{ apiKey: string; role: string; userId: string }> {
  const response = await post('/auth/login', { password })
  const body = (await response.json()) as { api_key: string; role: string; user_id: string }
  return { apiKey: body.api_key, role: body.role, userId: body.user_id }
}

beforeAll(() => {
  process.env.API_KEY_HASH = PYTHON_BCRYPT_HASH
})

afterAll(() => {
  process.env = { ...originalEnv }
  resetSettings()
})

describe('POST /auth/login', () => {
  test('returns the token envelope the frontend reads', async () => {
    const response = await post('/auth/login', { password: PASSWORD })

    expect(response.status).toBe(200)
    // AuthContext.tsx reads exactly api_key, role and user_id off this body.
    expect(await response.json()).toMatchObject({
      success: true,
      role: 'admin',
      user_id: 'admin',
      message: 'Login successful as admin',
    })
  })

  test('issues a guest token for the guest password', async () => {
    const { role, userId } = await loginAs(GUEST_PASSWORD)

    expect(role).toBe('guest')
    expect(userId).toMatch(/^guest-[0-9a-f]{12}$/)
  })

  test('rejects a wrong password with 401 and a detail message', async () => {
    const response = await post('/auth/login', { password: 'nope' })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: 'Invalid password' })
  })

  test('rejects a missing password with 400', async () => {
    const response = await post('/auth/login', {})

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: 'Password is required' })
  })

  test('rejects a non-JSON body with 400', async () => {
    const response = await post('/auth/login', 'not json at all')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: 'Invalid request body' })
  })

  test('needs no token of its own', async () => {
    // Login is on the exclusion list; if it were not, nobody could ever log in.
    expect((await post('/auth/login', { password: PASSWORD })).status).toBe(200)
  })
})

describe('GET /auth/verify', () => {
  test('reports the identity carried by an admin token', async () => {
    const { apiKey } = await loginAs(PASSWORD)
    const response = await app.request('/auth/verify', { headers: { 'X-API-Key': apiKey } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      message: 'Authentication valid',
      role: 'admin',
      user_id: 'admin',
    })
  })

  test('reports the identity carried by a guest token', async () => {
    const { apiKey, userId } = await loginAs(GUEST_PASSWORD)
    const response = await app.request('/auth/verify', { headers: { 'X-API-Key': apiKey } })

    expect(await response.json()).toMatchObject({ role: 'guest', user_id: userId })
  })

  test('401s without a token', async () => {
    const response = await app.request('/auth/verify')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: 'Invalid or missing authentication token' })
  })

  test('401s with a forged token', async () => {
    const response = await app.request('/auth/verify', { headers: { 'X-API-Key': 'a.b.c' } })

    expect(response.status).toBe(401)
  })

  test('a 401 carries CORS headers so the browser can read it', async () => {
    // Without these the frontend sees an opaque network failure and tells the
    // user the server is down, when in fact their session expired.
    const response = await app.request('/auth/verify', {
      headers: { origin: 'http://localhost:5173' },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })
})

describe('GET /auth/health', () => {
  test('answers without a token', async () => {
    const response = await app.request('/auth/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'healthy' })
  })
})

describe('error envelope', () => {
  test('unknown paths 404 with a detail key', async () => {
    const { apiKey } = await loginAs(PASSWORD)
    const response = await app.request('/no/such/route', { headers: { 'X-API-Key': apiKey } })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: 'Not Found' })
  })
})

describe('login rate limiting', () => {
  test('allows 20 attempts a minute and then 429s', async () => {
    // A fresh app, so this test's attempts do not share a window with the
    // logins above — the limiter's counters live in the router's closure.
    const isolated = createApp()
    // An empty body 400s before the handler reaches bcrypt. The limiter runs
    // ahead of the handler either way, so this counts identically to a real
    // password attempt while keeping 21 requests well under a bcrypt round.
    const attempt = () =>
      isolated.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })

    for (let i = 0; i < 20; i++) {
      expect((await attempt()).status).toBe(400)
    }

    const limited = await attempt()
    expect(limited.status).toBe(429)
    // slowapi's body shape, so an existing client parsing it keeps working.
    expect(await limited.json()).toEqual({ error: 'Rate limit exceeded: 20 per 1 minute' })
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  test('a real login is refused once the window is exhausted', async () => {
    const isolated = createApp()
    for (let i = 0; i < 20; i++) {
      await isolated.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    }

    const response = await isolated.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(response.status).toBe(429)
  })
})

describe('middleware exclusions', () => {
  test.each([
    ['/', 'GET'],
    ['/auth/login', 'POST'],
    ['/auth/health', 'GET'],
    ['/docs', 'GET'],
    ['/openapi.json', 'GET'],
    ['/redoc', 'GET'],
    ['/mcp', 'POST'],
    ['/mcp/messages', 'POST'],
    ['/assets/index.js', 'GET'],
    ['/anything.css', 'GET'],
    ['/logo.png', 'GET'],
    ['/agents/12/profile-pic', 'GET'],
    ['/rooms/3/stream', 'GET'],
    ['/rooms/3/anything', 'OPTIONS'],
  ])('%s (%s) needs no token', (path, method) => {
    expect(isExcluded(path, method)).toBe(true)
  })

  test.each([
    ['/rooms', 'GET'],
    ['/rooms/3/messages', 'GET'],
    ['/agents/12', 'GET'],
    ['/auth/verify', 'GET'],
    ['/worlds', 'POST'],
    // The stream exclusion is GET-only: it exists because EventSource cannot
    // send headers, and EventSource only issues GETs.
    ['/rooms/3/stream', 'POST'],
  ])('%s (%s) requires a token', (path, method) => {
    expect(isExcluded(path, method)).toBe(false)
  })
})
