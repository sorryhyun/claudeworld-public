import { createSdkMcpServer, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { AgentConfigService } from '../../services/agent-config-service'
import type { ItemService } from '../../services/item-service'
import type { LocationStorage } from '../../services/location-storage'
import type { PlayerService } from '../../services/player-service'
import type { RoomMappingService } from '../../services/room-mapping'
import type { WorldService } from '../../services/world-service'
import type { WorldResetService } from '../../services/world-reset-service'
import { getAgentToolConfig } from '../loaders/group-config'
import { qualifiedToolName } from '../tools/definitions'
import { createActionTools, type ActionDeps } from './action-tools'
import { createCharacterDesignTools } from './character-design-tools'
import { createCharacterTools, createPersistCharacterTool } from './character-tools'
import { createGuidelinesTools } from './guidelines-tools'
import { createHistoryTools } from './history-tools'
import { createItemTools } from './item-tools'
import { createLocationTools, createPersistLocationTool } from './location-tools'
import { createMechanicsTools } from './mechanics-tools'
import { createNarrativeTools, type NarrativeDeps } from './narrative-tools'
import { createOnboardingTools } from './onboarding-tools'
import { createWorldTools } from './world-tools'
import type { AgentFactory } from '../../services/agent-factory'
import type { AgentFilesystemService } from '../../services/agent-filesystem-service'
import { PersistenceManager } from '../../services/persistence-manager'
import { PlayerFacade } from '../../services/player-facade'
import type {
  LocationPersistenceFactory,
  PlayerMutationsFactory,
  PlayerMutationsPort,
  TurnStatusPort,
} from './ports'
import type { SdkTool, ToolContext } from './context'

/**
 * Assembles the in-process MCP servers for one agent's turn.
 * Port of `sdk/handlers/servers.py` + `sdk/client/mcp_registry.py`.
 *
 * Servers are built per turn, not cached. Python cached them under a hash that
 * deliberately excluded the DB session and the NPC reactions, so a cached server
 * closed over a session that had since been closed and over the *previous*
 * turn's reactions — the narration tool could file last turn's NPC responses
 * against this turn's message. Rebuilding is cheap (these are closures, not
 * connections) and removes the whole class of bug.
 *
 * ## Roles and servers
 *
 * | role | servers built |
 * |---|---|
 * | `character` | `guidelines`, `action` |
 * | `action_manager` | `guidelines`, `action_manager`, `subagents` |
 * | `onboarding` | `guidelines`, `onboarding`, `subagents` |
 * | `subagent` | `guidelines`, `subagents` |
 * | `character_design` | `guidelines`, `character_design` |
 *
 * `guidelines` is unconditional — Python's `mcp_registry.py` builds it outside
 * the enabled-groups computation for every agent, including system ones.
 * `action` is denied to the Action Manager and the Onboarding Manager for the
 * reason Python discards the group for system agents: an agent that narrates
 * the scene has no `recent_events.md` of its own to write to.
 *
 * ## Optional dependencies are a gate, not a convenience
 *
 * Several tools need services that have no TypeScript port yet (see
 * `ports.ts`). Where a dependency is missing the tools that need it are simply
 * **not offered** — the same rule `narrative-tools.ts` follows for missing
 * context, and the same one `mcp_registry.py` follows when `db`/`world_id`/
 * `world_name` are absent. A tool the model can call and get nothing from is
 * worse than a tool it never sees.
 */

export const SERVER_NAMES = {
  action: 'action',
  actionManager: 'action_manager',
  guidelines: 'guidelines',
  onboarding: 'onboarding',
  subagents: 'subagents',
  characterDesign: 'character_design',
} as const

export type ServerName = (typeof SERVER_NAMES)[keyof typeof SERVER_NAMES]

/**
 * Which agent this turn is for.
 *
 * `'action_manager' | 'character'` were Phase 0's two; the other three widen
 * the enum rather than replacing it, so `turn.ts` keeps compiling unchanged.
 */
export type ServerRole =
  | 'action_manager'
  | 'character'
  | 'onboarding'
  | 'subagent'
  | 'character_design'

export interface BuiltServers {
  mcpServers: Record<string, McpServerConfig>
  /** Fully-qualified names for the options builder's `tools`/`allowedTools`. */
  toolNames: string[]
}

export interface ServerDeps {
  players: PlayerService
  rooms: RoomMappingService
  locations: LocationStorage
  /** World config, lore and compressed history. Gates `travel` and `recall_history`. */
  worlds?: WorldService
  /** Item templates. Gates `list_world_item`, `change_stat` and `persist_item`. */
  items?: ItemService
  /** `recent_events.md` writes. Defaults to a service on the settings project root. */
  agentConfigs?: AgentConfigService
  /** `_initial.json`. Gates nothing on its own; `complete` needs it. */
  reset?: WorldResetService
  /** World-scoped agent folders. Gates the character tools and the designers. */
  agentFiles?: AgentFilesystemService
  /** Mirrors an agent folder into an `agents` row. */
  agentFactory?: AgentFactory
  /**
   * Binds a {@link PlayerFacade} to one world — the filesystem-first stat,
   * inventory and clock mutations behind `change_stat` and `advance_time`.
   * Defaults to the real facade; tests pass their own.
   */
  mutations?: PlayerMutationsFactory
  /**
   * Binds a {@link PersistenceManager} to one world. Defaults to constructing
   * one on the settings `worlds/` root, which is what production wants; tests
   * pass their own so nothing touches the repository's `worlds/`.
   */
  persistence?: LocationPersistenceFactory
  /** Room status indicators and the two orchestrator side effects `travel` fires. */
  status?: TurnStatusPort
  onNarrationProduced?: NarrativeDeps['onNarrationProduced']
  invalidateAgentConfig?: ActionDeps['invalidateAgentConfig']
  random?: () => number
}

export interface BuildServersOptions {
  role: ServerRole
  /**
   * Absolute path to the agent's config directory.
   *
   * Kept as the "does this character have a folder on disk" gate it was in
   * Phase 0. The `memorize` write itself now goes through
   * `AgentConfigService`, which resolves `ctx.configFile` — the *relative*
   * path stored in the `agents.config_file` column — against the project root.
   */
  configDir?: string
}

/** Wrap a tool list as one server and record its qualified names. */
function addServer(
  built: BuiltServers,
  name: ServerName,
  tools: SdkTool[],
): void {
  if (tools.length === 0) return
  built.mcpServers[name] = createSdkMcpServer({ name, version: '1.0.0', tools })
  built.toolNames.push(...tools.map((t) => qualifiedToolName(name, t.name)))
}

/**
 * The `subagents` server: the callbacks a Task-tool sub-agent reaches back
 * into. Built for the Action Manager, the Onboarding Manager and sub-agents
 * alike — Python's `"subagent" in enabled_groups` covers all three.
 */
function subagentTools(
  ctx: ToolContext,
  deps: ServerDeps,
  persistence: LocationPersistenceFactory,
  mutations: PlayerMutationsPort | undefined,
): SdkTool[] {
  const tools: SdkTool[] = []

  if (deps.agentFiles) {
    tools.push(
      ...createPersistCharacterTool(ctx, {
        agentFiles: deps.agentFiles,
        players: deps.players,
        rooms: deps.rooms,
        locations: deps.locations,
        agentFactory: deps.agentFactory,
      }),
    )
  }

  if (deps.worlds) {
    tools.push(
      ...createPersistLocationTool(ctx, {
        players: deps.players,
        rooms: deps.rooms,
        locations: deps.locations,
        worlds: deps.worlds,
        status: deps.status,
        persistence,
      }),
    )
  }

  if (deps.items) {
    tools.push(
      ...createItemTools(ctx, {
        items: deps.items,
        players: deps.players,
        mutations,
      }),
    )
  }

  return tools
}

export function buildServers(
  ctx: ToolContext,
  deps: ServerDeps,
  options: BuildServersOptions,
): BuiltServers {
  const built: BuiltServers = { mcpServers: {}, toolNames: [] }
  const agentConfigs = deps.agentConfigs ?? new AgentConfigService()
  const persistence: LocationPersistenceFactory =
    deps.persistence ??
    ((db, worldId, worldName) => new PersistenceManager(db, worldId, worldName))

  // Resolved once per turn rather than per tool call: the two tool groups that
  // use it must share one instance, or a `change_stat` and a `persist_item` in
  // the same turn would each hold their own cached read of `player.yaml`.
  // `worldId` is absent for an agent with no world — a bare chat room — and the
  // tools gated on this are game tools, so they are simply not offered there.
  const mutations =
    ctx.worldId === undefined
      ? undefined
      : (deps.mutations ?? ((db, worldId) => new PlayerFacade(deps.players, db, worldId)))(
          ctx.getDb(),
          ctx.worldId,
        )

  // Every agent, every role. Not part of the role switch on purpose.
  addServer(built, SERVER_NAMES.guidelines, createGuidelinesTools(ctx))

  switch (options.role) {
    case 'action_manager': {
      const tools: SdkTool[] = [
        ...createNarrativeTools(ctx, {
          players: deps.players,
          rooms: deps.rooms,
          onNarrationProduced: deps.onNarrationProduced,
        }),
        ...createWorldTools(ctx, { locations: deps.locations, random: deps.random }),
      ]

      if (deps.agentFiles) {
        tools.push(
          ...createCharacterTools(ctx, {
            agentFiles: deps.agentFiles,
            players: deps.players,
            rooms: deps.rooms,
            locations: deps.locations,
            agentFactory: deps.agentFactory,
          }),
        )
      }

      if (deps.worlds) {
        tools.push(
          ...createLocationTools(ctx, {
            players: deps.players,
            rooms: deps.rooms,
            locations: deps.locations,
            worlds: deps.worlds,
            status: deps.status,
            persistence,
          }),
          ...createHistoryTools(ctx, { worlds: deps.worlds }),
        )
      }

      if (deps.items) {
        tools.push(
          ...createMechanicsTools(ctx, {
            players: deps.players,
            items: deps.items,
            agentConfigs,
            mutations,
          }),
        )
      }

      addServer(built, SERVER_NAMES.actionManager, tools)
      addServer(built, SERVER_NAMES.subagents, subagentTools(ctx, deps, persistence, mutations))
      break
    }

    case 'onboarding': {
      if (deps.worlds && deps.reset) {
        addServer(
          built,
          SERVER_NAMES.onboarding,
          createOnboardingTools(ctx, {
            worlds: deps.worlds,
            reset: deps.reset,
            players: deps.players,
            locations: deps.locations,
            agentFiles: deps.agentFiles,
          }),
        )
      }
      addServer(built, SERVER_NAMES.subagents, subagentTools(ctx, deps, persistence, mutations))
      break
    }

    case 'subagent': {
      addServer(built, SERVER_NAMES.subagents, subagentTools(ctx, deps, persistence, mutations))
      break
    }

    case 'character_design': {
      if (deps.agentFiles && deps.agentFactory && deps.worlds) {
        addServer(
          built,
          SERVER_NAMES.characterDesign,
          createCharacterDesignTools(ctx, {
            agentFiles: deps.agentFiles,
            agentFactory: deps.agentFactory,
            players: deps.players,
            rooms: deps.rooms,
            worlds: deps.worlds,
          }),
        )
      }
      break
    }

    case 'character': {
      if (!options.configDir) {
        throw new Error(`Character agent "${ctx.agentName}" has no config directory`)
      }
      addServer(
        built,
        SERVER_NAMES.action,
        createActionTools(ctx, {
          agentConfigs,
          players: deps.players,
          invalidateAgentConfig: deps.invalidateAgentConfig,
        }),
      )
      break
    }
  }

  built.toolNames = applyDisabledTools(built.toolNames, ctx)
  return built
}

/**
 * Drop the tools a group config has switched off for this agent.
 *
 * Port of the `disabled_tools` filter at the tail of
 * `mcp_registry.py::_build_allowed_tools`. It is a *separate* mechanism from
 * the per-tool `enabled` flag {@link resolveTool} honours: that one is a
 * property of the declaration, this one is a property of the agent, which is
 * how `group_gameplay` takes `memorize`, `recall` and `skip` away from every
 * gameplay agent without disabling them for characters.
 *
 * Python filters only the allow-list, so its servers still *offer* the tool and
 * the CLI merely refuses to let the model call it. Here the same list feeds the
 * TS SDK's `tools` option as well, which removes the tool from the model's view
 * outright — a stricter outcome, and the one the setting is actually asking for.
 * Recorded because the two backends will report different tool counts.
 */
function applyDisabledTools(toolNames: string[], ctx: ToolContext): string[] {
  if (!ctx.groupName) return toolNames
  const lookupName = ctx.groupName.startsWith('group_') ? ctx.groupName.slice(6) : ctx.groupName
  const disabled = getAgentToolConfig(lookupName, ctx.agentName).disabled_tools
  if (!disabled || disabled.length === 0) return toolNames
  return toolNames.filter((name) => !disabled.some((tool) => name.endsWith(`__${tool}`)))
}
