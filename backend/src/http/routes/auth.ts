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
import type { SessionPool } from '../../sdk/client/session-pool'
import { rateLimit } from '../middleware/rate-limit'
import type { AppEnv } from '../types'

/**
 * Build the auth router.
 *
 * A factory, not a module-level singleton, because the login limiter keeps its
 * counters in a closure: two apps sharing one router would share one quota, and
 * a test that exhausts the limit would leak into the next one. Later phases
 * need the same shape anyway, to inject the agent manager and orchestrator.
 *
 * @param pool The session pool `/health/pool` reports on. Optional so the auth
 *   surface still stands up on its own; that endpoint 503s without it.
 */
export function createAuthRoutes(pool?: SessionPool): Hono<AppEnv> {
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

  /**
   * Session-pool statistics, for eyeballing a running backend.
   *
   * Deferred out of Phase 1 because nothing in the HTTP layer owned the pool
   * yet. Python reaches it as `app.state.agent_manager.client_pool`; here it is
   * `AppState.pool`, so the router takes it as an argument. Absent (the
   * auth-only app the settings tests stand up) it 503s rather than pretending
   * to have a pool of size zero.
   *
   * Behind auth, as in Python — `/auth/health/pool` is on no exclusion list;
   * only the bare `/auth/health` is.
   */
  authRoutes.get('/health/pool', (c) => {
    if (!pool) {
      return c.json({ detail: 'Session pool not available' }, 503)
    }
    const stats = pool.stats()
    return c.json({
      pool_size: stats.poolSize,
      pool_keys: stats.poolKeys,
      pending_cleanup_tasks: stats.pendingCleanupTasks,
      active_clients: stats.activeClients,
      connection_semaphore_available: stats.connectionSemaphoreAvailable,
      max_concurrent_connections: stats.maxConcurrentConnections,
    })
  })

  return authRoutes
}
