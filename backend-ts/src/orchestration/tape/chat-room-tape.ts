/**
 * The chat-room tape — port of `orchestration/tape/generator.py::TapeGenerator`.
 *
 * This is the *original* ClaudeWorld scheduler, the one plain chat rooms have
 * always used, and it is a different shape from both game tapes:
 *
 * - `gameplay-tape.ts` is two fixed cells (NPCs react, then the Action Manager).
 * - `chat-tape.ts` is one NPC per cell, strictly sequential, no interrupts.
 * - This one mixes all three cell types and weaves interrupt agents through.
 *
 * Three agent categories drive it, and they are orthogonal:
 *
 * - **interrupt** (`interrupt_every_turn`) — speaks after every other agent, so
 *   a character configured to always have the last word actually gets it.
 * - **priority** (`priority > 0`) — speaks first, sequentially, in descending
 *   priority, each seeing what came before.
 * - **regular** — everyone else, who answer the user *concurrently*, because
 *   they are all reacting to the same message and nothing they say depends on
 *   each other within the round.
 *
 * **transparent** cuts across all three: a transparent agent does not trigger
 * the interrupt agents, which is how a silent observer avoids provoking a
 * response to itself.
 */

import { separatePriorityAgents, type OrderableAgent } from '../agent-ordering'
import { getLogger } from '../../infrastructure/logging/logger'
import { TurnTape, type TurnCell } from './models'

const logger = getLogger('ChatRoomTape')

/**
 * The agent fields the generator reads.
 *
 * All three are nullable for the reason `chat-tape.ts` spells out: SQLAlchemy's
 * `default=` fills them on insert without emitting DDL, so a row written by
 * anything else can carry NULL. The fallbacks match the ORM defaults.
 */
export interface ChatRoomAgent extends OrderableAgent {
  id: number
  /** Does not trigger interrupt agents when it speaks. */
  transparent?: boolean | null
}

function isTransparent(agent: ChatRoomAgent): boolean {
  return agent.transparent ?? false
}

/** Every chat-room cell is visible: the agents' prose *is* the output. */
function cell(
  cellType: TurnCell['cellType'],
  agentIds: number[],
  triggeringAgentId?: number,
): TurnCell {
  return { cellType, agentIds, hidden: false, isReaction: false, triggeringAgentId }
}

export interface ChatRoomTapes {
  /** After the user's message. */
  initial(): TurnTape
  /** Agents answering each other; `null` when there is nothing left to schedule. */
  followUp(roundNum: number): TurnTape | null
  /** Everyone the tapes can schedule, interrupt agents included. */
  readonly allAgents: readonly ChatRoomAgent[]
  readonly interruptAgents: readonly ChatRoomAgent[]
}

/**
 * @param agents Non-interrupt agents, which may include priority ones.
 * @param interruptAgents Agents with `interrupt_every_turn`, already sorted by
 *   descending priority — {@link separateInterruptAgents} does that.
 * @param shuffle Injectable, because the follow-up round shuffles the regular
 *   agents for a natural conversation order and a test needs that deterministic.
 */
export function createChatRoomTapes(
  agents: readonly ChatRoomAgent[],
  interruptAgents: readonly ChatRoomAgent[],
  shuffle: <T>(items: T[]) => T[] = shuffleInPlace,
): ChatRoomTapes {
  const [priorityAgents, regularAgents] = separatePriorityAgents(agents)

  /**
   * An interrupt cell, optionally minus one agent.
   *
   * The exclusion is self-interruption prevention: in a follow-up round an
   * interrupt agent's own turn would otherwise be followed by a cell containing
   * itself, and it would answer its own line.
   */
  function interruptCell(triggeringAgentId?: number, excludeAgentId?: number): TurnCell {
    const ids = interruptAgents.filter((a) => a.id !== excludeAgentId).map((a) => a.id)
    return cell('interrupt', ids, triggeringAgentId)
  }

  return {
    allAgents: [...agents, ...interruptAgents],
    interruptAgents,

    initial(): TurnTape {
      const cells: TurnCell[] = []

      // The interrupt agents answer the *user* before anyone else does; this
      // cell has no triggering agent because the user triggered it.
      if (interruptAgents.length > 0) {
        cells.push(cell('interrupt', interruptAgents.map((a) => a.id)))
      }

      for (const agent of priorityAgents) {
        cells.push(cell('sequential', [agent.id]))
        if (interruptAgents.length > 0 && !isTransparent(agent)) {
          cells.push(interruptCell(agent.id))
        }
      }

      if (regularAgents.length > 0) {
        cells.push(cell('concurrent', regularAgents.map((a) => a.id)))

        // One interrupt cell for the whole concurrent block rather than one per
        // agent — the block is a single beat in the conversation. Skipped
        // entirely when every regular agent is transparent, since none of them
        // is something to react to.
        const anyNonTransparent = regularAgents.some((a) => !isTransparent(a))
        if (interruptAgents.length > 0 && anyNonTransparent) {
          cells.push(cell('interrupt', interruptAgents.map((a) => a.id)))
        }
      }

      const tape = new TurnTape(cells)
      logger.info(`Generated initial tape: ${cells.length} cell(s)`)
      return tape
    },

    followUp(roundNum: number): TurnTape | null {
      // Everything is sequential here: the agents are talking to each other, so
      // each has to see the previous line. Priority agents keep their order;
      // the rest are shuffled so the same character does not always speak next.
      const ordered = [...priorityAgents, ...shuffle([...regularAgents])]
      if (ordered.length === 0) return null

      const cells: TurnCell[] = []
      for (const agent of ordered) {
        cells.push(cell('sequential', [agent.id]))
        if (interruptAgents.length > 0 && !isTransparent(agent)) {
          cells.push(interruptCell(agent.id, agent.id))
        }
      }

      logger.debug(`Generated follow-up tape (round ${roundNum + 1}): ${cells.length} cell(s)`)
      return new TurnTape(cells)
    },
  }
}

/** Fisher-Yates, in place, returning the same array. */
function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j] as T, items[i] as T]
  }
  return items
}
