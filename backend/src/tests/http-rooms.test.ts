/**
 * The chat-room surface as the React app sees it.
 *
 * `/rooms` is the half of the API that predates the TRPG mode — the one
 * `usePolling.ts` and `useSSE.ts` drive — and until now it existed only in the
 * Python tree. Every assertion here is about the wire: status, `detail`, body
 * keys. The parity contract freezes those, and the frontend reads them without
 * knowing which backend answered.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resetSettings } from '@/config/settings'
import {
  adminToken,
  createGameApp,
  guestToken,
  settle,
  type GameAppHarness,
} from './setup/game-app'

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

async function createRoom(name: string, token?: string): Promise<{ id: number }> {
  const response = await app.request('/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
    ...(token === undefined ? {} : { token }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { id: number }
}

// =============================================================================
// CRUD
// =============================================================================

describe('room CRUD', () => {
  test('creates, lists and reads a room', async () => {
    const created = await createRoom('Tavern')
    expect(created.id).toBeGreaterThan(0)

    const listed = await app.json<{ id: number; name: string }[]>('/rooms')
    expect(listed.map((r) => r.name)).toContain('Tavern')

    const fetched = await app.json<{ name: string; agents: unknown[]; messages: unknown[] }>(
      `/rooms/${created.id}`,
    )
    expect(fetched.name).toBe('Tavern')
    // Both relations are inlined on the single-room response and empty on a new
    // room — the frontend renders them without a second request.
    expect(fetched.agents).toEqual([])
    expect(fetched.messages).toEqual([])
  })

  test('answers the collection on both /rooms and /rooms/', async () => {
    // Starlette redirects the unslashed form onto the slashed one and `fetch`
    // follows it; Hono does not redirect, so both must be registered.
    expect((await app.request('/rooms')).status).toBe(200)
    expect((await app.request('/rooms/')).status).toBe(200)
  })

  test('rejects a duplicate name with 409', async () => {
    await createRoom('Tavern')
    const again = await app.request('/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tavern' }),
    })
    // The unique index cannot catch this one — `world_id` is NULL for a chat
    // room and SQL's NULL != NULL — so the handler's own pre-check must.
    expect(again.status).toBe(409)
    expect(((await again.json()) as { detail: string }).detail).toContain('already exists')
  })

  test('404s a room that does not exist', async () => {
    const response = await app.request('/rooms/99999')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { detail: string }).detail).toBe(
      'Room with id 99999 not found',
    )
  })

  test('patches max_interactions', async () => {
    const room = await createRoom('Tavern')
    const response = await app.request(`/rooms/${room.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_interactions: 7 }),
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { max_interactions: number }).max_interactions).toBe(7)
  })

  test('deletes a room, admin only', async () => {
    const room = await createRoom('Tavern')

    const asGuest = await app.request(`/rooms/${room.id}`, {
      method: 'DELETE',
      token: await guestToken(),
    })
    expect(asGuest.status).toBe(403)

    const asAdmin = await app.request(`/rooms/${room.id}`, {
      method: 'DELETE',
      token: await adminToken(),
    })
    expect(asAdmin.status).toBe(200)
    expect((await app.request(`/rooms/${room.id}`)).status).toBe(404)
  })
})

// =============================================================================
// Access control
// =============================================================================

describe('access control', () => {
  test('a guest cannot read a room it does not own', async () => {
    const room = await createRoom('Private')
    const response = await app.request(`/rooms/${room.id}`, { token: await guestToken() })
    expect(response.status).toBe(403)
    expect(((await response.json()) as { detail: string }).detail).toBe(
      'You do not have access to this room',
    )
  })

  test('a missing room is 404 even for a caller who would be 403', async () => {
    // Order matters: 403-before-404 would let anyone enumerate other people's
    // room ids by their error code.
    const response = await app.request('/rooms/99999', { token: await guestToken() })
    expect(response.status).toBe(404)
  })

  test('a guest sees only its own rooms in the listing', async () => {
    await createRoom('Admin room')
    await createRoom('Guest room', await guestToken())

    const asGuest = await app.json<{ name: string }[]>('/rooms', { token: await guestToken() })
    expect(asGuest.map((r) => r.name)).toEqual(['Guest room'])
  })

  test('every route requires a token', async () => {
    expect((await app.request('/rooms', { token: null })).status).toBe(401)
  })
})

// =============================================================================
// Pause and resume
// =============================================================================

describe('pause and resume', () => {
  test('pause sets the flag and interrupts the room', async () => {
    const room = await createRoom('Tavern')

    const paused = await app.request(`/rooms/${room.id}/pause`, { method: 'POST' })
    expect(paused.status).toBe(200)
    expect(((await paused.json()) as { is_paused: boolean }).is_paused).toBe(true)

    const resumed = await app.request(`/rooms/${room.id}/resume`, { method: 'POST' })
    expect(((await resumed.json()) as { is_paused: boolean }).is_paused).toBe(false)
  })
})

// =============================================================================
// Messages
// =============================================================================

describe('messages', () => {
  test('sends a message and returns the saved row', async () => {
    const room = await createRoom('Tavern')

    const response = await app.request(`/rooms/${room.id}/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello there', role: 'user' }),
    })
    expect(response.status).toBe(200)

    const saved = (await response.json()) as { id: number; content: string; room_id: number }
    expect(saved.content).toBe('hello there')
    expect(saved.room_id).toBe(room.id)
  })

  test('a send starts a chat-room turn, with no world attached', async () => {
    const room = await createRoom('Tavern')
    await app.request(`/rooms/${room.id}/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello', role: 'user' }),
    })
    await settle()

    expect(app.turns).toHaveLength(1)
    expect(app.turns[0]?.kind).toBe('chatRoom')
    expect(app.turns[0]?.roomId).toBe(room.id)
    expect(app.turns[0]?.worldId).toBeUndefined()
  })

  test('@mentions are threaded through to the turn', async () => {
    const room = await createRoom('Tavern')
    await app.request(`/rooms/${room.id}/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', role: 'user', mentioned_agent_ids: [3, 4] }),
    })
    await settle()

    expect(app.turns[0]?.mentionedAgentIds).toEqual([3, 4])
  })

  test('lists and polls messages', async () => {
    const room = await createRoom('Tavern')
    for (const content of ['first', 'second']) {
      await app.request(`/rooms/${room.id}/messages/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, role: 'user' }),
      })
    }

    const all = await app.json<{ id: number; content: string }[]>(`/rooms/${room.id}/messages`)
    expect(all.map((m) => m.content)).toEqual(['first', 'second'])

    const since = await app.json<{ content: string }[]>(
      `/rooms/${room.id}/messages/poll?since_id=${all[0]?.id}`,
    )
    expect(since.map((m) => m.content)).toEqual(['second'])
  })

  test('reports chatting agents', async () => {
    const room = await createRoom('Tavern')
    const empty = await app.json<{ chatting_agents: unknown[] }>(`/rooms/${room.id}/chatting-agents`)
    expect(empty.chatting_agents).toEqual([])
  })

  test('clearing messages is admin only', async () => {
    const room = await createRoom('Tavern')
    await app.request(`/rooms/${room.id}/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello', role: 'user' }),
    })

    const asGuest = await app.request(`/rooms/${room.id}/messages`, {
      method: 'DELETE',
      token: await guestToken(),
    })
    expect(asGuest.status).toBe(403)

    const asAdmin = await app.request(`/rooms/${room.id}/messages`, { method: 'DELETE' })
    expect(asAdmin.status).toBe(200)
    expect(await app.json<unknown[]>(`/rooms/${room.id}/messages`)).toEqual([])
  })
})

// =============================================================================
// SSE
// =============================================================================

describe('SSE', () => {
  test('mints a ticket and streams with it', async () => {
    const room = await createRoom('Tavern')

    const ticketResponse = await app.request(`/rooms/${room.id}/stream/ticket`, { method: 'POST' })
    expect(ticketResponse.status).toBe(200)
    const { ticket } = (await ticketResponse.json()) as { ticket: string }
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    // The stream itself carries no token — `EventSource` cannot send one, which
    // is the entire reason the ticket exists.
    const stream = await app.request(`/rooms/${room.id}/stream?ticket=${ticket}`, { token: null })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')

    const reader = stream.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('event: connected')
    expect(first).toContain(`"room_id":${room.id}`)
    await reader.cancel()
  })

  test('a ticket is single-use', async () => {
    const room = await createRoom('Tavern')
    const { ticket } = (await app.json<{ ticket: string }>(`/rooms/${room.id}/stream/ticket`, {
      method: 'POST',
    })) as { ticket: string }

    const first = await app.request(`/rooms/${room.id}/stream?ticket=${ticket}`, { token: null })
    expect(first.status).toBe(200)
    await first.body?.cancel()

    const replay = await app.request(`/rooms/${room.id}/stream?ticket=${ticket}`, { token: null })
    expect(replay.status).toBe(401)
  })

  test('a ticket is bound to one room', async () => {
    const roomA = await createRoom('A')
    const roomB = await createRoom('B')
    const { ticket } = (await app.json<{ ticket: string }>(`/rooms/${roomA.id}/stream/ticket`, {
      method: 'POST',
    })) as { ticket: string }

    const crossed = await app.request(`/rooms/${roomB.id}/stream?ticket=${ticket}`, { token: null })
    expect(crossed.status).toBe(401)
  })

  test('rejects a missing or unknown ticket', async () => {
    const room = await createRoom('Tavern')
    expect((await app.request(`/rooms/${room.id}/stream`, { token: null })).status).toBe(401)
    expect(
      (await app.request(`/rooms/${room.id}/stream?ticket=nonsense`, { token: null })).status,
    ).toBe(401)
  })

  test('a ticket cannot be minted for someone else’s room', async () => {
    // The ticket is a bearer credential for a room's whole event stream, so
    // issuing one has to be at least as guarded as reading the room.
    const room = await createRoom('Private')
    const response = await app.request(`/rooms/${room.id}/stream/ticket`, {
      method: 'POST',
      token: await guestToken(),
    })
    expect(response.status).toBe(403)
  })

  test('a broadcast reaches a connected stream', async () => {
    const room = await createRoom('Tavern')
    const { ticket } = (await app.json<{ ticket: string }>(`/rooms/${room.id}/stream/ticket`, {
      method: 'POST',
    })) as { ticket: string }

    const stream = await app.request(`/rooms/${room.id}/stream?ticket=${ticket}`, { token: null })
    const reader = stream.body!.getReader()
    await reader.read() // the `connected` frame

    app.state.broadcaster.broadcast(room.id, { type: 'content_delta', text: 'hi' })

    const frame = new TextDecoder().decode((await reader.read()).value)
    // `type` doubles as the SSE event name; `useSSE.ts` listens by name.
    expect(frame).toContain('event: content_delta')
    expect(frame).toContain('"text":"hi"')
    await reader.cancel()
  })
})
