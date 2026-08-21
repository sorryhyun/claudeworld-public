import type { CallToolResult } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import type { Db } from '../../db'

/**
 * One tool: a declaration and the function behind it.
 *
 * This used to be `ReturnType<typeof tool<any>>` — the Agent SDK's `tool()`
 * helper, which is a plain data constructor and nothing more. It was dropped
 * when the game moved off the SDK's in-process MCP transport, because it is the
 * *only* thing that pulled `@modelcontextprotocol/sdk` v1 into this backend:
 * `tool()` types its handler against v1's `CallToolResult`, and v1's and v2's
 * differ on `structuredContent`, so nothing that went through it could be
 * registered on an MCP v2 server without a cast.
 *
 * {@link tool} below keeps the same call signature, so the tool factories read
 * exactly as they did.
 */
export interface GameTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  /** Zod raw shape, wrapped with `z.object()` at registration. */
  inputSchema: Shape
  /**
   * Passed through to the tool's `tools/list` entry.
   *
   * The key worth knowing about is `anthropic/maxResultSizeChars`: Claude Code
   * persists any result over ~50,000 characters to a file and hands the model a
   * preview plus a path, which is a total loss for these agents — they have no
   * file tools to resolve the path with.
   */
  _meta?: Record<string, unknown>
  handler: (args: z.infer<z.ZodObject<Shape>>, extra: unknown) => Promise<CallToolResult>
}

/**
 * Some tool, with its argument shape erased.
 *
 * A factory returning several tools cannot name one shape, so this is the
 * honest spelling of "some tool" — and it keeps the `any` in one place rather
 * than in a cast at every return site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkTool = GameTool<any>

/** Declare a tool. Same shape as the Agent SDK helper it replaces. */
export function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: GameTool<Shape>['handler'],
  extras?: { _meta?: Record<string, unknown> },
): GameTool<Shape> {
  return { name, description, inputSchema, handler, ...(extras?._meta ? { _meta: extras._meta } : {}) }
}

/**
 * What a tool handler is allowed to know about the turn it is running in.
 *
 * Port of `sdk/handlers/context.py`. Tools are in-process closures, so this is
 * captured once when the MCP servers for a turn are built and read from inside
 * every handler — that is how a `narration` call knows which room to write to.
 *
 * One deliberate divergence: `db` is a *getter*, not a handle. Python cached
 * built MCP servers under a hash that excluded the session, so a cached server
 * held a closure over a session that had since been closed. Resolving the
 * connection at call time removes the whole class of bug.
 */
export interface ToolContext {
  agentName: string
  agentId?: number
  /** Absolute path of the agent's config directory, e.g. `agents/group_x/Alice`. */
  configFile?: string
  groupName?: string
  roomId?: number
  worldName?: string
  worldId?: number
  /** Subtitle -> content, parsed from consolidated_memory.md. Backs `recall`. */
  longTermMemoryIndex: Record<string, string>
  /**
   * NPC reactions collected in cell 1, handed to the Action Manager in cell 2.
   *
   * Read by `narration` so it can store them in the message's `thinking` column.
   * It is per-turn state living on a per-turn context; Python let a cached MCP
   * server capture a stale copy of it.
   */
  npcReactions?: NpcReaction[]
  getDb: () => Db
}

export interface NpcReaction {
  agentId: number
  agentName: string
  content: string
}

/**
 * Accessors that fail loudly at server-build time rather than mid-turn.
 *
 * Python's `require_*` methods were called at the top of each tool factory for
 * this reason: a tool whose dependencies are absent should never be offered to
 * the model, because the model will call it and get an error it cannot act on.
 */
export function requireDb(ctx: ToolContext): Db {
  return ctx.getDb()
}

export function requireWorldId(ctx: ToolContext): number {
  if (ctx.worldId === undefined) throw new ToolContextError('worldId', ctx.agentName)
  return ctx.worldId
}

export function requireWorldName(ctx: ToolContext): string {
  if (!ctx.worldName) throw new ToolContextError('worldName', ctx.agentName)
  return ctx.worldName
}

export function requireRoomId(ctx: ToolContext): number {
  if (ctx.roomId === undefined) throw new ToolContextError('roomId', ctx.agentName)
  return ctx.roomId
}

export function requireAgentId(ctx: ToolContext): number {
  if (ctx.agentId === undefined) throw new ToolContextError('agentId', ctx.agentName)
  return ctx.agentId
}

export function requireConfigFile(ctx: ToolContext): string {
  if (!ctx.configFile) throw new ToolContextError('configFile', ctx.agentName)
  return ctx.configFile
}

export class ToolContextError extends Error {
  constructor(field: string, agentName: string) {
    super(`Tool context for "${agentName}" is missing ${field}`)
    this.name = 'ToolContextError'
  }
}

/** MCP success result. Port of `handlers/common.py::tool_success`. */
export function toolSuccess(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * MCP error result.
 *
 * Returned, not thrown: the model should see the failure as a tool result it can
 * react to, rather than having the turn collapse.
 */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
