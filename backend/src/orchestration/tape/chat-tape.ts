import { TurnTape, type TurnCell } from './models'

/**
 * The chat-mode tape: free-form conversation with the NPCs at a location.
 * Nothing is hidden, and there is **one agent per cell, never concurrent**,
 * because NPCs have to see each other's replies. Regular NPCs go first in
 * descending `priority`, then the `interrupt_every_turn` ones.
 */

// Both fields are nullable — the columns carry no SQL `DEFAULT` — so the
// fallbacks below (`0`, `false`) are load-bearing.
export interface ChatTapeAgent {
  id: number
  /** Higher speaks first; ties keep the caller's order. */
  priority: number | null
  interruptEveryTurn: boolean | null
}

/** `null` when there is nobody to talk to — a completed turn, not a failure. */
export function createChatModeTape(npcs: readonly ChatTapeAgent[]): TurnTape | null {
  if (npcs.length === 0) return null

  const regular = npcs.filter((a) => !(a.interruptEveryTurn ?? false))
  const interrupting = npcs.filter((a) => a.interruptEveryTurn ?? false)

  // `sort` is stable, so equal priorities keep the caller's order — which is
  // the location's roster order, not something arbitrary.
  const byPriorityDesc = (a: ChatTapeAgent, b: ChatTapeAgent): number =>
    (b.priority ?? 0) - (a.priority ?? 0)

  const cells: TurnCell[] = [
    ...[...regular].sort(byPriorityDesc).map(
      (agent): TurnCell => ({
        cellType: 'sequential',
        agentIds: [agent.id],
        hidden: false,
        isReaction: false,
      }),
    ),
    ...[...interrupting].sort(byPriorityDesc).map(
      (agent): TurnCell => ({
        cellType: 'interrupt',
        agentIds: [agent.id],
        hidden: false,
        isReaction: false,
      }),
    ),
  ]

  return new TurnTape(cells)
}
