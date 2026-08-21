/**
 * The turn tape. Port of `orchestration/tape/models.py`.
 *
 * A turn is a fixed sequence of "cells", each naming the agents that run in it.
 * Cells run strictly in order; agents *within* a cell may run concurrently. The
 * gameplay tape is exactly two cells — the NPCs at the player's location react,
 * then the Action Manager narrates with those reactions in hand.
 */

export type CellType = 'sequential' | 'concurrent' | 'interrupt'

export interface TurnCell {
  cellType: CellType
  agentIds: number[]
  /**
   * The agents' prose is not persisted as messages.
   *
   * "Hidden" is not a flag on a stored row — it is the absence of a row. A
   * hidden agent's visible output, if any, is whatever its tools write. Both
   * gameplay cells are hidden: NPC reactions feed the Action Manager, and the
   * Action Manager speaks only through the `narration` tool.
   */
  hidden: boolean
  /** Collect this cell's responses and hand them to the next cell. */
  isReaction: boolean
  /** For interrupt cells: the agent whose message triggered it, so it is skipped. */
  triggeringAgentId?: number
}

/**
 * True only for a cell that genuinely needs `Promise.all`.
 *
 * A one-agent concurrent cell runs down the sequential path; Python had the same
 * rule, and it matters because the concurrent path assumes it can discard
 * per-agent ordering.
 */
export function isConcurrent(cell: TurnCell): boolean {
  return cell.agentIds.length > 1 && cell.cellType === 'concurrent'
}

export class TurnTape {
  position = 0

  constructor(readonly cells: TurnCell[]) {}

  get current(): TurnCell | undefined {
    return this.cells[this.position]
  }

  isExhausted(): boolean {
    return this.position >= this.cells.length
  }

  advance(): void {
    this.position++
  }

  /** Drop everything from the current position on — used when a turn is cancelled. */
  cutAtCurrent(): void {
    this.cells.length = this.position
  }
}

export interface CellResult {
  responses: number
  reactions: AgentReaction[]
  allSkipped: boolean
}

export interface AgentReaction {
  agentId: number
  agentName: string
  content: string
}

export interface ExecutionResult {
  totalResponses: number
  cellsExecuted: number
  wasInterrupted: boolean
  wasPaused: boolean
  reachedLimit: boolean
  allSkipped: boolean
  reactions: AgentReaction[]
}
