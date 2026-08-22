/**
 * Agent identity: who is machinery and who is cast.
 *
 * Port of `backend/domain/entities/agent.py` plus the agent-name pattern sets
 * from `backend/domain/value_objects/enums.py:110-121`. The two files are
 * merged because the patterns have exactly one consumer — the predicates below
 * — and Python only split them to keep `enums.py` as the single constants file.
 *
 * Nothing here touches the database. The predicates take names and plain
 * objects so the SDK layer (which knows an agent only by name) and the CRUD
 * layer (which holds Drizzle rows) can both call them.
 *
 * Deliberately not ported: Python's `Agent` dataclass. It is constructed
 * nowhere in the tree — every caller passes a `models.Agent` row and relies on
 * duck typing — so porting it would add a second `Agent` type colliding with
 * the Drizzle row type in `db/schema.ts` for no consumer's benefit.
 */

/**
 * The two groups whose members are machinery, not characters.
 *
 * Python has an `AgentGroup(str, Enum)` (`enums.py:22`) whose only use is
 * building `SYSTEM_AGENT_GROUPS`; it serialises as a bare string, so a string
 * union reproduces it with no runtime object, matching `auth/roles.ts`.
 *
 * Note these are the bare group names, not the `group_gameplay` directory
 * names — the `agents.group` column stores the suffix.
 */
export const AGENT_GROUPS = ['gameplay', 'onboarding'] as const

export type AgentGroup = (typeof AGENT_GROUPS)[number]

/**
 * `SYSTEM_AGENT_GROUPS` from `enums.py:121`.
 *
 * Typed as `ReadonlySet<string>` rather than `ReadonlySet<AgentGroup>` because
 * every caller tests a nullable `agents.group` column value, which is a plain
 * string; narrowing the set would force a cast at each `.has()`.
 */
export const SYSTEM_AGENT_GROUPS: ReadonlySet<string> = new Set<string>(AGENT_GROUPS)

/**
 * Agent-name patterns, from `enums.py:110-118`.
 *
 * Each set carries three spellings of the same role because agent folders,
 * database rows and prompt text have historically disagreed about separators.
 * Matching is substring-based on a normalized name (see `matchesPatterns`), so
 * `TRPG_Action_Manager` and `Action Manager` both hit `action_manager` — the
 * `actionmanager` and `action manager` entries exist for names that arrive
 * without any separator or that survive normalization with a space.
 */
export const ACTION_MANAGER_PATTERNS = ['action_manager', 'actionmanager', 'action manager'] as const
export const ONBOARDING_MANAGER_PATTERNS = [
  'onboarding_manager',
  'onboardingmanager',
  'onboarding manager',
] as const

/** Sub-agents, invoked through tools during gameplay rather than as tape cells. */
export const CHARACTER_DESIGNER_PATTERNS = [
  'character_designer',
  'characterdesigner',
  'character designer',
] as const
export const ITEM_DESIGNER_PATTERNS = ['item_designer', 'itemdesigner', 'item designer'] as const
export const LOCATION_DESIGNER_PATTERNS = [
  'location_designer',
  'locationdesigner',
  'location designer',
] as const
export const CHAT_SUMMARIZER_PATTERNS = [
  'chat_summarizer',
  'chatsummarizer',
  'chat summarizer',
] as const

/**
 * Python's `_matches_patterns`: lowercase, spaces to underscores, then ask
 * whether any pattern appears anywhere in the result.
 *
 * Exported because `mcp_registry.py` and the guidelines loader both want to
 * test bespoke pattern lists; keeping one normalization function means a name
 * cannot match in one place and miss in another.
 */
export function matchesPatterns(agentName: string, patterns: readonly string[]): boolean {
  const normalized = agentName.toLowerCase().replaceAll(' ', '_')
  return patterns.some((pattern) => normalized.includes(pattern))
}

/** The gameplay narrator/coordinator: interprets the action and narrates it. */
export function isActionManager(agentName: string): boolean {
  return matchesPatterns(agentName, ACTION_MANAGER_PATTERNS)
}

/** Runs the onboarding interview and generates the world seed. */
export function isOnboardingManager(agentName: string): boolean {
  return matchesPatterns(agentName, ONBOARDING_MANAGER_PATTERNS)
}

export function isCharacterDesigner(agentName: string): boolean {
  return matchesPatterns(agentName, CHARACTER_DESIGNER_PATTERNS)
}

export function isItemDesigner(agentName: string): boolean {
  return matchesPatterns(agentName, ITEM_DESIGNER_PATTERNS)
}

export function isLocationDesigner(agentName: string): boolean {
  return matchesPatterns(agentName, LOCATION_DESIGNER_PATTERNS)
}

/** Invoked once on chat-mode exit to fold the conversation into history. */
export function isChatSummarizer(agentName: string): boolean {
  return matchesPatterns(agentName, CHAT_SUMMARIZER_PATTERNS)
}

/**
 * The fields `isSystemAgent` needs.
 *
 * Structural rather than the Drizzle `Agent` row type so the domain layer does
 * not import `db/schema.ts`, and so callers holding a partially-selected row
 * (name and group only) still typecheck.
 */
export interface AgentIdentity {
  name: string
  group?: string | null
}

/**
 * Machinery, not cast.
 *
 * Group membership is checked first because it is authoritative — a system
 * agent always carries `gameplay` or `onboarding` — and the name check is the
 * fallback for the Action Manager, which some legacy rows store ungrouped.
 * Sub-agents are *not* covered: they live in `group_subagent`, which is not in
 * `SYSTEM_AGENT_GROUPS`, and they never join a player's room, so Python never
 * needed to filter them out. Reproduced as-is.
 */
export function isSystemAgent(agent: AgentIdentity): boolean {
  if (agent.group && SYSTEM_AGENT_GROUPS.has(agent.group)) return true
  return isActionManager(agent.name)
}

/**
 * The names of the character agents in a room, machinery removed.
 *
 * `room` is nullable and the empty-agents case short-circuits, matching
 * Python's `if not room or not room.agents`. The parameter is structural for
 * the same reason `AgentIdentity` is — `crud/rooms.ts::RoomWithRelations`
 * satisfies it without the domain layer knowing that type exists.
 */
export function getPresentCharacters(
  room: { agents: readonly AgentIdentity[] } | null | undefined,
): string[] {
  if (!room || room.agents.length === 0) return []
  return room.agents.filter((a) => !isSystemAgent(a)).map((a) => a.name)
}

/** The TRPG roles `findTrpgAgents` can resolve. */
export const TRPG_ROLES = [
  'onboarding_manager',
  'action_manager',
  'character_designer',
  'item_designer',
  'location_designer',
  'chat_summarizer',
] as const

export type TrpgRole = (typeof TRPG_ROLES)[number]

/**
 * Role → agent id. Partial: a room that has never onboarded has no
 * `onboarding_manager`, and callers check for the key they need.
 */
export type TrpgAgentMap = Partial<Record<TrpgRole, number>>

/** The fields `findTrpgAgents` reads off each agent. */
export interface TrpgAgentCandidate {
  id: number
  name: string
}

/**
 * Resolve a roster of agents to the TRPG roles they fill.
 *
 * The chain is `else if`, so one agent fills at most one role even if its name
 * would match two patterns; and later agents overwrite earlier ones for the
 * same role, because Python assigns into a dict. Both are load-bearing for a
 * world whose cast happens to contain a character named after a role — do not
 * "fix" either into a first-wins or multi-role form.
 */
export function findTrpgAgents(agents: readonly TrpgAgentCandidate[]): TrpgAgentMap {
  const agentMap: TrpgAgentMap = {}

  for (const agent of agents) {
    const name = agent.name

    if (isOnboardingManager(name)) {
      agentMap.onboarding_manager = agent.id
    } else if (isActionManager(name)) {
      agentMap.action_manager = agent.id
    } else if (isCharacterDesigner(name)) {
      agentMap.character_designer = agent.id
    } else if (isItemDesigner(name)) {
      agentMap.item_designer = agent.id
    } else if (isLocationDesigner(name)) {
      agentMap.location_designer = agent.id
    } else if (isChatSummarizer(name)) {
      agentMap.chat_summarizer = agent.id
    }
  }

  return agentMap
}
