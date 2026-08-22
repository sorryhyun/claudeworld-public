/**
 * Cache statistics and manual cache maintenance, under `/debug`. Nothing in
 * `frontend/` calls these; they exist for poking at a running backend, and they
 * are behind auth — `/debug` is on neither exclusion list.
 */

import { Hono } from 'hono'

import { getCache } from '../../infrastructure/cache'
import { getLogger } from '../../infrastructure/logging/logger'
import type { AppEnv } from '../types'

const logger = getLogger('Debug')

// `infrastructure/cache.ts` keeps its counters in camelCase; the snake_case
// rename to the wire happens only here.
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
