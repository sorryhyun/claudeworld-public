/**
 * Boot the assembled backend against a throwaway database and hit real routes.
 *
 * The unit suite exercises the app through `app.request()` with hand-built
 * state; this is the other half — `createAppState()` wiring every real service
 * together, the migrations running on an empty file, and the shutdown path
 * unwinding. A boot failure here is the class of bug no unit test can catch,
 * because every one of them constructs the pieces it needs and none of them
 * constructs all of them at once.
 *
 * Run with `bun run smoke`.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.API_KEY_HASH = '$2b$12$H0fCIM9buSuQsCFErTRi0Omz//QVZxCKJW5Dapi2u3ealuUFzvF9O'
process.env.JWT_SECRET = 'smoke-secret'
process.env.ENABLE_GUEST_LOGIN = 'false'

const { resetSettings } = await import('../config/settings')
resetSettings()

const { wrapDb } = await import('../db')
const { openAndInitDb } = await import('../db/migrate')
const { createApp } = await import('../http/app')
const { createAppState } = await import('../http/state')

const dir = mkdtempSync(join(tmpdir(), 'cw-smoke-'))
const sqlite = openAndInitDb({ path: join(dir, 'smoke.db') })
const state = createAppState({ db: wrapDb(sqlite), worldsDir: join(dir, 'worlds') })
const app = createApp(state)

let failures = 0

async function check(
  label: string,
  expected: number,
  request: Response | Promise<Response>,
): Promise<Response> {
  const response = await request
  const body = (await response.clone().text()).slice(0, 100).replace(/\n/g, ' ')
  const ok = response.status === expected
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(response.status).padEnd(4)} ${label.padEnd(34)} ${body}`)
  return response
}

const login = await check(
  'POST /auth/login',
  200,
  app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test_password' }),
  }),
)
const { api_key: apiKey } = (await login.json()) as { api_key: string }
const auth = { headers: { 'X-API-Key': apiKey } }

// Both spellings: FastAPI 307-redirects `/worlds` onto `/worlds/`; Hono does
// not redirect, so the port registers both and this is where that is checked.
await check('GET /worlds', 200, app.request('/worlds', auth))
await check('GET /worlds/', 200, app.request('/worlds/', auth))
// `/importable` must win over `/:world_id`, which also matches it.
await check('GET /worlds/importable', 200, app.request('/worlds/importable', auth))
await check('GET /worlds/999 (absent)', 404, app.request('/worlds/999', auth))
await check('GET /worlds/999/poll', 404, app.request('/worlds/999/poll', auth))
await check('GET /worlds/abc (not an int)', 422, app.request('/worlds/abc', auth))
await check('GET /worlds (no key)', 401, app.request('/worlds'))
await check('GET /nope', 404, app.request('/nope', auth))

const created = await check(
  'POST /worlds',
  200,
  app.request('/worlds', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ name: 'smoke-world', language: 'en', user_name: 'Smoke' }),
  }),
)
const world = (await created.json()) as { id?: number }
if (world.id !== undefined) {
  await check(`GET /worlds/${world.id}`, 200, app.request(`/worlds/${world.id}`, auth))
  await check(`GET /worlds/${world.id}/poll`, 200, app.request(`/worlds/${world.id}/poll`, auth))
  await check(`GET /worlds/${world.id}/state`, 200, app.request(`/worlds/${world.id}/state`, auth))
  await check(
    `GET /worlds/${world.id}/locations`,
    200,
    app.request(`/worlds/${world.id}/locations`, auth),
  )
  await check(
    `GET /worlds/${world.id}/chatting-agents`,
    200,
    app.request(`/worlds/${world.id}/chatting-agents`, auth),
  )
}

await state.shutdown()
sqlite.close()
rmSync(dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
