import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import type { Db } from '@/db'

// Deliberately not the Agent SDK's `tool()` helper: it types its handler against
// v1 of `@modelcontextprotocol/sdk`, which cannot be registered on an v2 server.
export interface GameTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  /** Raw shape; wrapped with `z.object()` at registration. */
  inputSchema: Shape
  /**
   * Hints for `tools/list`. Claude Code reads `readOnlyHint` as
   * `isConcurrencySafe()`, so an unannotated tool always runs alone; it is
   * stamped in `servers.ts`, never at the `tool()` call.
   */
  annotations?: ToolAnnotations
  /**
   * Passed through to `tools/list`. `anthropic/maxResultSizeChars` matters: a
   * result over ~50,000 characters is spilled to a file and the model gets only
   * a path, useless to agents with no file tools.
   */
  _meta?: Record<string, unknown>
  handler: (args: z.infer<z.ZodObject<Shape>>, extra: unknown) => Promise<CallToolResult>
}

// A factory returning several tools cannot name one shape; the `any` lives here
// rather than at every return site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkTool = GameTool<any>

export function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: GameTool<Shape>['handler'],
  extras?: { _meta?: Record<string, unknown>; annotations?: ToolAnnotations },
): GameTool<Shape> {
  return {
    name,
    description,
    inputSchema,
    handler,
    ...(extras?._meta ? { _meta: extras._meta } : {}),
    ...(extras?.annotations ? { annotations: extras.annotations } : {}),
  }
}

// Captured once when the turn's MCP servers are built. `db` is a *getter*:
// resolving at call time keeps a cached server off a closed connection.
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
   * What the NPCs said this turn. `narration` stores them in the `thinking`
   * column. Empty at the start of a gameplay turn — the NPCs are still running —
   * and filled in by {@link awaitNpcReactions}, so a `narration` written before
   * that records only what was actually known when it was written.
   */
  npcReactions?: NpcReaction[]
  /**
   * Waits for the NPCs running *alongside* this turn and folds what they said
   * into {@link npcReactions}, which is the same array on every call. Absent
   * when nothing is in flight — an empty location, or an agent that is not the
   * Action Manager.
   */
  awaitNpcReactions?: () => Promise<NpcReaction[]>
  getDb: () => Db
}

export interface NpcReaction {
  agentId: number
  agentName: string
  content: string
}

// Called at the top of each tool factory, so a tool with absent dependencies is
// never offered to a model that would only get an unusable error.
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

export function toolSuccess(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

// Returned, not thrown: the model should see a tool result it can react to.
export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
