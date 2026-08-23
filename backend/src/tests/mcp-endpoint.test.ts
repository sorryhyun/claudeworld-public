/**
 * The stateless MCP endpoint, exercised by a real MCP v2 client.
 *
 * The test that matters is `serves the binding that is current, not the one the
 * connection opened with`. That is the whole reason for the migration: the
 * tools used to be in-process closures baked into `query()` options, and
 * `SessionPool` reuses a warm session across turns — so those closures outlived
 * their turn and the CLI went on calling turn 1's context forever. Everything
 * else here guards the refusals that make a misconfiguration diagnosable.
 *
 * `recall` is the probe because it is the one dependency-free tool whose
 * *output* comes straight off the `ToolContext`: same name, same schema, and a
 * body that is whatever `longTermMemoryIndex` currently says.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'

import { McpTools } from '@/sdk/mcp'
import type { ToolContext } from '@/sdk/handlers/context'
import type { ServerDeps } from '@/sdk/handlers/servers'
import { PlayerService } from '@/services/player-service'
import { LocationStorage } from '@/services/location-storage'
import { RoomMappingService } from '@/services/room-mapping'

const ROOM = 12
const AGENT = 7
const SUBTITLE = 'the_fire'

const WORLDS_DIR = '/nonexistent-worlds-dir'

const deps: ServerDeps = {
  players: new PlayerService(WORLDS_DIR),
  rooms: new RoomMappingService(WORLDS_DIR),
  locations: new LocationStorage(WORLDS_DIR),
}

/**
 * A context with no world and no database.
 *
 * Deliberate: with `worldId` undefined the binding builds no `PlayerFacade`, so
 * nothing here touches SQLite or the repository's `worlds/`. The `action`
 * namespace this test drives needs neither.
 */
function ctxFor(agentName: string, memory: string): ToolContext {
  return {
    agentName,
    agentId: AGENT,
    configFile: `worlds/testworld/agents/${agentName}`,
    roomId: ROOM,
    longTermMemoryIndex: { [SUBTITLE]: memory },
    getDb: () => {
      throw new Error('this context has no database')
    },
  }
}

let mcp: McpTools
let origin: string
let token: string

function bind(agentName: string, memory: string): void {
  const bound = mcp.bindTurn({ roomId: ROOM, agentId: AGENT }, ctxFor(agentName, memory), {
    role: 'character',
    configDir: `/tmp/agents/${agentName}`,
  })
  // Sanity: the allow-list the SDK options would carry, from the same call the
  // endpoint serves from.
  expect(bound.toolNames).toContain('mcp__action__recall')
}

beforeAll(() => {
  mcp = new McpTools(deps)
  origin = mcp.origin
  // Reaching for the token through the options the binder produces, rather than
  // through the endpoint, so the test authenticates exactly the way a spawned
  // CLI does.
  const bound = mcp.bindTurn({ roomId: ROOM, agentId: AGENT }, ctxFor('Alice', 'x'), {
    role: 'character',
    configDir: '/tmp/agents/Alice',
  }).mcpServers.action as { url: string; headers?: Record<string, string> }
  token = (bound.headers?.Authorization ?? '').replace('Bearer ', '')
  expect(token).not.toBe('')
  expect(bound.url).toBe(`${origin}/${ROOM}/${AGENT}/action`)
})

afterAll(() => {
  mcp.stop()
})

async function connect(path = `${ROOM}/${AGENT}/action`): Promise<Client> {
  const client = new Client(
    { name: 'mcp-endpoint-test', version: '1.0.0' },
    // Pinned rather than 'auto': a fallback to the 2025 handshake would be
    // served as a refusal by this endpoint, and pinning makes that failure land
    // here instead of looking like a broken tool call.
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/${path}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

/**
 * A hand-rolled 2026-07-28 `tools/list`.
 *
 * The envelope is the whole point: without the `_meta` protocol-version key the
 * request classifies as 2025-era and is refused before the binding is ever
 * looked up — which is correct, and is why the two "no binding" cases below
 * cannot be written with a bare JSON-RPC body.
 */
function modernListTools(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } },
    }),
  })
}

function textOf(result: { content: unknown }): string {
  return (result.content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

describe('MCP endpoint', () => {
  test('serves the action namespace over revision 2026-07-28', async () => {
    bind('Alice', 'The granary burned.')
    const client = await connect()
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(['memorize', 'recall', 'skip'])
    } finally {
      await client.close()
    }
  })

  test('serves the binding that is current, not the one the connection opened with', async () => {
    bind('Alice', 'The granary burned.')
    const client = await connect()
    try {
      const first = await client.callTool({ name: 'recall', arguments: { subtitle: SUBTITLE } })
      expect(textOf(first)).toContain('The granary burned.')

      // The turn ends and the next one binds a different context — exactly what
      // `turn.ts` does — while this connection stays open, as a warm session's
      // does. Under the in-process servers this replaced, the second call would
      // still have answered with the granary.
      bind('Bram', 'The toll house took his cart.')

      const second = await client.callTool({ name: 'recall', arguments: { subtitle: SUBTITLE } })
      expect(textOf(second)).toContain('The toll house took his cart.')
      expect(textOf(second)).not.toContain('The granary burned.')
    } finally {
      await client.close()
    }
  })

  test('rejects a request with no bearer token', async () => {
    const response = await fetch(`${origin}/${ROOM}/${AGENT}/action`, { method: 'POST' })
    expect(response.status).toBe(401)
  })

  test('rejects a request with the wrong bearer token', async () => {
    const response = await fetch(`${origin}/${ROOM}/${AGENT}/action`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-the-token' },
    })
    expect(response.status).toBe(401)
  })

  test('404s a namespace this backend does not serve', async () => {
    const response = await fetch(`${origin}/${ROOM}/${AGENT}/not_a_server`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(404)
  })

  test('409s an agent with no bound turn', async () => {
    const response = await modernListTools(`${ROOM}/9999/action`)
    expect(response.status).toBe(409)
  })

  test('refuses a client holding a 2025-era session id', async () => {
    // Modern envelope, legacy header: the session id alone is disqualifying,
    // and it is checked before the body is even read.
    const response = await modernListTools(`${ROOM}/${AGENT}/action`, {
      'Mcp-Session-Id': 'a-2025-era-session',
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toContain('2026-07-28')
  })

  test('refuses a client that opens with the 2025-era handshake', async () => {
    const response = await fetch(`${origin}/${ROOM}/${AGENT}/action`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'stale-cli', version: '0.0.1' },
        },
      }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('MCP_SDK_GENERATION')
  })

  test('carries the namespace instructions on server/discover', async () => {
    // Not decoration: Claude Code collects every connected server's
    // `instructions` into one block of the model's context. On this revision
    // there is no `initialize`, so `server/discover` is the only carrier —
    // which is why the endpoint supplies them on the no-binding path too.
    bind('Alice', 'The granary burned.')
    const client = await connect()
    try {
      const instructions = client.getInstructions()
      expect(instructions).toBeDefined()
      expect(instructions).toContain('recall')
    } finally {
      await client.close()
    }
  })

  test('marks the read-only tools and only those', async () => {
    // `readOnlyHint` is what the CLI reads as `isConcurrencySafe()`, so an
    // unannotated `recall` is a `recall` executed on its own. `memorize` and
    // `skip` must stay unannotated — the first writes `recent_events.md`, and
    // claiming otherwise would licence running it concurrently with anything.
    bind('Alice', 'The granary burned.')
    const client = await connect()
    try {
      const { tools } = await client.listTools()
      const hints = Object.fromEntries(
        tools.map((t) => [t.name, t.annotations?.readOnlyHint]),
      )
      expect(hints).toEqual({ recall: true, memorize: undefined, skip: undefined })
    } finally {
      await client.close()
    }
  })

  test('a released binding stops being served', async () => {
    // What `SessionPool.evict` fires. A session and its binding die together,
    // or the endpoint would keep answering for an agent with no subprocess.
    bind('Alice', 'The granary burned.')
    mcp.release(`room_${ROOM}_agent_${AGENT}`)
    expect((await modernListTools(`${ROOM}/${AGENT}/action`)).status).toBe(409)
  })
})
