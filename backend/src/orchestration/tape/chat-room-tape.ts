/**
 * The chat-room scheduler, the only one that mixes all three cell types.
 * **Priority** agents speak first, sequentially, descending; **regular** agents
 * then answer the user concurrently, since they all react to the same message;
 * **interrupt** agents speak after every other agent. **transparent** cuts
 * across all three — a transparent agent does not trigger the interrupt agents,
 * so a silent observer provokes no response to itself.
 */

import { separatePriorityAgents, type OrderableAgent } from '../agent-ordering'
import { getLogger } from '../../infrastructure/logging/logger'
import { TurnTape, type TurnCell } from './models'

const logger = getLogger('ChatRoomTape')

// All nullable: the columns carry no SQL DEFAULT, so a row written elsewhere can
// hold NULL.
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
  initial(): TurnTape
  /** Agents answering each other; `null` when there is nothing left to schedule. */
  followUp(roundNum: number): TurnTape | null
  readonly allAgents: readonly ChatRoomAgent[]
  readonly interruptAgents: readonly ChatRoomAgent[]
}

/**
 * @param interruptAgents Already sorted by descending priority.
 * @param shuffle Injectable so the follow-up round's shuffle is testable.
 */
export function createChatRoomTapes(
  agents: readonly ChatRoomAgent[],
  interruptAgents: readonly ChatRoomAgent[],
  shuffle: <T>(items: T[]) => T[] = shuffleInPlace,
): ChatRoomTapes {
  const [priorityAgents, regularAgents] = separatePriorityAgents(agents)

  // The exclusion prevents self-interruption: in a follow-up round an interrupt
  // agent's own turn would otherwise be followed by a cell containing itself.
  function interruptCell(triggeringAgentId?: number, excludeAgentId?: number): TurnCell {
    const ids = interruptAgents.filter((a) => a.id !== excludeAgentId).map((a) => a.id)
    return cell('interrupt', ids, triggeringAgentId)
  }

  return {
    allAgents: [...agents, ...interruptAgents],
    interruptAgents,

    initial(): TurnTape {
      const cells: TurnCell[] = []

      // No triggering agent: the user triggered this one.
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

        // One interrupt cell for the whole concurrent block: it is a single
        // beat. Skipped when every regular agent is transparent.
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
      // All sequential: the agents talk to each other, so each must see the
      // previous line. The non-priority ones are shuffled so the same character
      // does not always speak next.
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

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j] as T, items[i] as T]
  }
  return items
}
