/**
 * The turn tape: a fixed sequence of "cells", each naming the agents that run
 * in it. Cells run strictly in order; agents *within* a cell may run
 * concurrently. The gameplay tape is two cells — the NPCs react, and the Action
 * Manager narrates — but the first is *deferred*, so the two run side by side
 * and the Action Manager pulls the reactions in when it wants them.
 */

export type CellType = 'sequential' | 'concurrent' | 'interrupt'

export interface TurnCell {
  cellType: CellType
  agentIds: number[]
  /** Prose is not persisted; visible output is only what the tools write. */
  hidden: boolean
  /** Collect this cell's responses and hand them to the next cell. */
  isReaction: boolean
  /** For interrupt cells: the agent whose message triggered it, so it is skipped. */
  triggeringAgentId?: number
  /**
   * Start the cell but do not wait for it: the tape advances immediately and the
   * next cell runs alongside it, holding a {@link PendingReactions} handle it can
   * await when it is ready. Only meaningful together with `isReaction`. The
   * executor still awaits the cell before the tape finishes, so its responses are
   * counted and no agent is left running into the next turn.
   */
  deferred?: boolean
}

/** A deferred cell in flight, handed to the cells that run alongside it. */
export interface PendingReactions {
  /** Who is still speaking, so a prompt can name them before they answer. */
  agentIds: number[]
  reactions: Promise<AgentReaction[]>
}

// True only for a cell that needs `Promise.all`. A one-agent concurrent cell
// takes the sequential path: the concurrent path discards per-agent ordering.
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
  /** Ran and declined via `skip` — distinct from never having been asked. */
  skips: number
  reactions: AgentReaction[]
}

export interface AgentReaction {
  agentId: number
  agentName: string
  content: string
}

export interface ExecutionResult {
  totalResponses: number
  totalSkips: number
  cellsExecuted: number
  wasInterrupted: boolean
  wasPaused: boolean
  reachedLimit: boolean
  /** `responses === 0 && skips > 0` — an empty tape is no cast, not silence. */
  allSkipped: boolean
  reactions: AgentReaction[]
}
