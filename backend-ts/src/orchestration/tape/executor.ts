import {
  isConcurrent,
  type AgentReaction,
  type CellResult,
  type ExecutionResult,
  type TurnCell,
  type TurnTape,
} from './models'

/**
 * Runs a tape. Port of `orchestration/tape/executor.py`.
 *
 * The executor knows nothing about the SDK or the database. It is handed a
 * `respond` function and a few predicates, which is what makes a turn testable
 * without a live model: the pilot passes the real generator, tests pass a stub.
 * Python reached into `crud` and `response_generator` from inside the loop and
 * could only be tested end-to-end.
 */

export interface RespondArgs {
  agentId: number
  userMessage: string
  hidden: boolean
  /** Reactions collected from earlier cells; only the Action Manager cell gets these. */
  npcReactions?: AgentReaction[]
  signal?: AbortSignal
}

export interface RespondResult {
  responded: boolean
  responseText: string
  agentName: string
}

export interface ExecutorDeps {
  respond(args: RespondArgs): Promise<RespondResult>
  /** Re-read pause state between cells; a paused room stops the tape. */
  isPaused(): Promise<boolean> | boolean
  /**
   * The room's own `max_interactions` ceiling, re-counted between cells.
   *
   * Separate from `maxTotalMessages`, which is the executor's runaway guard.
   * This one is a per-room setting a user can configure, counted against the
   * agent messages already in the room rather than against this turn — so a
   * room can start a turn already over its limit and stop before the first cell.
   * Omitted by callers that do not expose the setting.
   */
  isInteractionLimitReached?(): Promise<boolean> | boolean
  /**
   * Re-resolve the room after a hidden cell.
   *
   * The `travel` tool moves the player to a different location, and each
   * location is its own room — so a cell can change where the *next* cell's
   * messages belong. Python did this after every hidden cell for the same reason.
   */
  onCellComplete?(cell: TurnCell): Promise<void> | void
}

export interface ExecuteOptions {
  userMessage: string
  signal?: AbortSignal
  /** Safety valve against a runaway tape. Python's default was 30. */
  maxTotalMessages?: number
}

export class TapeExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(tape: TurnTape, opts: ExecuteOptions): Promise<ExecutionResult> {
    const maxTotalMessages = opts.maxTotalMessages ?? 30
    const collected: AgentReaction[] = []
    let totalResponses = 0
    let totalSkips = 0
    let cellsExecuted = 0
    let visibleMessages = 0
    let wasInterrupted = false
    let wasPaused = false
    let reachedLimit = false

    while (!tape.isExhausted()) {
      const cell = tape.current
      if (!cell) break

      if (opts.signal?.aborted) {
        wasInterrupted = true
        tape.cutAtCurrent()
        break
      }
      if (await this.deps.isPaused()) {
        wasPaused = true
        break
      }
      if (visibleMessages >= maxTotalMessages) {
        reachedLimit = true
        break
      }
      if (await this.deps.isInteractionLimitReached?.()) {
        reachedLimit = true
        break
      }

      const result = await this.executeCell(cell, opts, collected)
      cellsExecuted++
      totalResponses += result.responses
      totalSkips += result.skips
      if (cell.isReaction) collected.push(...result.reactions)
      // Hidden cells persist nothing, so they cannot advance a limit that counts
      // messages. Without this a two-cell hidden turn would consume the budget
      // for messages it never wrote.
      if (!cell.hidden) visibleMessages += result.responses

      await this.deps.onCellComplete?.(cell)
      tape.advance()
    }

    return {
      totalResponses,
      totalSkips,
      cellsExecuted,
      wasInterrupted,
      wasPaused,
      reachedLimit,
      allSkipped: totalResponses === 0 && totalSkips > 0,
      reactions: collected,
    }
  }

  private async executeCell(
    cell: TurnCell,
    opts: ExecuteOptions,
    collected: AgentReaction[],
  ): Promise<CellResult> {
    // Only the non-reaction cell is given the reactions — a reaction cell would
    // otherwise be shown its own siblings' output mid-flight.
    const npcReactions = cell.isReaction ? undefined : collected

    const run = (agentId: number): Promise<RespondResult> =>
      this.deps.respond({
        agentId,
        userMessage: opts.userMessage,
        hidden: cell.hidden,
        npcReactions,
        signal: opts.signal,
      })

    const agentIds = cell.agentIds.filter((id) => id !== cell.triggeringAgentId)

    let outcomes: Array<PromiseSettledResult<RespondResult>>
    if (isConcurrent(cell)) {
      outcomes = await Promise.allSettled(agentIds.map(run))
    } else {
      outcomes = []
      for (const id of agentIds) {
        if (opts.signal?.aborted) break
        outcomes.push(await settle(run(id)))
      }
    }

    const reactions: AgentReaction[] = []
    let responses = 0
    let skips = 0

    for (const [index, outcome] of outcomes.entries()) {
      // A failed agent does not fail the cell: one NPC whose session died should
      // not cost the player their turn. The others still react and the Action
      // Manager still narrates. It is not counted as a skip either — a crash is
      // not a character choosing silence.
      if (outcome.status === 'rejected') continue
      const { responded, responseText, agentName } = outcome.value
      if (!responded) {
        skips++
        continue
      }
      responses++
      if (cell.isReaction && responseText) {
        reactions.push({ agentId: agentIds[index]!, agentName, content: responseText })
      }
    }

    return { responses, skips, reactions }
  }
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await promise }
  } catch (reason) {
    return { status: 'rejected', reason }
  }
}
