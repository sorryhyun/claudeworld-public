/**
 * `GET /auth/health/pool`.
 *
 * Deferred out of Phase 1 with a note in `docs/ts-migration-plan.md`: the
 * endpoint reports on the SDK client pool, and no part of the HTTP layer owned
 * one until Phase 3 wired `AppState.pool` through.
 *
 * Two things are worth pinning. The key names, because Python's `pool_stats`
 * returns snake_case and `SessionPool.stats()` counts in camelCase — a crossed
 * pair there is invisible until somebody reads the numbers. And the fact that
 * an app with no pool answers 503 rather than reporting an empty pool, which
 * would read as "no sessions" when the truth is "no backend".
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resetSettings } from '../config/settings'
import { SessionPool } from '../sdk/client/session-pool'
import { createGameApp, type GameAppHarness } from './setup/game-app'

const originalEnv = { ...process.env }

let app: GameAppHarness

beforeEach(async () => {
  app = await createGameApp()
})

afterEach(() => {
  app.cleanup()
})

afterAll(() => {
  process.env = { ...originalEnv }
  resetSettings()
})

describe('GET /auth/health/pool', () => {
  test('reports the pool in Python\'s snake_case wire shape', async () => {
    const body = await app.json<Record<string, unknown>>('/auth/health/pool')

    expect(body).toEqual({
      pool_size: 3,
      pool_keys: ['room_1_agent_1', 'room_1_agent_2', 'room_2_agent_1'],
      pending_cleanup_tasks: 0,
      active_clients: 1,
      connection_semaphore_available: 7,
      max_concurrent_connections: 10,
    })
  })

  test('is behind auth, unlike the bare /auth/health', async () => {
    expect((await app.request('/auth/health/pool', { token: null })).status).toBe(401)
    expect((await app.request('/auth/health', { token: null })).status).toBe(200)
  })
})

describe('SessionPool.stats', () => {
  test('an untouched pool reports every slot free', () => {
    const pool = new SessionPool(10)

    expect(pool.stats()).toEqual({
      poolSize: 0,
      poolKeys: [],
      pendingCleanupTasks: 0,
      activeClients: 0,
      connectionSemaphoreAvailable: 10,
      maxConcurrentConnections: 10,
    })
  })
})
