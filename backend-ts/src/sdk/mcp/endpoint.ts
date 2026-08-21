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
  type ServerDeps,
  type ServerName,
} from '../handlers/servers'
import { createToolServer } from './adapter'
import type { TurnRegistry } from './turn-registry'

/**
 * The game's tools, served over MCP revision 2026-07-28.
 *
 * **Stateless.** No `initialize` handshake, no `mcp-session-id`, nothing kept
 * per client. A CLI probes `server/discover` and then sends every request
 * standalone, and `createMcpHandler` calls its factory *per request* — which is
 * the whole reason this migration was worth doing. The tools used to be
 * in-process closures baked into `query()` options, and `SessionPool` reuses a
 * warm session across turns, so those closures outlived the turn that built
 * them. Here the binding is looked up when the call lands.
 *
 * ## Its own listener, on loopback
 *
 * Deliberately not mounted on the public Hono app. That app binds `0.0.0.0` so
 * the frontend can reach it, and the game's tool surface — which writes to the
 * world, mutates player state and deletes characters — has no business being
 * reachable from the network. This binds `127.0.0.1` on an ephemeral port,
 * which also decouples it from `PORT` and lets `scripts/pilot-turn.ts` drive a
 * real turn with no HTTP application anywhere.
 *
 * ## Identity is the path
 *
 * `POST /:roomId/:agentId/:server`. The pair names a {@link TurnRegistry}
 * binding — this turn's `ToolContext`, its role, and the shared `PlayerFacade`
 * that a `change_stat` and a `persist_item` in the same turn must agree on.
 * Transport auth is one process-wide bearer token; there is no privilege tier
 * *between* agents to defend, unlike yaar's session principal, so the pair is
 * carried in the clear rather than behind per-agent tokens.
 *
 * ## One protocol era
 *
 * `legacy: 'reject'`. There is no 2025-era leg beneath this, so a CLI that
 * fails to negotiate up loses every tool at once rather than falling back —
 * {@link refuseLegacyEra} says so, and names both env gates, because "could not
 * negotiate" and "sent a malformed request" are otherwise the same JSON-RPC
 * error code and only one of them is fixed by touching `sdk/client/env.ts`.
 */

const logger = getLogger('McpEndpoint')

export interface McpEndpoint {
  /** e.g. `http://127.0.0.1:47823`. */
  origin: string
  /** Bearer token the spawned CLI must present. Regenerated per process. */
  token: string
  /** The URL one agent's CLI should be pointed at for one namespace. */
  urlFor(key: SessionKey, server: ServerName): string
  stop(): void
}

export interface StartMcpEndpointOptions {
  /** Fixed port, for a test that wants a predictable URL. Defaults to ephemeral. */
  port?: number
}

export function startMcpEndpoint(
  deps: ServerDeps,
  registry: TurnRegistry,
  options: StartMcpEndpointOptions = {},
): McpEndpoint {
  const token = crypto.randomUUID()
  const handlers = new Map<ServerName, McpHttpHandler>()

  /**
   * Build the server for one namespace from whatever binding is current.
   *
   * Called by `createMcpHandler` once per request. The route is re-derived from
   * `requestInfo` rather than closed over, which is what lets one handler per
   * namespace serve every (room, agent) — a handler owns an event bus and an
   * SSE keep-alive router, so building one per request would leak both.
   */
  const factory = (serverName: ServerName) => (ctx: { requestInfo?: Request }): McpServer => {
    const route = ctx.requestInfo ? parseRoute(new URL(ctx.requestInfo.url).pathname) : null
    const binding = route ? registry.get(route) : undefined
    if (!binding) {
      // Reached only if the request passed the pre-flight lookup below and the
      // binding was evicted in between — a turn cancelled mid-call. An empty
      // server answers `tools/list` with nothing rather than throwing, which is
      // the shape a model can act on.
      logger.warning(`No binding for ${ctx.requestInfo?.url ?? 'an unidentified request'}`)
      return createToolServer(serverName, [])
    }
    return createToolServer(serverName, buildToolSets(binding, deps)[serverName] ?? [])
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

/** `/12/7/action_manager` -> `{ roomId: 12, agentId: 7, server: 'action_manager' }`. */
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
  // DNS-rebinding protection. `createMcpHandler` is deliberately
  // validation-free and documents this as the mounting caller's job.
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
  // leg — a 2026-07-28 connection has none by construction. Checked before the
  // body is read because it is the cheap half of the classification.
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

  // Handing the classifier the body we already parsed matters: given
  // `parsedBody` it inspects that instead of re-reading the request, so the
  // stream is consumed once and the same object is passed on to the handler.
  if (await isLegacyRequest(request, body)) {
    return refuseLegacyEra(route.server, clientLabelFrom(body))
  }

  if (!registry.get(route)) {
    // A tool call for an agent with no current turn. Distinct from 404: the
    // route is well-formed and the namespace exists, but nothing has bound it,
    // which means either the call raced an eviction or a session outlived the
    // turn that opened it.
    logger.warning(`No turn binding for room ${route.roomId}, agent ${route.agentId}`)
    return jsonRpcError(409, -32001, 'No turn is bound for this agent')
  }

  return handlerFor(route.server).fetch(request, { parsedBody: body })
}

/**
 * Refuse a client speaking the retired 2025-era protocol.
 *
 * Deliberately chatty, and logged at error level every time rather than once
 * per process: the request was *not served*, so there is no quiet-but-working
 * state for a rate limit to protect, and the two env gates named here are
 * undocumented internals of a CLI this repository does not pin. If this line
 * starts appearing after an `@anthropic-ai/claude-agent-sdk` bump, that is the
 * first place to look — not the tool call that appears to have failed.
 */
function refuseLegacyEra(server: ServerName, clientLabel: string): Response {
  const message =
    'This MCP endpoint serves revision 2026-07-28 only; there is no 2025-era leg. The ' +
    'client did not negotiate up — a stale CLI, or an opt-in gate that was renamed or ' +
    'withdrawn (MCP_SDK_GENERATION=v2 + MCP_PROTOCOL_NEGOTIATION=auto, set in ' +
    'sdk/client/env.ts).'
  logger.error(`Refused legacy protocol era | client: ${clientLabel} | server: ${server}`)
  return jsonRpcError(400, -32600, message)
}

/** Best-effort client name from an `initialize` body, for the refusal above. */
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
