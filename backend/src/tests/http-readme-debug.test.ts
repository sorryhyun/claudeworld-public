/**
 * The two routers that hang off nothing: `/readme` and `/debug/cache/*`.
 *
 * Ported from `backend/routers/readme.py` and `backend/routers/debug.py`. Both
 * are small, and both are easy to get subtly wrong in ways only a client
 * notices: the readme is served as *text* (the help modal hands the body to a
 * markdown renderer, so a JSON envelope would render as literal JSON), and the
 * cache stats go out in snake_case even though the cache module counts in
 * camelCase.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSettings } from '@/config/settings'
import { getCache } from '@/infrastructure/cache'
import { createGameApp, type GameAppHarness } from './setup/game-app'

/** `debug.py`'s wire shape, spelled out so the assertions are not index reads. */
interface CacheStatsBody {
  hits: number
  misses: number
  invalidations: number
  evictions: number
  total_requests: number
  hit_rate: number
  size: number
}

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

describe('GET /readme', () => {
  test('serves the language-specific file as plain text', async () => {
    writeFileSync(join(app.state.projectRoot, 'ko_readme.md'), '# 사용법\n', 'utf-8')

    const response = await app.request('/readme?lang=ko')

    expect(response.status).toBe(200)
    // Not JSON: `HowToUseModal.tsx` calls `response.text()` and renders the
    // result as markdown.
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toBe('# 사용법\n')
  })

  test('defaults to English when no language is given', async () => {
    writeFileSync(join(app.state.projectRoot, 'en_readme.md'), 'english\n', 'utf-8')

    expect(await (await app.request('/readme')).text()).toBe('english\n')
  })

  test('404s with the filename when the file is missing', async () => {
    const response = await app.request('/readme?lang=jp')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: 'Readme file not found: jp_readme.md' })
  })

  test('422s on a language outside the pattern', async () => {
    // FastAPI rejects this at the `Query(regex=...)` layer, before the handler,
    // so it is a validation failure rather than a 404 on a made-up filename.
    const response = await app.request('/readme?lang=fr')

    expect(response.status).toBe(422)
    const body = (await response.json()) as { detail: { loc: string[] }[] }
    expect(body.detail[0]?.loc).toEqual(['query', 'lang'])
  })

  test('requires authentication', async () => {
    expect((await app.request('/readme', { token: null })).status).toBe(401)
  })
})

describe('/debug/cache', () => {
  test('reports stats in Python\'s snake_case wire shape', async () => {
    const cache = getCache()
    // `clear()` drops entries but deliberately keeps the counters, in both
    // backends — so the assertions below are on deltas, not absolutes.
    const before = await app.json<CacheStatsBody>('/debug/cache/stats')

    cache.set('debug-test', 1, 60)
    cache.get('debug-test')
    cache.get('debug-miss')

    const stats = await app.json<CacheStatsBody>('/debug/cache/stats')

    // The key names are the contract; `CacheStats` in `infrastructure/cache.ts`
    // is camelCase and must not leak.
    expect(Object.keys(stats).sort()).toEqual([
      'evictions',
      'hit_rate',
      'hits',
      'invalidations',
      'misses',
      'size',
      'total_requests',
    ])
    expect(stats.hits - before.hits).toBe(1)
    expect(stats.misses - before.misses).toBe(1)
    expect(stats.total_requests).toBe(stats.hits + stats.misses)
    // Python rounds the percentage to two places; so does `getStats()`.
    expect(stats.hit_rate).toBeCloseTo(
      Math.round((stats.hits / stats.total_requests) * 10000) / 100,
      5,
    )
  })

  test('cleanup and clear both report success', async () => {
    const cache = getCache()
    cache.set('kept', 1, 60)

    const cleanup = await app.request('/debug/cache/cleanup', { method: 'POST' })
    expect(cleanup.status).toBe(200)
    expect(await cleanup.json()).toEqual({
      status: 'success',
      message: 'Cache cleanup completed',
    })
    // `cleanup_expired` drops only expired entries.
    expect(cache.get<number>('kept')).toBe(1)

    const clear = await app.request('/debug/cache/clear', { method: 'POST' })
    expect(clear.status).toBe(200)
    expect(await clear.json()).toEqual({
      status: 'success',
      message: 'Cache cleared successfully',
    })
    expect(cache.get<number>('kept')).toBeUndefined()
  })

  test('requires authentication', async () => {
    expect((await app.request('/debug/cache/stats', { token: null })).status).toBe(401)
  })
})
