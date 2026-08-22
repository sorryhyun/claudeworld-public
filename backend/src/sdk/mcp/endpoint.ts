import {
  createMcpHandler,
  isLegacyRequest,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  hostHeaderValidationResponse,
  originValidationResponse,
  type McpHttpHandler,
  type McpServer,
} from '@modelcontextprotocol/server'

import { getLogger } from '../../infrastructure/logging/logger'
import type { SessionKey } from '../client/session'
import {
  buildToolSets,
  isServerName,
  SERVER_INSTRUCTIONS,
  type ServerDeps,
  type ServerName,
} from '../handlers/servers'
import { createToolServer } from './adapter'
import type { TurnRegistry } from './turn-registry'

/**
 * The game's tools, served over MCP revision 2026-07-28.
 *
 * **Stateless**: `createMcpHandler` calls its factory *per request*, so the turn
 * binding is looked up when the call lands rather than closed over —
 * `SessionPool` reuses a warm session across turns, and an in-process closure
 * would outlive the turn that built it.
 *
 * **Its own loopback listener**, deliberately not on the public Hono app, which
 * binds `0.0.0.0`: this tool surface writes worlds and deletes characters. The
 * ephemeral port also lets `scripts/pilot-turn.ts` run with no HTTP app at all.
 *
 * **Identity is the path**, `POST /:roomId/:agentId/:server`, naming a
 * {@link TurnRegistry} binding; auth is one process-wide bearer token.
 * **`legacy: 'reject'`** — no 2025-era leg, so a CLI that fails to negotiate up
 * loses every tool at once. See {@link refuseLegacyEra}.
 */

const logger = getLogger('McpEndpoint')

export interface McpEndpoint {
  origin: string
  /** Bearer token the spawned CLI must present. Regenerated per process. */
  token: string
  urlFor(key: SessionKey, server: ServerName): string
  stop(): void
}

export interface StartMcpEndpointOptions {
  port?: number
}

export function startMcpEndpoint(
  deps: ServerDeps,
  registry: TurnRegistry,
  options: StartMcpEndpointOptions = {},
): McpEndpoint {
  const token = crypto.randomUUID()
  const handlers = new Map<ServerName, McpHttpHandler>()

  // Called once per request; the route is re-derived from `requestInfo` so one
  // handler per namespace serves every (room, agent). A handler owns an event
  // bus and an SSE keep-alive router, so one per request would leak both.
  const factory = (serverName: ServerName) => (ctx: { requestInfo?: Request }): McpServer => {
    // Supplied even on the no-binding path: `server/discover` is its own
    // request, and answering it bare costs the model the block for good.
    const instructions = SERVER_INSTRUCTIONS[serverName]
    const route = ctx.requestInfo ? parseRoute(new URL(ctx.requestInfo.url).pathname) : null
    const binding = route ? registry.get(route) : undefined
    if (!binding) {
      // Only reachable when the binding was evicted between the pre-flight
      // lookup below and here; an empty server beats throwing.
      logger.warning(`No binding for ${ctx.requestInfo?.url ?? 'an unidentified request'}`)
      return createToolServer(serverName, [], instructions)
    }
    return createToolServer(serverName, buildToolSets(binding, deps)[serverName] ?? [], instructions)
  }

  const handlerFor = (serverName: ServerName): McpHttpHandler => {
    let handler = handlers.get(serverName)
    if (!handler) {
      handler = createMcpHandler(factory(serverName), { legacy: 'reject' })
      handlers.set(serverName, handler)
    }
    return handler
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    fetch: (request) => serve(request, token, registry, handlerFor),
  })

  const origin = `http://127.0.0.1:${server.port}`
  logger.info(`🔌 MCP endpoint listening on ${origin} (revision 2026-07-28, stateless)`)

  return {
    origin,
    token,
    urlFor: (key, serverName) => `${origin}/${key.roomId}/${key.agentId}/${serverName}`,
    stop: () => {
      server.stop(true)
      logger.info('🔌 MCP endpoint stopped')
    },
  }
}

interface Route extends SessionKey {
  server: ServerName
}

function parseRoute(pathname: string): Route | null {
  const match = /^\/(\d+)\/(\d+)\/([a-z_]+)\/?$/.exec(pathname)
  if (!match) return null
  const server = match[3]!
  if (!isServerName(server)) return null
  return { roomId: Number(match[1]), agentId: Number(match[2]), server }
}

async function serve(
  request: Request,
  token: string,
  registry: TurnRegistry,
  handlerFor: (server: ServerName) => McpHttpHandler,
): Promise<Response> {
  // DNS-rebinding protection: `createMcpHandler` documents this as the
  // mounting caller's job.
  const rejected =
    hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
    originValidationResponse(request, localhostAllowedOrigins())
  if (rejected) return rejected

  if (request.headers.get('authorization') !== `Bearer ${token}`) {
    logger.warning('Rejected an MCP request with a missing or invalid bearer token')
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const route = parseRoute(new URL(request.url).pathname)
  if (!route) return Response.json({ error: 'Not Found' }, { status: 404 })

  // A session id can only come from a client that handshook on the 2025-era
  // leg. Checked before the body is read: it is the cheap half.
  if (request.headers.get('mcp-session-id')) {
    return refuseLegacyEra(route.server, 'a client holding an mcp-session-id')
  }

  if (request.method !== 'POST') {
    return jsonRpcError(405, -32000, 'Method not allowed')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonRpcError(400, -32700, 'Parse error')
  }

  // Passing the already-parsed body keeps the request stream consumed once.
  if (await isLegacyRequest(request, body)) {
    return refuseLegacyEra(route.server, clientLabelFrom(body))
  }

  if (!registry.get(route)) {
    // Distinct from 404: the route is well-formed, but nothing bound it — the
    // call raced an eviction, or a session outlived the turn that opened it.
    logger.warning(`No turn binding for room ${route.roomId}, agent ${route.agentId}`)
    return jsonRpcError(409, -32001, 'No turn is bound for this agent')
  }

  return handlerFor(route.server).fetch(request, { parsedBody: body })
}

// Logged at error level every time on purpose: the request was *not served*. If
// this starts appearing after an SDK bump, look here first, not at the tool call
// that appears to have failed.
function refuseLegacyEra(server: ServerName, clientLabel: string): Response {
  const message =
    'This MCP endpoint serves revision 2026-07-28 only; there is no 2025-era leg. The ' +
    'client did not negotiate up — a stale CLI, or an opt-in gate that was renamed or ' +
    'withdrawn (MCP_SDK_GENERATION=v2 + MCP_PROTOCOL_NEGOTIATION=auto, set in ' +
    'sdk/client/env.ts).'
  logger.error(`Refused legacy protocol era | client: ${clientLabel} | server: ${server}`)
  return jsonRpcError(400, -32600, message)
}

function clientLabelFrom(body: unknown): string {
  for (const message of Array.isArray(body) ? body : [body]) {
    const info = (message as { params?: { clientInfo?: { name?: unknown; version?: unknown } } })
      ?.params?.clientInfo
    if (typeof info?.name === 'string') {
      return typeof info.version === 'string' ? `${info.name} ${info.version}` : info.name
    }
  }
  return 'an unidentified client'
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status })
}
