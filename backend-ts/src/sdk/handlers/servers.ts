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
 * Decides which tools one agent gets for one turn.
 *
 * Port of `sdk/handlers/servers.py` + `sdk/client/mcp_registry.py`. What this
 * file no longer does is *construct* MCP servers. The tools are served over the
 * stateless 2026-07-28 HTTP endpoint in `sdk/mcp/`, where the server for a
 * namespace is built per request from whatever binding is current — so the unit
 * this file produces is a **tool set**, and both consumers derive from the same
 * one:
 *
 * - `orchestration/turn.ts` maps it to qualified names for the SDK's `tools` /
 *   `allowedTools`, and to one `{ type: 'http' }` entry per non-empty server.
 * - `sdk/mcp/endpoint.ts` calls it again, per request, and registers the set
 *   belonging to the one namespace named in the URL.
 *
 * Calling the same function on both sides is the point. The allow-list and the
 * server's own `tools/list` cannot disagree about what exists, which is a class
 * of bug Python had — it registered short names with the SDK and stored
 * qualified ones in the definitions, and left the two to be kept in sync by
 * hand.
 *
 * ## Why this stopped being per-turn state
 *
 * The old shape built one in-process `createSdkMcpServer` per turn and handed
 * it to `query()`. `Options` are baked in at `query()` time and `SessionPool`
 * reuses a warm session whenever the fingerprint matches — and the fingerprint
 * hashed only the *names* of the servers. So every turn after the first on a
 * warm session had its freshly built servers silently discarded, and the CLI
 * went on calling turn 1's closures: `narration` filed turn 1's NPC reactions
 * against turn 40's message. Resolving the context per request is what makes a
 * warm session and a current context compatible.
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

const ALL_SERVER_NAMES: readonly ServerName[] = Object.values(SERVER_NAMES)

/** Whether a path segment names one of this backend's MCP namespaces. */
export function isServerName(value: string): value is ServerName {
  return (ALL_SERVER_NAMES as readonly string[]).includes(value)
}

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

/** Tool sets keyed by the namespace that prefixes their names. */
export type ToolSets = Partial<Record<ServerName, SdkTool[]>>

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

/**
 * One turn's worth of tool inputs, resolved once and reused by every request
 * that turn produces.
 *
 * The three service handles are on the binding rather than resolved inside
 * {@link buildToolSets} for one reason, and it is a correctness one:
 * `mutations` must be **one** `PlayerFacade` for the whole turn. A
 * `change_stat` and a `persist_item` in the same turn each holding their own
 * would each hold their own cached read of `player.yaml`, and the second write
 * would be made against a stale one. Building it per HTTP request would do
 * exactly that, so it is built here — once, when the turn registers — and
 * carried across every call the turn makes.
 */
export interface TurnBinding {
  ctx: ToolContext
  role: ServerRole
  configDir?: string
  agentConfigs: AgentConfigService
  persistence: LocationPersistenceFactory
  /** Absent for an agent with no world — a bare chat room has no player state. */
  mutations?: PlayerMutationsPort
}

/**
 * Resolve a turn's shared handles. Call once per turn, then hand the result to
 * {@link buildToolSets} as many times as there are tool calls.
 */
export function createTurnBinding(
  ctx: ToolContext,
  deps: ServerDeps,
  options: BuildServersOptions,
): TurnBinding {
  const persistence: LocationPersistenceFactory =
    deps.persistence ??
    ((db, worldId, worldName) => new PersistenceManager(db, worldId, worldName))

  // `worldId` is absent for an agent with no world — a bare chat room — and the
  // tools gated on this are game tools, so they are simply not offered there.
  const mutations =
    ctx.worldId === undefined
      ? undefined
      : (deps.mutations ?? ((db, worldId) => new PlayerFacade(deps.players, db, worldId)))(
          ctx.getDb(),
          ctx.worldId,
        )

  return {
    ctx,
    role: options.role,
    configDir: options.configDir,
    agentConfigs: deps.agentConfigs ?? new AgentConfigService(),
    persistence,
    mutations,
  }
}

/**
 * The `subagents` server: the callbacks a Task-tool sub-agent reaches back
 * into. Built for the Action Manager, the Onboarding Manager and sub-agents
 * alike — Python's `"subagent" in enabled_groups` covers all three.
 */
function subagentTools(binding: TurnBinding, deps: ServerDeps): SdkTool[] {
  const { ctx, persistence, mutations } = binding
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

/**
 * Every tool this binding's agent may call, grouped by namespace.
 *
 * Deterministic: called twice with the same binding it returns the same names,
 * which is what lets the allow-list `turn.ts` computes and the `tools/list` the
 * endpoint answers stay identical without either one being cached.
 */
export function buildToolSets(binding: TurnBinding, deps: ServerDeps): ToolSets {
  const { ctx } = binding
  const sets: ToolSets = {}

  const add = (name: ServerName, tools: SdkTool[]): void => {
    const kept = applyDisabledTools(tools, ctx)
    if (kept.length > 0) sets[name] = kept
  }

  // Every agent, every role. Not part of the role switch on purpose.
  add(SERVER_NAMES.guidelines, createGuidelinesTools(ctx))

  switch (binding.role) {
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
            persistence: binding.persistence,
          }),
          ...createHistoryTools(ctx, { worlds: deps.worlds }),
        )
      }

      if (deps.items) {
        tools.push(
          ...createMechanicsTools(ctx, {
            players: deps.players,
            items: deps.items,
            agentConfigs: binding.agentConfigs,
            mutations: binding.mutations,
          }),
        )
      }

      add(SERVER_NAMES.actionManager, tools)
      add(SERVER_NAMES.subagents, subagentTools(binding, deps))
      break
    }

    case 'onboarding': {
      if (deps.worlds && deps.reset) {
        add(
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
      add(SERVER_NAMES.subagents, subagentTools(binding, deps))
      break
    }

    case 'subagent': {
      add(SERVER_NAMES.subagents, subagentTools(binding, deps))
      break
    }

    case 'character_design': {
      if (deps.agentFiles && deps.agentFactory && deps.worlds) {
        add(
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
      if (!binding.configDir) {
        throw new Error(`Character agent "${ctx.agentName}" has no config directory`)
      }
      add(
        SERVER_NAMES.action,
        createActionTools(ctx, {
          agentConfigs: binding.agentConfigs,
          players: deps.players,
          invalidateAgentConfig: deps.invalidateAgentConfig,
        }),
      )
      break
    }
  }

  return sets
}

/** The `mcp__server__tool` names a tool set map implies, for the allow-list. */
export function qualifiedToolNames(sets: ToolSets): string[] {
  return Object.entries(sets).flatMap(([server, tools]) =>
    tools.map((tool) => qualifiedToolName(server, tool.name)),
  )
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
 * the CLI merely refuses to let the model call it. Filtering the tool set
 * itself removes it from `tools/list` outright — a stricter outcome, and the
 * one the setting is actually asking for. Recorded because the two backends
 * will report different tool counts.
 */
function applyDisabledTools(tools: SdkTool[], ctx: ToolContext): SdkTool[] {
  if (!ctx.groupName) return tools
  const lookupName = ctx.groupName.startsWith('group_') ? ctx.groupName.slice(6) : ctx.groupName
  const disabled = getAgentToolConfig(lookupName, ctx.agentName).disabled_tools
  if (!disabled || disabled.length === 0) return tools
  return tools.filter((tool) => !disabled.includes(tool.name))
}
