/**
 * `/mcp-tools` — the simplified, unauthenticated agent surface.
 *
 * The router is not mounted in `createApp` yet, so these tests build their own
 * one-router Hono app with the same middleware and the same error envelope
 * `createApp` gives it. That is deliberate rather than temporary scaffolding:
 * the auth *exclusion* is half of this surface's contract, and mounting the
 * real `authMiddleware` here is what pins it.
 *
 * `RoomOrchestrator` is replaced with a stub that writes the messages a turn
 * would have written, for the reason the route module explains at length: these
 * two endpoints block on the turn and answer with what it persisted, so the
 * thing under test is "does the handler wait, and does it read back the right
 * rows" — not the tape.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { resetSettings } from '../config/settings'
import { createAgent } from '../crud/agents'
import { createMessage } from '../crud/messages'
import { getAgentsInRoom, getRoom } from '../crud/rooms'
import type { Db } from '../db'
import { HttpError } from '../domain/errors'
import { authMiddleware } from '../http/middleware/auth'
import { createMcpToolsRoutes } from '../http/routes/mcp-tools'
import type { AppState } from '../http/state'
import type { AppEnv } from '../http/types'
import type {
  ChatRoomMessageInput,
  RoomOrchestrator,
  TurnOutcome,
} from '../orchestration/room-orchestrator'
import type { AgentInfo, ChatResponse, ConversationMessage, RoomCreated } from '../schemas/mcp-tools'
import { createGameApp, type GameAppHarness } from './setup/game-app'

const originalEnv = { ...process.env }

let harness: GameAppHarness

/** Every chat-room turn the router asked for, in order. */
let turnCalls: ChatRoomMessageInput[]

/** What the next turn does. Replaced per test; silent by default. */
let turnBehaviour: (input: ChatRoomMessageInput, db: Db) => TurnOutcome

beforeEach(async () => {
  // Pinned rather than inherited: `USER_NAME` is what the user's messages are
  // stored under, and a developer's own `.env` would otherwise decide it.
  process.env.USER_NAME = 'Tester'
  harness = await createGameApp()
  turnCalls = []
  turnBehaviour = () => ({ completed: true })
})

afterEach(() => {
  harness.cleanup()
})

afterAll(() => {
  process.env = { ...originalEnv }
  resetSettings()
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The app under test: `authMiddleware`, the router, and `createApp`'s error
 * envelope. Only `handleChatRoomMessage` is stubbed on the orchestrator —
 * anything else the router reaches for should surface as a TypeError rather
 * than be absorbed by a mock, which is the convention `setup/game-app.ts` uses.
 */
function mountRouter(): Hono<AppEnv> {
  const orchestrator = {
    handleChatRoomMessage: (input: ChatRoomMessageInput): Promise<TurnOutcome> => {
      turnCalls.push(input)
      return Promise.resolve(turnBehaviour(input, harness.db))
    },
  } as unknown as RoomOrchestrator

  const state: AppState = { ...harness.state, orchestrator }

  const app = new Hono<AppEnv>()
  app.use('*', authMiddleware)
  app.route('/', createMcpToolsRoutes(state))
  app.notFound((c) => c.json({ detail: 'Not Found' }, 404))
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ detail: error.detail }, error.status as 400)
    return c.json({ detail: 'Internal Server Error' }, 500)
  })
  return app
}

/** No token on any of these: the whole surface is excluded from auth. */
async function post(path: string, body: unknown): Promise<Response> {
  return mountRouter().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function get(path: string): Promise<Response> {
  return mountRouter().request(path)
}

/** A turn that writes one message per entry, as the real tape would. */
function replies(...written: { agentId: number; content: string; thinking?: string }[]) {
  return (input: ChatRoomMessageInput, db: Db): TurnOutcome => {
    for (const reply of written) {
      createMessage(db, input.roomId, {
        content: reply.content,
        role: 'assistant',
        agentId: reply.agentId,
        participantType: 'character',
        thinking: reply.thinking ?? null,
      })
    }
    return { completed: true }
  }
}

function addAgent(name: string, group: string | null = null): number {
  return createAgent(harness.db, { name, systemPrompt: `${name} prompt`, group }).id
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('authentication', () => {
  test('the whole surface is excluded, because "/mcp-tools" starts with "/mcp"', async () => {
    // No `X-API-Key` anywhere in this file. If the exclusion is ever narrowed
    // to the MCP endpoint alone, every test here turns into a 401 at once.
    expect((await get('/mcp-tools/agents')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// GET /mcp-tools/agents
// ---------------------------------------------------------------------------

describe('GET /mcp-tools/agents', () => {
  test('lists every agent as id, name and group only', async () => {
    addAgent('프리렌', 'group_슈타게')

    const listed = (await (await get('/mcp-tools/agents')).json()) as AgentInfo[]

    expect(listed.map((a) => a.name)).toEqual([
      'Onboarding_Manager',
      'Action_Manager',
      'Narrator',
      'Chat_Summarizer',
      '프리렌',
    ])
    // Three keys, not the fourteen on `schemas.Agent`: no system prompt here.
    expect(Object.keys(listed[4]!).sort()).toEqual(['group', 'id', 'name'])
    expect(listed[4]?.group).toBe('group_슈타게')
    expect(listed[0]?.group).toBe('gameplay')
  })
})

// ---------------------------------------------------------------------------
// POST /mcp-tools/chat
// ---------------------------------------------------------------------------

describe('POST /mcp-tools/chat', () => {
  test('opens the direct room, saves the message, and answers with the reply', async () => {
    const agentId = addAgent('프리렌')
    turnBehaviour = replies({ agentId, content: '오랜만이야.', thinking: '누구였더라' })

    const response = await post('/mcp-tools/chat', { agent_name: '프리렌', message: '안녕!' })
    expect(response.status).toBe(200)

    const body = (await response.json()) as ChatResponse
    expect(body.agent_name).toBe('프리렌')
    expect(body.response).toBe('오랜만이야.')
    expect(body.thinking).toBe('누구였더라')

    // The direct room is the one `/agents/{id}/direct-room` hands the frontend:
    // same name, same `admin` owner, and no world.
    const room = getRoom(harness.db, body.room_id)
    expect(room?.name).toBe('Direct: 프리렌')
    expect(room?.ownerId).toBe('admin')
    expect(room?.worldId).toBeNull()
    expect(getAgentsInRoom(harness.db, body.room_id).map((a) => a.id)).toEqual([agentId])

    // The user's message is persisted before the turn runs, under the
    // configured display name.
    const user = room?.messages.find((m) => m.role === 'user')
    expect(user?.content).toBe('안녕!')
    expect(user?.participantName).toBe('Tester')
    expect(user?.participantType).toBe('user')
  })

  test('waits for the turn rather than starting it in the background', async () => {
    const agentId = addAgent('프리렌')
    let finished = false
    turnBehaviour = (input, db) => {
      replies({ agentId, content: 'done' })(input, db)
      finished = true
      return { completed: true }
    }

    const body = (await (
      await post('/mcp-tools/chat', { agent_name: '프리렌', message: 'hi' })
    ).json()) as ChatResponse

    // The whole point of the router: a tool call has nowhere to put a stream.
    expect(finished).toBe(true)
    expect(body.response).toBe('done')
  })

  test('asks only the requested agent to respond', async () => {
    const agentId = addAgent('프리렌')
    await post('/mcp-tools/chat', { agent_name: '프리렌', message: 'hi' })

    expect(turnCalls).toHaveLength(1)
    // Python's `responding_agents=[agent]`, expressed as a mention filter.
    expect(turnCalls[0]?.mentionedAgentIds).toEqual([agentId])
    expect(turnCalls[0]?.action).toBe('hi')
  })

  test('an agent that says nothing answers with the silent literal', async () => {
    addAgent('프리렌')

    const body = (await (
      await post('/mcp-tools/chat', { agent_name: '프리렌', message: 'hi' })
    ).json()) as ChatResponse

    expect(body.response).toBe('*stays silent*')
    expect(body.thinking).toBeNull()
  })

  test('a partial, case-insensitive name resolves to the real agent', async () => {
    const agentId = addAgent('Dr. Chen')
    turnBehaviour = replies({ agentId, content: 'Hello.' })

    const body = (await (
      await post('/mcp-tools/chat', { agent_name: 'chen', message: 'hi' })
    ).json()) as ChatResponse

    // Answered under the agent's real name, not the requested spelling.
    expect(body.agent_name).toBe('Dr. Chen')
    expect(body.response).toBe('Hello.')
  })

  test('an exact match beats a substring one', async () => {
    addAgent('Chen Wei')
    const exact = addAgent('Chen')
    turnBehaviour = replies({ agentId: exact, content: 'the exact one' })

    const body = (await (
      await post('/mcp-tools/chat', { agent_name: 'Chen', message: 'hi' })
    ).json()) as ChatResponse

    expect(body.agent_name).toBe('Chen')
  })

  test('reuses the direct room across calls', async () => {
    addAgent('프리렌')
    const first = (await (
      await post('/mcp-tools/chat', { agent_name: '프리렌', message: 'one' })
    ).json()) as ChatResponse
    const second = (await (
      await post('/mcp-tools/chat', { agent_name: '프리렌', message: 'two' })
    ).json()) as ChatResponse

    expect(second.room_id).toBe(first.room_id)
    expect(getRoom(harness.db, first.room_id)?.messages).toHaveLength(2)
  })

  test('a turn that threw is a 500, not a silent agent', async () => {
    addAgent('프리렌')
    turnBehaviour = () => ({ completed: false, error: new Error('session died') })

    const response = await post('/mcp-tools/chat', { agent_name: '프리렌', message: 'hi' })
    expect(response.status).toBe(500)
    expect(((await response.json()) as { detail: string }).detail).toBe(
      'Agent turn failed: session died',
    )
  })

  test('a cancelled turn still returns what it managed to write', async () => {
    const agentId = addAgent('프리렌')
    turnBehaviour = (input, db) => {
      replies({ agentId, content: 'half a thought' })(input, db)
      // `completed: false` with no error is an interrupt, not a failure.
      return { completed: false }
    }

    const body = (await (
      await post('/mcp-tools/chat', { agent_name: '프리렌', message: 'hi' })
    ).json()) as ChatResponse
    expect(body.response).toBe('half a thought')
  })
})

// ---------------------------------------------------------------------------
// The 404 body
// ---------------------------------------------------------------------------

describe('unknown agent names', () => {
  test('the 404 carries a Python list repr of the first ten names', async () => {
    addAgent('프리렌')

    const response = await post('/mcp-tools/chat', { agent_name: 'nobody', message: 'hi' })
    expect(response.status).toBe(404)

    // Byte-for-byte what Python's f-string produces: `str()` of a list of
    // `str`, so brackets, single quotes, `, ` separators — and non-ASCII
    // printed literally, as Python 3's repr does.
    expect(((await response.json()) as { detail: string }).detail).toBe(
      "Agent 'nobody' not found. Available: ['Onboarding_Manager', 'Action_Manager', " +
        "'Narrator', 'Chat_Summarizer', '프리렌']",
    )
  })

  test('the list stops at ten names', async () => {
    for (let i = 0; i < 20; i++) addAgent(`Extra_${i}`)

    const response = await post('/mcp-tools/chat', { agent_name: 'nobody', message: 'hi' })
    const { detail } = (await response.json()) as { detail: string }

    // Four fixture agents plus six of the twenty added, and nothing after.
    expect(detail).toBe(
      "Agent 'nobody' not found. Available: ['Onboarding_Manager', 'Action_Manager', " +
        "'Narrator', 'Chat_Summarizer', 'Extra_0', 'Extra_1', 'Extra_2', 'Extra_3', " +
        "'Extra_4', 'Extra_5']",
    )
  })

  test("a name containing a quote flips repr to double quotes", async () => {
    harness.db.$client.exec('DELETE FROM agents')
    addAgent("D'Artagnan")

    const response = await post('/mcp-tools/chat', { agent_name: 'nobody', message: 'hi' })
    const { detail } = (await response.json()) as { detail: string }
    expect(detail).toBe(`Agent 'nobody' not found. Available: ["D'Artagnan"]`)
  })

  test('the conversation 404 has no "Available" half', async () => {
    // Python's two 404 strings genuinely differ; the shorter one is reproduced
    // rather than tidied to match its neighbour.
    const response = await get('/mcp-tools/conversation/nobody')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { detail: string }).detail).toBe("Agent 'nobody' not found")
  })
})

// ---------------------------------------------------------------------------
// GET /mcp-tools/conversation/{agent_name}
// ---------------------------------------------------------------------------

describe('GET /mcp-tools/conversation/{agent_name}', () => {
  test('returns the newest messages oldest-first, with a sender per line', async () => {
    const agentId = addAgent('프리렌')
    turnBehaviour = replies({ agentId, content: '오랜만이야.', thinking: 'hmm' })
    await post('/mcp-tools/chat', { agent_name: '프리렌', message: '안녕!' })

    const lines = (await (
      await get('/mcp-tools/conversation/프리렌')
    ).json()) as ConversationMessage[]

    expect(lines).toEqual([
      { role: 'user', sender: 'Tester', content: '안녕!', thinking: null },
      { role: 'assistant', sender: '프리렌', content: '오랜만이야.', thinking: 'hmm' },
    ])
  })

  test('limit selects the newest N, defaulting to 20', async () => {
    const agentId = addAgent('프리렌')
    turnBehaviour = replies({ agentId, content: 'reply' })
    for (let i = 0; i < 15; i++) {
      await post('/mcp-tools/chat', { agent_name: '프리렌', message: `turn ${i}` })
    }

    const all = (await (
      await get('/mcp-tools/conversation/프리렌')
    ).json()) as ConversationMessage[]
    // 30 messages written, 20 returned by default.
    expect(all).toHaveLength(20)

    const three = (await (
      await get('/mcp-tools/conversation/프리렌?limit=3')
    ).json()) as ConversationMessage[]
    expect(three).toHaveLength(3)
    // Newest three, still in chronological order.
    expect(three.map((m) => m.content)).toEqual(['reply', 'turn 14', 'reply'])
  })

  test('an agent that has never been talked to has an empty transcript', async () => {
    addAgent('프리렌')
    const response = await get('/mcp-tools/conversation/프리렌')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  test('a partial name resolves here too', async () => {
    addAgent('Dr. Chen')
    expect((await get('/mcp-tools/conversation/chen')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// POST /mcp-tools/room
// ---------------------------------------------------------------------------

describe('POST /mcp-tools/room', () => {
  test('creates the room and reports which names resolved', async () => {
    addAgent('프리렌')
    addAgent('Dr. Chen')

    const response = await post('/mcp-tools/room', {
      name: 'Book Club',
      agent_names: ['프리렌', 'chen', 'nobody'],
    })
    expect(response.status).toBe(200)

    const body = (await response.json()) as RoomCreated
    expect(body.room_name).toBe('Book Club')
    // Real names, not the requested spellings: a substring match resolved one.
    expect(body.agents_added).toEqual(['프리렌', 'Dr. Chen'])
    expect(body.agents_not_found).toEqual(['nobody'])

    const room = getRoom(harness.db, body.room_id)
    expect(room?.ownerId).toBe('admin')
    expect(room?.worldId).toBeNull()
    expect(getAgentsInRoom(harness.db, body.room_id).map((a) => a.name).sort()).toEqual([
      'Dr. Chen',
      '프리렌',
    ])
  })

  test('a room whose every name is unknown is still created', async () => {
    const body = (await (
      await post('/mcp-tools/room', { name: 'Empty', agent_names: ['who', 'what'] })
    ).json()) as RoomCreated

    expect(body.agents_added).toEqual([])
    expect(body.agents_not_found).toEqual(['who', 'what'])
    expect(getRoom(harness.db, body.room_id)?.name).toBe('Empty')
  })
})

// ---------------------------------------------------------------------------
// POST /mcp-tools/room/message
// ---------------------------------------------------------------------------

describe('POST /mcp-tools/room/message', () => {
  async function bookClub(): Promise<{ roomId: number; frieren: number; chen: number }> {
    const frieren = addAgent('프리렌')
    const chen = addAgent('Dr. Chen')
    const created = (await (
      await post('/mcp-tools/room', { name: 'Book Club', agent_names: ['프리렌', 'Dr. Chen'] })
    ).json()) as RoomCreated
    return { roomId: created.room_id, frieren, chen }
  }

  test('answers with every agent that spoke, in the order they spoke', async () => {
    const { roomId, frieren, chen } = await bookClub()
    turnBehaviour = replies(
      { agentId: frieren, content: '음.', thinking: '지루해' },
      { agentId: chen, content: 'Fascinating.' },
    )

    const response = await post('/mcp-tools/room/message', { room_id: roomId, message: 'hello' })
    expect(response.status).toBe(200)

    expect(await response.json()).toEqual([
      { agent_name: '프리렌', response: '음.', thinking: '지루해', room_id: roomId },
      { agent_name: 'Dr. Chen', response: 'Fascinating.', thinking: null, room_id: roomId },
    ])
  })

  test('lets the whole room respond', async () => {
    const { roomId } = await bookClub()
    await post('/mcp-tools/room/message', { room_id: roomId, message: 'hello' })

    // Python passes every room agent; null is this backend's spelling of that.
    expect(turnCalls.at(-1)?.mentionedAgentIds).toBeNull()
  })

  test('a room where nobody speaks answers with an empty list', async () => {
    const { roomId } = await bookClub()
    expect(
      await (await post('/mcp-tools/room/message', { room_id: roomId, message: 'hi' })).json(),
    ).toEqual([])
  })

  test('system notices are not replies', async () => {
    const { roomId, frieren } = await bookClub()
    turnBehaviour = (input, db) => {
      // No `agentId`: the "X joined the chat" shape. It is in the room and
      // newer than the trigger, and it is still not something an agent said.
      createMessage(db, input.roomId, {
        content: 'Someone joined the chat',
        role: 'user',
        participantType: 'system',
        participantName: 'System',
      })
      return replies({ agentId: frieren, content: 'the only reply' })(input, db)
    }

    const body = (await (
      await post('/mcp-tools/room/message', { room_id: roomId, message: 'hi' })
    ).json()) as ChatResponse[]
    expect(body).toHaveLength(1)
    expect(body[0]?.response).toBe('the only reply')
  })

  test('404s an unknown room', async () => {
    const response = await post('/mcp-tools/room/message', { room_id: 9999, message: 'hi' })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { detail: string }).detail).toBe('Room 9999 not found')
  })

  test('accepts a stringified room_id, as Pydantic always has', async () => {
    const { roomId } = await bookClub()
    const response = await post('/mcp-tools/room/message', {
      room_id: String(roomId),
      message: 'hi',
    })
    expect(response.status).toBe(200)
  })

  test('422s a room_id that is not an integer', async () => {
    const response = await post('/mcp-tools/room/message', { room_id: 1.5, message: 'hi' })
    expect(response.status).toBe(422)
  })

  test('422s a missing message', async () => {
    expect((await post('/mcp-tools/chat', { agent_name: 'x' })).status).toBe(422)
    expect((await post('/mcp-tools/room', { name: 'x' })).status).toBe(422)
  })
})
