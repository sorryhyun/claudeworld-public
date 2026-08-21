import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { SdkTool } from '../handlers/context'

/**
 * Registers `tool()`-shaped declarations on an MCP v2 server.
 *
 * The handler factories under `sdk/handlers/` declare their tools as
 * `GameTool` — `{ name, description, inputSchema, handler }`, the same
 * shape the Agent SDK's `tool()` helper produced before it was dropped. This
 * module is the entire seam between that shape and `McpServer`.
 *
 * The one conversion that happens here is the schema: `inputSchema` is a Zod
 * *raw shape* (`{ field: z.string() }`), and `registerTool`'s supported form
 * takes a Standard Schema — its raw-shape overload is deprecated — so the shape
 * is wrapped with `z.object()` on the way in rather than left to the auto-wrap.
 *
 * The handler's second argument is `registerTool`'s request context, passed
 * through untouched. No ClaudeWorld handler reads it; it is forwarded rather
 * than dropped so one that starts to can.
 */

/** Name and version reported by `initialize` / `server/discover`. */
const SERVER_VERSION = '1.0.0'

export function createToolServer(name: string, tools: SdkTool[]): McpServer {
  const server = new McpServer({ name, version: SERVER_VERSION }, { capabilities: { tools: {} } })
  for (const definition of tools) registerSdkTool(server, definition)
  return server
}

export function registerSdkTool(server: McpServer, definition: SdkTool): void {
  server.registerTool(
    definition.name,
    {
      description: definition.description,
      inputSchema: z.object(definition.inputSchema),
      ...(definition._meta ? { _meta: definition._meta } : {}),
    },
    (args, extra) => definition.handler(args, extra),
  )
}
