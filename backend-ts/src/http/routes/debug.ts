/**
 * Cache statistics and manual cache maintenance.
 *
 * Ported from `backend/routers/debug.py`, mounted under `/debug`. Python routes
 * these through `services/cache_service.py`, which for all three endpoints is a
 * pass-through to the cache manager — so they go straight to `getCache()` here
 * rather than growing a service layer whose only job would be to forward.
 *
 * Nothing in `frontend/` calls these; they exist for poking at a running
 * backend. They are still behind auth, exactly as in Python — `/debug` is on
 * neither exclusion list.
 */

import { Hono } from 'hono'

import { getCache } from '../../infrastructure/cache'
import { getLogger } from '../../infrastructure/logging/logger'
import type { AppEnv } from '../types'

const logger = getLogger('Debug')

/**
 * The wire shape of `CacheManager.get_stats()`.
 *
 * `src/infrastructure/cache.ts` keeps its counters in camelCase because it is
 * an internal module; Python's dict keys are what actually go out over HTTP, so
 * the rename happens here and only here.
 */
interface CacheStatsResponse {
  hits: number
  misses: number
  invalidations: number
  evictions: number
  total_requests: number
  hit_rate: number
  size: number
}

export function createDebugRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/debug/cache/stats', (c) => {
    const stats = getCache().getStats()
    const body: CacheStatsResponse = {
      hits: stats.hits,
      misses: stats.misses,
      invalidations: stats.invalidations,
      evictions: stats.evictions,
      total_requests: stats.totalRequests,
      hit_rate: stats.hitRate,
      size: stats.size,
    }
    return c.json(body)
  })

  routes.post('/debug/cache/cleanup', (c) => {
    getCache().cleanupExpired()
    logger.info('Cache cleanup completed')
    return c.json({ status: 'success', message: 'Cache cleanup completed' })
  })

  routes.post('/debug/cache/clear', (c) => {
    getCache().clear()
    logger.info('Cache cleared')
    return c.json({ status: 'success', message: 'Cache cleared successfully' })
  })

  return routes
}
