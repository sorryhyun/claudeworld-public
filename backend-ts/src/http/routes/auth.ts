/**
 * Authentication routes.
 *
 * Ported from `backend/routers/auth.py`. Response bodies are byte-identical to
 * the Python ones because `frontend/src/contexts/AuthContext.tsx` reads
 * `api_key`, `role` and `user_id` off them and the React app ships unchanged
 * across the cutover.
 */

import { Hono } from 'hono'

import { generateGuestUserId, generateJwtToken } from '../../auth/jwt'
import { validatePasswordWithRole } from '../../auth/passwords'
import { rateLimit } from '../middleware/rate-limit'
import type { AppEnv } from '../types'

/**
 * Build the auth router.
 *
 * A factory, not a module-level singleton, because the login limiter keeps its
 * counters in a closure: two apps sharing one router would share one quota, and
 * a test that exhausts the limit would leak into the next one. Later phases
 * need the same shape anyway, to inject the agent manager and orchestrator.
 */
export function createAuthRoutes(): Hono<AppEnv> {
  const authRoutes = new Hono<AppEnv>()

  /** `@limiter.limit("20/minute")` on login, per IP. */
  const loginRateLimit = rateLimit({
    limit: 20,
    windowMs: 60_000,
    description: '20 per 1 minute',
  })

  /**
 * Exchange a password for a JWT.
 *
 * Admin and guest passwords are both accepted; the role in the token is what
 * separates them. Guests get a random `user_id` so two of them are
 * distinguishable in a shared room.
 */
  authRoutes.post('/login', loginRateLimit, async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ detail: 'Invalid request body' }, 400)
    }

    const password = (body as { password?: unknown } | null)?.password
    if (typeof password !== 'string' || password === '') {
      return c.json({ detail: 'Password is required' }, 400)
    }

    const role = await validatePasswordWithRole(password)
    if (!role) {
      return c.json({ detail: 'Invalid password' }, 401)
    }

    const userId = role === 'admin' ? 'admin' : generateGuestUserId()
    const token = await generateJwtToken({ role, userId, expirationHours: 168 })

    return c.json({
      success: true,
      api_key: token,
      role,
      user_id: userId,
      message: `Login successful as ${role}`,
    })
  })

  /**
   * Confirm a stored token is still valid.
   *
   * Reachable only through the auth middleware, so arriving here *is* the
   * answer; the body just reports which identity the token carries. The
   * `?? 'admin'` fallbacks mirror Python's
   * `getattr(request.state, ..., "admin")` and cover legacy tokens minted
   * before the claims existed.
   */
  authRoutes.get('/verify', (c) =>
    c.json({
      success: true,
      message: 'Authentication valid',
      role: c.get('userRole') ?? 'admin',
      user_id: c.get('userId') ?? 'admin',
    }),
  )

  /** Unauthenticated liveness probe. */
  authRoutes.get('/health', (c) => c.json({ status: 'healthy' }))

  return authRoutes
}
