import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { SdkTool } from '../handlers/context'

/**
 * The seam between the `GameTool` shape the handlers under `sdk/handlers/`
 * declare and `McpServer`. One conversion happens here: `inputSchema` is a Zod
 * *raw shape*, and `registerTool`'s supported form takes a Standard Schema, so
 * the shape is wrapped with `z.object()`.
 */

const SERVER_VERSION = '1.0.0'

// `instructions` reaches the model through `server/discover` — `initialize`
// never runs, the endpoint being stateless — and is passed per call because the
// caller is what knows the namespace.
export function createToolServer(
  name: string,
  tools: SdkTool[],
  instructions?: string,
): McpServer {
  const server = new McpServer(
    { name, version: SERVER_VERSION },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  )
  for (const definition of tools) registerSdkTool(server, definition)
  return server
}

export function registerSdkTool(server: McpServer, definition: SdkTool): void {
  server.registerTool(
    definition.name,
    {
      description: definition.description,
      inputSchema: z.object(definition.inputSchema),
      ...(definition.annotations ? { annotations: definition.annotations } : {}),
      ...(definition._meta ? { _meta: definition._meta } : {}),
    },
    (args, extra) => definition.handler(args, extra),
  )
}
