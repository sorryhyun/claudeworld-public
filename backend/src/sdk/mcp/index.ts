import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

import type { SessionKey } from '@/sdk/client/session'
import type { ToolContext } from '@/sdk/handlers/context'
import {
  buildToolSets,
  createTurnBinding,
  qualifiedToolNames,
  type BuildServersOptions,
  type ServerDeps,
} from '@/sdk/handlers/servers'
import { startMcpEndpoint, type McpEndpoint, type StartMcpEndpointOptions } from './endpoint'
import { TurnRegistry } from './turn-registry'

export { startMcpEndpoint, type McpEndpoint } from './endpoint'
export { TurnRegistry } from './turn-registry'

/**
 * The game's MCP surface — loopback listener, binding registry and tool-set
 * builder. Nothing outside should reach into `endpoint.ts`/`turn-registry.ts`.
 */

export interface BoundTurn {
  /** `Options.mcpServers` — one HTTP entry per namespace with tools in it. */
  mcpServers: Record<string, McpServerConfig>
  /** `mcp__server__tool` names for `Options.tools` / `allowedTools`. */
  toolNames: string[]
}

export class McpTools {
  private readonly registry = new TurnRegistry()
  private readonly endpoint: McpEndpoint

  constructor(
    private readonly deps: ServerDeps,
    options: StartMcpEndpointOptions = {},
  ) {
    this.endpoint = startMcpEndpoint(deps, this.registry, options)
  }

  get origin(): string {
    return this.endpoint.origin
  }

  /**
   * Must be called *before* the session is acquired: `alwaysLoad` makes the CLI
   * connect these servers at startup, and a `tools/list` arriving before the
   * binding exists hands the agent an empty namespace for the whole session.
   */
  bindTurn(key: SessionKey, ctx: ToolContext, options: BuildServersOptions): BoundTurn {
    const binding = createTurnBinding(ctx, this.deps, options)
    this.registry.bind(key, binding)

    const sets = buildToolSets(binding, this.deps)
    const mcpServers: Record<string, McpServerConfig> = {}
    for (const name of Object.keys(sets)) {
      mcpServers[name] = {
        type: 'http',
        url: this.endpoint.urlFor(key, name as keyof typeof sets),
        headers: { Authorization: `Bearer ${this.endpoint.token}` },
        // The agent's entire toolbox — there is no file or shell tool to fall
        // back on — so it must be in the prompt from turn one.
        alwaysLoad: true,
      }
    }

    return { mcpServers, toolNames: qualifiedToolNames(sets) }
  }

  /** Wired to `SessionPool`'s eviction; see its `onEvict`. */
  readonly release = (id: string): void => {
    this.registry.release(id)
  }

  stop(): void {
    this.registry.clear()
    this.endpoint.stop()
  }
}
