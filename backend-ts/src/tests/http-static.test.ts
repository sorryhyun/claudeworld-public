/**
 * Single-port serving: the backend answering for the frontend on its own port.
 *
 * The interesting cases are all boundaries — where the SPA ends and the API
 * begins, and where the served tree ends and the rest of the filesystem begins.
 * Both are enforced in `http/static.ts` and neither is visible from a passing
 * `GET /`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetSettings } from '../config/settings'
import { isApiPath, resolveStaticFile } from '../http/static'

process.env.API_KEY_HASH = '$2b$12$H0fCIM9buSuQsCFErTRi0Omz//QVZxCKJW5Dapi2u3ealuUFzvF9O'
process.env.JWT_SECRET = 'static-test-secret'
resetSettings()

const { createApp } = await import('../http/app')

const INDEX_HTML = '<!doctype html><title>ClaudeWorld</title><div id="root"></div>'
const BUNDLE_JS = 'console.log("bundle")'

let distDir: string
let outsideFile: string

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'cw-static-'))
  distDir = join(root, 'dist')
  mkdirSync(join(distDir, 'assets'), { recursive: true })
  writeFileSync(join(distDir, 'index.html'), INDEX_HTML)
  writeFileSync(join(distDir, 'assets', 'index-abc123.js'), BUNDLE_JS)
  writeFileSync(join(distDir, 'favicon.svg'), '<svg/>')

  // A secret sitting one level above the served tree, i.e. exactly what a
  // traversal would be aiming at.
  outsideFile = join(root, '.env')
  writeFileSync(outsideFile, 'JWT_SECRET=leaked')
})

afterAll(() => {
  rmSync(join(distDir, '..'), { recursive: true, force: true })
})

function app() {
  return createApp(undefined, { frontendDir: distDir })
}

describe('isApiPath', () => {
  test('claims a prefix and everything under it', () => {
    expect(isApiPath('/worlds')).toBe(true)
    expect(isApiPath('/worlds/42/state')).toBe(true)
  })

  test('does not let /agents swallow /agent-configs', () => {
    // Both are real routers; a bare startsWith would route one through the
    // other's 404 behaviour.
    expect(isApiPath('/agents')).toBe(true)
    expect(isApiPath('/agent-configs')).toBe(true)
  })

  test('matches on segment boundaries, not string prefixes', () => {
    expect(isApiPath('/authors')).toBe(false)
    expect(isApiPath('/worldsmith')).toBe(false)
  })

  test('leaves SPA routes alone', () => {
    expect(isApiPath('/')).toBe(false)
    expect(isApiPath('/game/abc')).toBe(false)
  })
})

describe('resolveStaticFile', () => {
  test('resolves a file inside the tree', () => {
    expect(resolveStaticFile(distDir, '/assets/index-abc123.js')).toBe(
      join(distDir, 'assets', 'index-abc123.js'),
    )
  })

  test('refuses to climb out of the tree', () => {
    expect(resolveStaticFile(distDir, '/../.env')).toBeNull()
    expect(resolveStaticFile(distDir, '/assets/../../.env')).toBeNull()
  })

  test('refuses an encoded traversal', () => {
    // The path is decoded before it is resolved, so %2e%2e%2f has to be caught
    // by the containment check rather than by looking for literal "..".
    expect(resolveStaticFile(distDir, '/%2e%2e%2f.env')).toBeNull()
  })

  test('returns null for a directory, a miss and a bad escape', () => {
    expect(resolveStaticFile(distDir, '/assets')).toBeNull()
    expect(resolveStaticFile(distDir, '/nope.js')).toBeNull()
    expect(resolveStaticFile(distDir, '/%')).toBeNull()
  })
})

describe('serving the app', () => {
  test('serves index.html at the root without a token', async () => {
    const response = await app().request('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toBe(INDEX_HTML)
  })

  test('serves a hashed asset as immutable', async () => {
    const response = await app().request('/assets/index-abc123.js')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(BUNDLE_JS)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  test('never lets index.html be cached', async () => {
    // It is the pointer at the hashed bundles; a held copy pins a whole stale
    // graph after a deploy.
    const response = await app().request('/')
    expect(response.headers.get('cache-control')).toBe('no-cache')
  })

  test('serves the shell for a deep link into a client-side route', async () => {
    const response = await app().request('/game/some-world/room')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(INDEX_HTML)
  })

  test('answers HEAD with a length and no body', async () => {
    const response = await app().request('/assets/index-abc123.js', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(BUNDLE_JS.length))
    expect(await response.text()).toBe('')
  })
})

describe('the API is not shadowed', () => {
  test('an unauthenticated API call still 401s rather than getting HTML', async () => {
    const response = await app().request('/worlds')
    expect(response.status).toBe(401)
    expect((await response.json()) as { detail: string }).toEqual({
      detail: 'Invalid or missing authentication token',
    })
  })

  test('an unknown API path is rejected as JSON, not answered with the shell', async () => {
    // 401 and not 404: auth middleware runs before the router resolves, so an
    // unauthenticated request never reaches `notFound`. Pre-existing, and
    // unchanged by static serving — what matters here is that the body is the
    // API's error envelope rather than index.html.
    const response = await app().request('/auth/health/nope')
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  test('an open API route is still served by the API', async () => {
    const response = await app().request('/auth/health')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  test('a POST to an unknown path never gets the SPA shell', async () => {
    // Only GET/HEAD fall through to the frontend; a mistyped POST is a client
    // bug and should read as one.
    const response = await app().request('/not-a-route', { method: 'POST' })
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.text()).not.toContain('<div id="root">')
  })
})

describe('without a frontend directory', () => {
  test('nothing is served for a would-be SPA route', async () => {
    // The guard that keeps the test suite independent of whether the developer
    // has run `bun run build`: no `frontendDir`, no HTML anywhere.
    const response = await createApp().request('/game/some-world')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.text()).not.toContain('<div id="root">')
  })

  test('an unauthenticated GET / is still the API 404, not a page', async () => {
    // `/` is on auth's exclusion list, so this one really does reach the
    // router — and must not turn into HTML just because it is the root.
    const response = await createApp().request('/')
    expect(response.status).toBe(404)
    expect((await response.json()) as { detail: string }).toEqual({ detail: 'Not Found' })
  })
})
