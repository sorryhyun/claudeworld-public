/** `AuthContext.tsx` reads `api_key`, `role` and `user_id` off these bodies. */

import { Hono } from 'hono'

import { generateGuestUserId, generateJwtToken } from '@/auth/jwt'
import { validatePasswordWithRole } from '@/auth/passwords'
import type { SessionPool } from '@/sdk/client/session-pool'
import { rateLimit } from '@/http/middleware/rate-limit'
import type { AppEnv } from '@/http/types'

/**
 * A factory, not a singleton: the login limiter keeps its counters in a
 * closure, and two apps sharing one router would share one quota.
 */
export function createAuthRoutes(pool?: SessionPool): Hono<AppEnv> {
  const authRoutes = new Hono<AppEnv>()

  const loginRateLimit = rateLimit({
    limit: 20,
    windowMs: 60_000,
    description: '20 per 1 minute',
  })

  /** Admin and guest passwords are both accepted; the role in the token separates them. */
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
   * Reachable only through the auth middleware, so arriving here *is* the
   * answer. The `?? 'admin'` fallbacks cover tokens minted before the claims.
   */
  authRoutes.get('/verify', (c) =>
    c.json({
      success: true,
      message: 'Authentication valid',
      role: c.get('userRole') ?? 'admin',
      user_id: c.get('userId') ?? 'admin',
    }),
  )

  authRoutes.get('/health', (c) => c.json({ status: 'healthy' }))

  /** Behind auth: only the bare `/auth/health` is on the exclusion list. */
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
