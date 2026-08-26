import {
  isConcurrent,
  type AgentReaction,
  type CellResult,
  type ExecutionResult,
  type PendingReactions,
  type TurnCell,
  type TurnTape,
} from './models'

/**
 * Runs a tape. Knows nothing about the SDK or the database — it is handed a
 * `respond` function and a few predicates, which is what makes a turn testable
 * without a live model.
 */

export interface RespondArgs {
  agentId: number
  userMessage: string
  hidden: boolean
  /** From earlier cells; only the Action Manager cell receives these. */
  npcReactions?: AgentReaction[]
  /**
   * A deferred cell that is still running. The Action Manager is started next to
   * the NPCs rather than after them, so it gets a promise instead of an array
   * and decides for itself when to wait on it.
   */
  pendingReactions?: PendingReactions
  signal?: AbortSignal
}

export interface RespondResult {
  responded: boolean
  responseText: string
  agentName: string
}

export interface ExecutorDeps {
  respond(args: RespondArgs): Promise<RespondResult>
  /** Re-read between cells; a paused room stops the tape. */
  isPaused(): Promise<boolean> | boolean
  /**
   * The room's own `max_interactions` ceiling, separate from `maxTotalMessages`.
   * It counts the agent messages already in the room rather than this turn's, so
   * a room can start already over its limit and stop before the first cell.
   */
  isInteractionLimitReached?(): Promise<boolean> | boolean
  /** `travel` moves the player, so a hidden cell can change where the next writes. */
  onCellComplete?(cell: TurnCell): Promise<void> | void
}

export interface ExecuteOptions {
  userMessage: string
  signal?: AbortSignal
  /** Safety valve against a runaway tape. */
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

    // At most one deferred cell is in flight; the gameplay tape has exactly one,
    // and a second would leave the cells after it unable to say which promise
    // they were handed.
    let deferred: { cell: TurnCell; result: Promise<CellResult> } | null = null
    let pending: PendingReactions | undefined

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

      if (cell.deferred && !deferred) {
        // Started, not awaited. The `catch` is what keeps the rejection observed
        // while the next cell is still writing — an unhandled one would take the
        // process down long before anybody asked for the reactions.
        const inFlight = this.executeCell(cell, opts, collected, undefined).catch(
          (): CellResult => ({ responses: 0, skips: 0, reactions: [] }),
        )
        deferred = { cell, result: inFlight }
        pending = { agentIds: [...cell.agentIds], reactions: inFlight.then((r) => r.reactions) }
        cellsExecuted++
        tape.advance()
        continue
      }

      const result = await this.executeCell(cell, opts, collected, pending)
      cellsExecuted++
      totalResponses += result.responses
      totalSkips += result.skips
      if (cell.isReaction) collected.push(...result.reactions)
      // Hidden cells persist nothing, so they must not spend a message budget.
      if (!cell.hidden) visibleMessages += result.responses

      await this.deps.onCellComplete?.(cell)
      tape.advance()
    }

    // The tape has stopped writing, but the deferred cell may not have stopped
    // running — and a turn that returns with agents still generating races the
    // next one for their sessions. Awaited even when the tape was cut short: the
    // work was already dispatched, and its reactions belong to this result
    // whether or not the Action Manager ever asked for them.
    if (deferred) {
      const result = await deferred.result
      totalResponses += result.responses
      totalSkips += result.skips
      if (deferred.cell.isReaction) collected.push(...result.reactions)
      if (!deferred.cell.hidden) visibleMessages += result.responses
      await this.deps.onCellComplete?.(deferred.cell)
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
    pending: PendingReactions | undefined,
  ): Promise<CellResult> {
    // Only the non-reaction cell gets them; a reaction cell would otherwise see
    // its own siblings' output mid-flight.
    const npcReactions = cell.isReaction ? undefined : collected
    const pendingReactions = cell.isReaction ? undefined : pending

    const run = (agentId: number): Promise<RespondResult> =>
      this.deps.respond({
        agentId,
        userMessage: opts.userMessage,
        hidden: cell.hidden,
        npcReactions,
        pendingReactions,
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
      // A failed agent does not fail the cell — one NPC whose session died must
      // not cost the player their turn — and is not counted as a skip either,
      // since a crash is not a character choosing silence.
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
