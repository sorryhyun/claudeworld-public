/**
 * Who speaks first. Two independent splits over the same roster: agents with an
 * explicit priority get their own tape cell ahead of everyone else, and agents
 * flagged `interrupt_every_turn` react whether or not they were addressed. Both
 * flags come from `group_config.yaml`, so a whole group can be made loud.
 */

/** Structural, so tape builders can pass shapes lighter than a Drizzle row. */
export interface OrderableAgent {
  priority?: number | null
  interruptEveryTurn?: boolean | null
}

// A missing or NULL priority is 0, not NaN — NaN in the comparator would leave
// the sort order unspecified.
function priorityOf(agent: OrderableAgent): number {
  return agent.priority ?? 0
}

/**
 * Split into (priority, regular). Only the priority half is sorted, descending;
 * the regular half keeps roster order, and the caller's roster is never
 * reordered in place. The sort is stable, so ties keep roster order.
 */
export function separatePriorityAgents<T extends OrderableAgent>(
  agents: readonly T[],
): [priority: T[], regular: T[]] {
  const priorityAgents: T[] = []
  const regularAgents: T[] = []

  for (const agent of agents) {
    // Strictly greater than zero: a negative priority is not a priority agent.
    if (priorityOf(agent) > 0) {
      priorityAgents.push(agent)
    } else {
      regularAgents.push(agent)
    }
  }

  priorityAgents.sort((a, b) => priorityOf(b) - priorityOf(a))

  return [priorityAgents, regularAgents]
}

/**
 * Split into (interrupt, regular), the interrupt half sorted by priority
 * descending. `=== true` also rejects the NULL a never-configured agent yields.
 */
export function separateInterruptAgents<T extends OrderableAgent>(
  agents: readonly T[],
): [interrupt: T[], regular: T[]] {
  const interruptAgents: T[] = []
  const regularAgents: T[] = []

  for (const agent of agents) {
    if (agent.interruptEveryTurn === true) {
      interruptAgents.push(agent)
    } else {
      regularAgents.push(agent)
    }
  }

  interruptAgents.sort((a, b) => priorityOf(b) - priorityOf(a))

  return [interruptAgents, regularAgents]
}
