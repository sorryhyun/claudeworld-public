import { AgentConfigService } from '@/services/agent-config-service'
import type { ItemService } from '@/services/item-service'
import type { LocationStorage } from '@/services/location-storage'
import type { PlayerService } from '@/services/player-service'
import type { RoomMappingService } from '@/services/room-mapping'
import type { WorldService } from '@/services/world-service'
import type { WorldResetService } from '@/services/world-reset-service'
import { getAgentToolConfig } from '@/sdk/loaders/group-config'
import { qualifiedToolName } from '@/sdk/tools/definitions'
import { isReadOnlyTool } from '@/sdk/tools/registry'
import { createActionTools, type ActionDeps } from './action-tools'
import { createCharacterDesignTools } from './character-design-tools'
import { createCharacterTools, createPersistCharacterTool } from './character-tools'
import { createGuidelinesTools } from './guidelines-tools'
import { createHistoryTools } from './history-tools'
import { createItemTools } from './item-tools'
import { createLocationTools, createPersistLocationTool } from './location-tools'
import { createLoreContributionTools } from './lore-tools'
import { createMechanicsTools } from './mechanics-tools'
import { createNarrativeTools, type NarrativeDeps } from './narrative-tools'
import { createOnboardingTools } from './onboarding-tools'
import { createWorldTools } from './world-tools'
import type { AgentFactory } from '@/services/agent-factory'
import type { AgentFilesystemService } from '@/services/agent-filesystem-service'
import { PersistenceManager } from '@/services/persistence-manager'
import { PlayerFacade } from '@/services/player-facade'
import type {
  LocationPersistenceFactory,
  PlayerMutationsFactory,
  PlayerMutationsPort,
  TurnStatusPort,
} from './ports'
import type { SdkTool, ToolContext } from './context'

/**
 * Decides which tools one agent gets for one turn. Both `orchestration/turn.ts`
 * (the allow-list) and `sdk/mcp/endpoint.ts` (`tools/list`, per request) derive
 * from this one function, so the two cannot disagree about what exists.
 *
 * Tool sets must not become per-turn state: `Options` are baked in at `query()`
 * time and a warm session's fingerprint hashes only server *names*, so servers
 * built per turn are discarded and the CLI keeps calling turn 1's closures.
 * Where a dependency is missing, the tools needing it are **not offered**.
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

export function isServerName(value: string): value is ServerName {
  return (ALL_SERVER_NAMES as readonly string[]).includes(value)
}

/** Served once per session. **Not** per-agent — that goes in a description. */
export const SERVER_INSTRUCTIONS: Partial<Readonly<Record<ServerName, string>>> = {
  [SERVER_NAMES.action]:
    'These tools belong to the character you are playing, not to the narrator. ' +
    '`recall` reads this character\'s own long-term memories and its description lists ' +
    'every subtitle that exists — ask for one of those, never a subtitle you invented; ' +
    'a memory that is not listed has not been written yet. `memorize` is for something ' +
    'that happened in this scene and will still matter later, not for a running log of ' +
    'the conversation. `skip` is a real choice: call it, with nothing else, when the ' +
    'character would stay silent.',

  [SERVER_NAMES.actionManager]:
    'You resolve one player action per turn, then narrate it — and the characters at the ' +
    "player's location are reacting to that same action while you work, started at the " +
    'moment you were. So the turn has two halves. First: establish the facts and rule ' +
    'the attempt. `list_locations`, `list_characters`, `list_inventory`, `list_world_item` ' +
    'and `recall_history` are free of side effects and can be called together, so gather ' +
    'what the action depends on in one batch rather than guessing and correcting ' +
    'mid-narration; then apply consequences with `change_stat` and `advance_time`; then ' +
    "call `narration` for the player's own action, which is what ends their blank " +
    'screen. Second: call `await_reactions` for what the characters said, and call ' +
    '`narration` again to voice it — named, quoted, staged. Nothing an NPC says reaches ' +
    'the player except through that second narration, so dropping it drops them from the ' +
    'scene. `travel` belongs after `await_reactions`, never before: it ends the scene ' +
    'those characters are still speaking in. Never describe an outcome you have not ' +
    'already committed through a tool, and never name a location, character or item the ' +
    'lists did not return. `list_characters` covers the whole world, not just this room, ' +
    'and includes the characters standing nowhere: anyone it returns already exists and ' +
    'is moved or reused — dispatch a designer only for a character it did not list.',

  [SERVER_NAMES.onboarding]:
    'This is world creation, and it is a conversation with the player as much as it is ' +
    'a build. `set_world_settings` comes before everything else: it registers the ' +
    'language the world is written in and what the player is called, and it is handed ' +
    'to every design sub-agent automatically — a designer dispatched before it is ' +
    'called writes in the default language, which is how a Korean world grows English ' +
    'items. `read_lore_guidelines` next — it carries the structure the rest of this ' +
    'namespace expects. `draft_world` is cheap and re-callable: call it as soon as the ' +
    'genre and theme are clear, then call it again — with only the fields that moved — ' +
    'each time the conversation changes them. Build the world *during* the interview ' +
    'rather than after it: the moment the player names a place, a person or an object, ' +
    'dispatch the designer for it and tell the player what appeared. `world_status` is ' +
    'how you find out what already exists before you create it again, and it costs ' +
    'nothing. `persist_world` writes the full lore and the stat system; it replaces the ' +
    'draft body but leaves the sections your designers wrote alone. `complete` ends ' +
    'onboarding and hands the world to the Action Manager: call it only when the world, ' +
    'its starting location and the player character all exist.',

  [SERVER_NAMES.subagents]:
    'These are the callbacks a design sub-agent reports its finished work through. ' +
    "Everything player-visible you write through them is written in the world's own " +
    'language, as the World Settings in your prompt state it; only machine identifiers ' +
    '— a location `name`, an `item_id`, a stat or flag name — stay lowercase ASCII. ' +
    'Prose is not a result — a design that is described but never persisted through the ' +
    'tool for it is discarded when the sub-agent ends. Persist once, at the end, with ' +
    'the complete design rather than in fragments as you go: `persist_item` takes every ' +
    'item in one call, and re-persisting an id that already exists is skipped, not ' +
    'overwritten, so a retry cannot repair a partial write. `add_world_lore` is the ' +
    'exception to "report and stop": it writes into the world\'s own lore, so use it ' +
    'when your design establishes something later turns must honour — a faction, a ' +
    'custom, a debt, the reason a door is bricked up — and leave it alone when the ' +
    'design is self-contained. One section per idea, titled; the same title again ' +
    'rewrites that section rather than adding a second.',
}

export type ServerRole =
  | 'action_manager'
  | 'character'
  | 'onboarding'
  | 'subagent'
  | 'character_design'

export type ToolSets = Partial<Record<ServerName, SdkTool[]>>

export interface ServerDeps {
  players: PlayerService
  rooms: RoomMappingService
  locations: LocationStorage
  /** World config, lore and compressed history. Gates `travel` and `recall_history`. */
  worlds?: WorldService
  /** Item templates. Gates `list_world_item`, `change_stat` and `persist_item`. */
  items?: ItemService
  /** `recent_events.md` writes. */
  agentConfigs?: AgentConfigService
  /** `_initial.json`. Gates nothing on its own; `complete` needs it. */
  reset?: WorldResetService
  /** World-scoped agent folders. Gates the character tools and the designers. */
  agentFiles?: AgentFilesystemService
  /** Mirrors an agent folder into an `agents` row. */
  agentFactory?: AgentFactory
  /** Binds a {@link PlayerFacade} to one world. Tests pass their own. */
  mutations?: PlayerMutationsFactory
  /** Binds a {@link PersistenceManager} to one world. Tests pass their own. */
  persistence?: LocationPersistenceFactory
  /** Room status indicators and the two orchestrator side effects `travel` fires. */
  status?: TurnStatusPort
  onNarrationProduced?: NarrativeDeps['onNarrationProduced']
  onNarrationSaved?: NarrativeDeps['onNarrationSaved']
  invalidateAgentConfig?: ActionDeps['invalidateAgentConfig']
  random?: () => number
}

export interface BuildServersOptions {
  role: ServerRole
  /** The "does this character have a folder on disk" gate. */
  configDir?: string
}

/**
 * One turn's tool inputs, resolved once and reused by every request that turn
 * produces. `mutations` must be **one** `PlayerFacade` per turn: two would each
 * cache `player.json` and the second write would be stale.
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

// Callbacks a dispatched sub-agent reaches back into. Built for the Action
// Manager, the Onboarding Manager and sub-agents alike.
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
      // Not a persist callback: the writer here is whoever holds the server,
      // designer and dispatching parent alike.
      ...createLoreContributionTools(ctx, { worlds: deps.worlds }),
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

/** Must stay deterministic: the allow-list and `tools/list` both derive from it. */
export function buildToolSets(binding: TurnBinding, deps: ServerDeps): ToolSets {
  const { ctx } = binding
  const sets: ToolSets = {}

  const add = (name: ServerName, tools: SdkTool[]): void => {
    const kept = applyDisabledTools(tools, ctx).map(annotate)
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
          onNarrationSaved: deps.onNarrationSaved,
        }),
        ...createWorldTools(ctx, {
          locations: deps.locations,
          agentFiles: deps.agentFiles,
          rooms: deps.rooms,
          random: deps.random,
        }),
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
            items: deps.items,
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

// Stamp `readOnlyHint` from the declaration in `sdk/tools/`, in one pass rather
// than at each `tool()` call site. `destructiveHint` already defaults to true.
function annotate(tool: SdkTool): SdkTool {
  if (!isReadOnlyTool(tool.name)) return tool
  return { ...tool, annotations: { ...tool.annotations, readOnlyHint: true } }
}

// Drop the tools a group config has switched off for this agent — a property
// of the agent, unlike the per-tool `enabled` flag. Filtering the set removes
// them from `tools/list`, not just from the allow-list.
function applyDisabledTools(tools: SdkTool[], ctx: ToolContext): SdkTool[] {
  if (!ctx.groupName) return tools
  const lookupName = ctx.groupName.startsWith('group_') ? ctx.groupName.slice(6) : ctx.groupName
  const disabled = getAgentToolConfig(lookupName, ctx.agentName).disabled_tools
  if (!disabled || disabled.length === 0) return tools
  return tools.filter((tool) => !disabled.includes(tool.name))
}
