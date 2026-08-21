import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

import type { SessionKey } from '../client/session'
import type { ToolContext } from '../handlers/context'
import {
  buildToolSets,
  createTurnBinding,
  qualifiedToolNames,
  type BuildServersOptions,
  type ServerDeps,
} from '../handlers/servers'
import { startMcpEndpoint, type McpEndpoint, type StartMcpEndpointOptions } from './endpoint'
import { TurnRegistry } from './turn-registry'

export { startMcpEndpoint, type McpEndpoint } from './endpoint'
export { TurnRegistry } from './turn-registry'

/**
 * The game's MCP surface, as one thing to own.
 *
 * Three pieces that are useless apart — the loopback listener, the binding
 * registry it reads, and the tool-set builder both it and the caller derive
 * from — behind the two calls anything outside `sdk/` actually makes:
 * {@link McpTools.bindTurn} before a turn, and {@link McpTools.release} when a
 * session is evicted.
 *
 * Constructed once per backend (`http/state.ts`) and once per headless driver
 * (`scripts/pilot-turn.ts`). Nothing else should reach past it into
 * `endpoint.ts` or `turn-registry.ts`.
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
   * Make this turn's context current, and describe the tools it implies.
   *
   * Replaces the per-turn `buildServers` call. The two halves of the return
   * value come from one `buildToolSets`, and the endpoint calls the same
   * function again per request — so the allow-list here and the `tools/list`
   * the model actually sees cannot disagree.
   *
   * Must be called *before* the session is acquired: `alwaysLoad` makes the CLI
   * block on connecting these servers at startup, and a `tools/list` that
   * arrived before the binding existed would hand the agent an empty namespace
   * for the life of the session.
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
        // These are the agent's entire toolbox — a text-adventure character has
        // no file or shell tools to fall back on — so they must be in the
        // prompt from turn one rather than deferred behind tool search.
        alwaysLoad: true,
      }
    }

    return { mcpServers, toolNames: qualifiedToolNames(sets) }
  }

  /** Drop a binding. Wired to `SessionPool`'s eviction; see its `onEvict`. */
  readonly release = (id: string): void => {
    this.registry.release(id)
  }

  stop(): void {
    this.registry.clear()
    this.endpoint.stop()
  }
}
