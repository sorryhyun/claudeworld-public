import { TurnTape, type TurnCell } from './models'

/**
 * Builds the chat-mode tape. Port of
 * `orchestration/chat_mode_orchestrator.py::create_chat_mode_tape`.
 *
 * Chat mode is the free-form conversation a player can open with the NPCs at
 * their location, outside the Action Manager loop. Structurally it is the
 * opposite of the gameplay tape in every respect that matters:
 *
 *   - **No Action Manager and no Narrator.** Nothing interprets the message and
 *     nothing resolves it against the world; the NPCs simply talk.
 *   - **Nothing is hidden.** A gameplay turn's cells are all hidden and speak
 *     only through the `narration` tool. Here each NPC's prose *is* the output,
 *     so it is persisted as a message and the player reads it directly.
 *   - **One agent per cell, never concurrent.** NPCs in a conversation have to
 *     see each other's replies, and a concurrent cell would have them all answer
 *     the player in parallel, blind to one another. Python spelled this out —
 *     "each agent gets its own cell to ensure sequential execution and prevent
 *     interaction" — and it is the reason chat mode feels like a group
 *     conversation rather than a chorus.
 *
 * Ordering is the standard multi-agent rule the gameplay tape has no use for:
 * regular NPCs first in descending `priority`, then the `interrupt_every_turn`
 * ones — also in descending priority — which is what lets a character
 * configured to always have the last word actually get it.
 */

/**
 * The agent fields the tape orders by. A row from `agents`, narrowed.
 *
 * Both are nullable in the schema, because SQLAlchemy's `default=` fills them
 * on insert without putting a `DEFAULT` in the DDL — so a row written by
 * anything other than the ORM can carry NULL. Python read those through
 * attributes that were never None in practice; here the fallbacks are explicit
 * and match the ORM defaults (`priority=0`, `interrupt_every_turn=False`).
 */
export interface ChatTapeAgent {
  id: number
  /** Higher speaks first. Ties keep the order the caller supplied. */
  priority: number | null
  /** Set in `group_config.yaml`; these run last, after the regular NPCs. */
  interruptEveryTurn: boolean | null
}

/**
 * @param npcs NPCs at the player's location, system agents already excluded.
 * @returns A tape, or `null` when there is nobody to talk to — the caller
 *   treats that as a completed turn rather than a failure, because a location
 *   with no NPCs is a normal place for a player to try to talk.
 */
export function createChatModeTape(npcs: readonly ChatTapeAgent[]): TurnTape | null {
  if (npcs.length === 0) return null

  const regular = npcs.filter((a) => !(a.interruptEveryTurn ?? false))
  const interrupting = npcs.filter((a) => a.interruptEveryTurn ?? false)

  // `sort` is stable in every engine Bun targets, so equal priorities keep the
  // caller's order — which is the location's roster order, not something
  // arbitrary. Python's `list.sort` gives the same guarantee.
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
