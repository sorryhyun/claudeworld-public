/**
 * Agent identity: who is machinery and who is cast. The predicates take names
 * and plain objects, so the SDK layer (which knows an agent only by name) and
 * the CRUD layer (which holds Drizzle rows) can both call them.
 */

// Machinery, not characters. Bare group names, not `group_gameplay` directory
// names — the `agents.group` column stores the suffix.
export const AGENT_GROUPS = ['gameplay', 'onboarding'] as const

export type AgentGroup = (typeof AGENT_GROUPS)[number]

// `ReadonlySet<string>`, not `ReadonlySet<AgentGroup>`: callers test a nullable
// `agents.group` value, and narrowing would force a cast at each `.has()`.
export const SYSTEM_AGENT_GROUPS: ReadonlySet<string> = new Set<string>(AGENT_GROUPS)

// Three spellings each, because agent folders, database rows and prompt text
// disagree about separators; matching is substring-based on a normalized name.
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

// Lowercase, spaces to underscores, then substring-match. Exported so bespoke
// pattern lists share the normalization and cannot disagree about a name.
export function matchesPatterns(agentName: string, patterns: readonly string[]): boolean {
  const normalized = agentName.toLowerCase().replaceAll(' ', '_')
  return patterns.some((pattern) => normalized.includes(pattern))
}

export function isActionManager(agentName: string): boolean {
  return matchesPatterns(agentName, ACTION_MANAGER_PATTERNS)
}

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

// Structural rather than the Drizzle row type, so the domain layer does not
// import `db/schema.ts` and a partially-selected row still typechecks.
export interface AgentIdentity {
  name: string
  group?: string | null
}

// Group membership is authoritative and checked first; the name check is the
// fallback for the Action Manager, which some legacy rows store ungrouped.
export function isSystemAgent(agent: AgentIdentity): boolean {
  if (agent.group && SYSTEM_AGENT_GROUPS.has(agent.group)) return true
  return isActionManager(agent.name)
}

export function getPresentCharacters(
  room: { agents: readonly AgentIdentity[] } | null | undefined,
): string[] {
  if (!room || room.agents.length === 0) return []
  return room.agents.filter((a) => !isSystemAgent(a)).map((a) => a.name)
}

export const TRPG_ROLES = [
  'onboarding_manager',
  'action_manager',
  'character_designer',
  'item_designer',
  'location_designer',
  'chat_summarizer',
] as const

export type TrpgRole = (typeof TRPG_ROLES)[number]

/** Partial: a room that never onboarded has no `onboarding_manager`. */
export type TrpgAgentMap = Partial<Record<TrpgRole, number>>

export interface TrpgAgentCandidate {
  id: number
  name: string
}

/**
 * Resolve a roster of agents to the TRPG roles they fill. The chain is
 * `else if`, so one agent fills at most one role, and later agents overwrite
 * earlier ones — do not "fix" either into first-wins or multi-role form.
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
