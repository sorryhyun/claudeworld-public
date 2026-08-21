/**
 * Who speaks first. Port of `backend/orchestration/agent_ordering.py`.
 *
 * Two independent splits over the same roster:
 *
 * - `separatePriorityAgents` pulls out agents with an explicit priority so the
 *   tape can give them their own cell ahead of everyone else.
 * - `separateInterruptAgents` pulls out agents flagged `interrupt_every_turn`,
 *   who react on every turn regardless of whether they were addressed.
 *
 * Both come from `group_config.yaml`, so a whole group can be made loud or
 * insistent without editing individual agents.
 */

/**
 * The two columns these functions read.
 *
 * Both optional and nullable: Python uses `getattr(agent, "priority", 0)`, so
 * an object missing the attribute entirely is as valid an input as a row whose
 * column is NULL. Structural rather than the Drizzle `Agent` row type so tape
 * builders can pass their own lighter shapes.
 */
export interface OrderableAgent {
  priority?: number | null
  interruptEveryTurn?: boolean | null
}

/**
 * `getattr(agent, "priority", 0)` — a missing or NULL priority is 0, not
 * NaN. The `??` is what makes the comparison and the sort agree; without it a
 * NULL would compare false in the split but produce NaN in the comparator and
 * leave the sort order unspecified.
 */
function priorityOf(agent: OrderableAgent): number {
  return agent.priority ?? 0
}

/**
 * Split into (priority, regular).
 *
 * Only the priority half is sorted — descending, so the loudest agent speaks
 * first. The regular half keeps roster order, which is `agents.id` order as
 * the room query returns it.
 *
 * Both halves are new arrays and the sort runs on the new array, so the caller's
 * roster is never reordered in place. `Array.prototype.sort` is stable (ES2019)
 * and so is Python's, so agents tied on priority keep roster order in both.
 */
export function separatePriorityAgents<T extends OrderableAgent>(
  agents: readonly T[],
): [priority: T[], regular: T[]] {
  const priorityAgents: T[] = []
  const regularAgents: T[] = []

  for (const agent of agents) {
    // Strictly greater than zero: a negative priority is *not* a priority
    // agent, it just sorts last among the regulars — which is to say, nowhere,
    // since the regular half is not sorted at all.
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
 * descending so the loudest interrupter is heard first.
 *
 * Python tests `getattr(agent, "interrupt_every_turn", 0) == 1` against an
 * integer column. Here the column is declared `{ mode: 'boolean' }`
 * (`db/schema.ts:54`), so Drizzle has already turned the stored 0/1 into
 * `false`/`true` and the test is `=== true` — which also rejects the NULL that
 * the nullable column yields for agents that were never configured, exactly as
 * `None == 1` is false in Python.
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
