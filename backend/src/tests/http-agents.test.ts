/**
 * The agent surface: CRUD, config listing, reload, direct rooms, profile pics.
 *
 * The route-ordering hazard is the reason several of these exist. Python mounts
 * the management router before the agents router, so `/agents/configs` resolves
 * to the config picker rather than to `/agents/{agent_id}` with a non-integer
 * id. Getting that backwards is a 422 the frontend surfaces as a broken picker.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetSettings } from '@/config/settings'
import { findProfilePic } from '@/http/routes/agents/profile-pic'
import { adminToken, createGameApp, guestToken, type GameAppHarness } from './setup/game-app'

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

async function createAgent(name: string): Promise<{ id: number; name: string }> {
  const response = await app.request('/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, in_a_nutshell: `${name} is a test agent.` }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { id: number; name: string }
}

describe('agent CRUD', () => {
  test('creates an agent inline and builds its system prompt server-side', async () => {
    const created = await createAgent('Testy')
    expect(created.name).toBe('Testy')

    const fetched = await app.json<{ system_prompt: string; config_file: string | null }>(
      `/agents/${created.id}`,
    )
    // Derived, never accepted from the client: it is where an agent's real
    // instructions live.
    expect(fetched.system_prompt).toContain('Testy in a nutshell')
    expect(fetched.system_prompt).toContain('Testy is a test agent.')
    // The inline path must not claim a config folder it was not built from.
    expect(fetched.config_file).toBeNull()
  })

  test('lists agents', async () => {
    await createAgent('Testy')
    const listed = await app.json<{ name: string }[]>('/agents')
    expect(listed.map((a) => a.name)).toContain('Testy')
  })

  test('404s an unknown agent', async () => {
    const response = await app.request('/agents/99999')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { detail: string }).detail).toBe('Agent not found')
  })

  test('patches an agent, admin only', async () => {
    const agent = await createAgent('Testy')

    const asGuest = await app.request(`/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ characteristics: 'grumpy' }),
      token: await guestToken(),
    })
    expect(asGuest.status).toBe(403)

    const asAdmin = await app.request(`/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ characteristics: 'grumpy' }),
      token: await adminToken(),
    })
    expect(asAdmin.status).toBe(200)
    expect(((await asAdmin.json()) as { characteristics: string }).characteristics).toBe('grumpy')
  })

  test('deletes an agent, admin only', async () => {
    const agent = await createAgent('Testy')

    expect(
      (await app.request(`/agents/${agent.id}`, { method: 'DELETE', token: await guestToken() }))
        .status,
    ).toBe(403)

    const deleted = await app.request(`/agents/${agent.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect((await app.request(`/agents/${agent.id}`)).status).toBe(404)
  })
})

describe('route ordering', () => {
  test('/agents/configs is the picker, not an agent lookup', async () => {
    // Registered before `/agents/:agent_id`; the other order makes this a 422.
    const response = await app.request('/agents/configs')
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('configs')
  })

  test('a non-integer agent id is still a 422', async () => {
    const response = await app.request('/agents/not-a-number')
    expect(response.status).toBe(422)
  })
})

describe('direct rooms', () => {
  test('creates the 1-on-1 room on first ask and reuses it after', async () => {
    const agent = await createAgent('Testy')

    const first = await app.json<{ id: number; name: string; agents: { id: number }[] }>(
      `/agents/${agent.id}/direct-room`,
    )
    expect(first.name).toBe('Direct: Testy')
    expect(first.agents.map((a) => a.id)).toEqual([agent.id])

    const second = await app.json<{ id: number }>(`/agents/${agent.id}/direct-room`)
    expect(second.id).toBe(first.id)
  })

  test('404s for an agent that does not exist', async () => {
    expect((await app.request('/agents/99999/direct-room')).status).toBe(404)
  })
})

describe('profile pictures', () => {
  test('rejects a traversal in the agent name', async () => {
    // This route is unauthenticated — `<img src>` cannot send a header — so the
    // name check is the only thing between an anonymous caller and the disk.
    //
    // The assertion is "never serves anything", not a specific status, because
    // the two backends reject these at different layers and therefore with
    // different codes. Measured against the Python backend:
    //
    //   /agents/../profile-pic              ts 401, py 400
    //   /agents/..%2F..%2Fetc%2Fpasswd/...  ts 400, py 404
    //
    // Starlette leaves `..` in the path and the handler rejects it; Hono
    // normalises it away before routing, so the request lands on a path that
    // does not exist. Both refuse. No legitimate client sends either form, and
    // matching the codes would mean defeating Hono's normalisation — which is
    // the layer doing the protecting.
    for (const name of ['..', '..%2F..%2Fetc%2Fpasswd', 'a%2F..%2F..%2Fb']) {
      const response = await app.request(`/agents/${name}/profile-pic`, { token: null })
      expect(response.status).not.toBe(200)
      expect([400, 401, 404]).toContain(response.status)
    }
  })

  test('the handler itself rejects a traversal that reaches it', async () => {
    // The encoded-slash form does reach the handler — Hono keeps `%2F` in the
    // param — so this pins the handler's own check rather than the router's.
    const response = await app.request('/agents/..%2F..%2Fsecrets/profile-pic', { token: null })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { detail: string }).detail).toBe('Invalid agent name')
  })

  test('404s when the agent has no picture', async () => {
    const response = await app.request('/agents/Nobody/profile-pic', { token: null })
    expect(response.status).toBe(404)
  })

  test('serves a picture without a token, and caches it', async () => {
    const agentsDir = join(app.state.projectRoot, 'agents', 'Picasso')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'profile.png'), 'not-really-a-png')

    const response = await app.request('/agents/Picasso/profile-pic', { token: null })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600, must-revalidate')
  })

  test('finds a picture inside a group folder', async () => {
    const groupDir = join(app.state.projectRoot, 'agents', 'group_test', 'Grouped')
    mkdirSync(groupDir, { recursive: true })
    writeFileSync(join(groupDir, 'avatar.webp'), 'x')

    const found = findProfilePic(join(app.state.projectRoot, 'agents'), 'Grouped')
    expect(found).toBe(join(groupDir, 'avatar.webp'))
  })

  test('prefers a conventional name over any other image', async () => {
    const dir = join(app.state.projectRoot, 'agents', 'Choosy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'zzz-other.png'), 'x')
    writeFileSync(join(dir, 'profile.png'), 'x')

    expect(findProfilePic(join(app.state.projectRoot, 'agents'), 'Choosy')).toBe(
      join(dir, 'profile.png'),
    )
  })

  test('falls back to the legacy single-file layout', async () => {
    const agentsDir = join(app.state.projectRoot, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'Legacy.jpg'), 'x')

    expect(findProfilePic(agentsDir, 'Legacy')).toBe(join(agentsDir, 'Legacy.jpg'))
  })
})
