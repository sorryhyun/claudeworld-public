/**
 * Tape construction and execution.
 *
 * The executor is deliberately testable without a live model: it takes a
 * `respond` function, so a stub here exercises the ordering, the limits and the
 * cancellation rules that a real turn would otherwise hide behind a subprocess.
 */

import { describe, expect, test } from 'bun:test'

import { createChatModeTape, type ChatTapeAgent } from '@/orchestration/tape/chat-tape'
import { TapeExecutor, type ExecutorDeps, type RespondResult } from '@/orchestration/tape/executor'
import { createGameplayTape, createOnboardingTape } from '@/orchestration/tape/gameplay-tape'
import { TurnTape, type TurnCell } from '@/orchestration/tape/models'

// ============================================================================
// Helpers
// ============================================================================

function npc(id: number, overrides: Partial<ChatTapeAgent> = {}): ChatTapeAgent {
  return { id, priority: 0, interruptEveryTurn: false, ...overrides }
}

/** Agent ids in the order the tape would run them, one cell at a time. */
function cellAgentIds(tape: TurnTape | null): number[][] {
  return (tape?.cells ?? []).map((c) => c.agentIds)
}

interface StubOptions {
  /** Agents that decline to speak, by id. */
  skips?: number[]
  /** Agents that throw, by id — a dead session, not a skip. */
  fails?: number[]
  onRespond?: (agentId: number) => void
}

/** Records the order agents were asked in, and answers as configured. */
function stubResponder(options: StubOptions = {}): {
  order: number[]
  respond: ExecutorDeps['respond']
} {
  const order: number[] = []
  const skips = new Set(options.skips ?? [])
  const fails = new Set(options.fails ?? [])

  return {
    order,
    respond: ({ agentId }): Promise<RespondResult> => {
      order.push(agentId)
      options.onRespond?.(agentId)
      if (fails.has(agentId)) return Promise.reject(new Error(`agent ${agentId} died`))
      return Promise.resolve({
        responded: !skips.has(agentId),
        responseText: skips.has(agentId) ? '' : `reply from ${agentId}`,
        agentName: `agent-${agentId}`,
      })
    },
  }
}

function cell(agentIds: number[], overrides: Partial<TurnCell> = {}): TurnCell {
  return { cellType: 'sequential', agentIds, hidden: false, isReaction: false, ...overrides }
}

// ============================================================================
// Chat-mode tape
// ============================================================================

describe('createChatModeTape', () => {
  test('an empty location yields no tape at all', () => {
    expect(createChatModeTape([])).toBeNull()
  })

  test('every NPC gets its own cell, so each sees the replies before it', () => {
    expect(cellAgentIds(createChatModeTape([npc(1), npc(2), npc(3)]))).toEqual([[1], [2], [3]])
  })

  test('regular NPCs run in descending priority', () => {
    const tape = createChatModeTape([
      npc(1, { priority: 1 }),
      npc(2, { priority: 9 }),
      npc(3, { priority: 5 }),
    ])
    expect(cellAgentIds(tape)).toEqual([[2], [3], [1]])
  })

  test('equal priorities keep the roster order rather than being reshuffled', () => {
    const tape = createChatModeTape([npc(7), npc(3), npc(5)])
    expect(cellAgentIds(tape)).toEqual([[7], [3], [5]])
  })

  test('interrupt-every-turn NPCs run last, so they can have the last word', () => {
    const tape = createChatModeTape([
      npc(1, { interruptEveryTurn: true, priority: 1 }),
      npc(2, { priority: 9 }),
      npc(3, { interruptEveryTurn: true, priority: 4 }),
    ])
    expect(cellAgentIds(tape)).toEqual([[2], [3], [1]])
    expect(tape?.cells.map((c) => c.cellType)).toEqual(['sequential', 'interrupt', 'interrupt'])
  })

  test('a null priority is zero and a null flag is false, not NaN and not truthy', () => {
    const tape = createChatModeTape([
      npc(1, { priority: null, interruptEveryTurn: null }),
      npc(2, { priority: 3 }),
    ])
    expect(cellAgentIds(tape)).toEqual([[2], [1]])
  })

  test('chat cells are visible and are not reaction cells', () => {
    const cells = createChatModeTape([npc(1)])?.cells ?? []
    expect(cells[0]?.hidden).toBe(false)
    expect(cells[0]?.isReaction).toBe(false)
  })
})

// ============================================================================
// Gameplay and onboarding tapes
// ============================================================================

describe('createGameplayTape', () => {
  test('no Action Manager means no tape — the caller decides what that means', () => {
    expect(createGameplayTape(null, [1, 2])).toBeNull()
  })

  test('NPCs react concurrently and hidden, then the Action Manager runs alone', () => {
    const cells = createGameplayTape(99, [1, 2])?.cells ?? []

    expect(cells).toHaveLength(2)
    expect(cells[0]).toMatchObject({ cellType: 'concurrent', agentIds: [1, 2], hidden: true, isReaction: true })
    expect(cells[1]).toMatchObject({ cellType: 'sequential', agentIds: [99], hidden: true, isReaction: false })
  })

  test('an empty location skips the reaction cell entirely', () => {
    expect(cellAgentIds(createGameplayTape(99, []))).toEqual([[99]])
  })
})

describe('createOnboardingTape', () => {
  test('one cell, one agent', () => {
    expect(cellAgentIds(createOnboardingTape(42))).toEqual([[42]])
  })

  test('the interview is visible — unlike every gameplay cell', () => {
    expect(createOnboardingTape(42)?.cells[0]?.hidden).toBe(false)
  })

  test('no Onboarding Manager means no tape', () => {
    expect(createOnboardingTape(null)).toBeNull()
  })
})

// ============================================================================
// Executor
// ============================================================================

describe('TapeExecutor', () => {
  test('cells run in order and every response is counted', async () => {
    const stub = stubResponder()
    const result = await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([1]), cell([2]), cell([3])]),
      { userMessage: 'hello' },
    )

    expect(stub.order).toEqual([1, 2, 3])
    expect(result.totalResponses).toBe(3)
    expect(result.cellsExecuted).toBe(3)
    expect(result.allSkipped).toBe(false)
  })

  test('a multi-agent concurrent cell runs its agents together', async () => {
    let inFlight = 0
    let peak = 0
    const respond = ({ agentId }: { agentId: number }): Promise<RespondResult> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight--
          resolve({ responded: true, responseText: 'x', agentName: `a-${agentId}` })
        }, 5),
      )
    }

    await new TapeExecutor({ isPaused: () => false, respond }).execute(
      new TurnTape([cell([1, 2, 3], { cellType: 'concurrent' })]),
      { userMessage: 'hello' },
    )

    expect(peak).toBe(3)
  })

  test('a one-agent concurrent cell takes the sequential path', async () => {
    // Not observable from the outside except that it works at all; the rule
    // exists because the concurrent path discards per-agent ordering.
    const stub = stubResponder()
    const result = await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([1], { cellType: 'concurrent' })]),
      { userMessage: 'hello' },
    )
    expect(result.totalResponses).toBe(1)
  })

  test('reactions are collected and handed to the next cell, never to siblings', async () => {
    const seen: Array<string[] | undefined> = []
    const respond = ({
      agentId,
      npcReactions,
    }: {
      agentId: number
      npcReactions?: Array<{ content: string }>
    }): Promise<RespondResult> => {
      seen.push(npcReactions?.map((r) => r.content))
      return Promise.resolve({
        responded: true,
        responseText: `reply from ${agentId}`,
        agentName: `a-${agentId}`,
      })
    }

    await new TapeExecutor({ isPaused: () => false, respond }).execute(
      new TurnTape([cell([1, 2], { cellType: 'concurrent', isReaction: true }), cell([9])]),
      { userMessage: 'hello' },
    )

    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toBeUndefined()
    expect(seen[2]).toEqual(['reply from 1', 'reply from 2'])
  })

  test('a skip is counted as a skip, and an all-skip turn says so', async () => {
    const stub = stubResponder({ skips: [1, 2] })
    const result = await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([1]), cell([2])]),
      { userMessage: 'hello' },
    )

    expect(result.totalResponses).toBe(0)
    expect(result.totalSkips).toBe(2)
    expect(result.allSkipped).toBe(true)
  })

  test('a tape with nobody in it is not "all skipped" — there was no cast', async () => {
    const stub = stubResponder()
    const result = await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([])]),
      { userMessage: 'hello' },
    )

    expect(result.totalSkips).toBe(0)
    expect(result.allSkipped).toBe(false)
  })

  test('one agent throwing does not cost the others their turn, and is not a skip', async () => {
    const stub = stubResponder({ fails: [2] })
    const result = await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([1, 2, 3], { cellType: 'concurrent' })]),
      { userMessage: 'hello' },
    )

    expect(result.totalResponses).toBe(2)
    expect(result.totalSkips).toBe(0)
  })

  test('a pause between cells stops the tape where it stands', async () => {
    let paused = false
    const stub = stubResponder({ onRespond: (id) => { if (id === 1) paused = true } })

    const result = await new TapeExecutor({ isPaused: () => paused, respond: stub.respond }).execute(
      new TurnTape([cell([1]), cell([2])]),
      { userMessage: 'hello' },
    )

    expect(stub.order).toEqual([1])
    expect(result.wasPaused).toBe(true)
  })

  test('hidden cells do not consume the visible-message budget', async () => {
    const stub = stubResponder()
    const result = await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([1], { hidden: true }), cell([2], { hidden: true }), cell([3])]),
      { userMessage: 'hello', maxTotalMessages: 1 },
    )

    expect(stub.order).toEqual([1, 2, 3])
    expect(result.reachedLimit).toBe(false)
  })

  test('visible responses do, and the tape stops once the budget is spent', async () => {
    const stub = stubResponder()
    const result = await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([1]), cell([2])]),
      { userMessage: 'hello', maxTotalMessages: 1 },
    )

    expect(stub.order).toEqual([1])
    expect(result.reachedLimit).toBe(true)
  })

  test("the room's own interaction ceiling can stop a tape before its first cell", async () => {
    const stub = stubResponder()
    const result = await new TapeExecutor({
      isPaused: () => false,
      isInteractionLimitReached: () => true,
      respond: stub.respond,
    }).execute(new TurnTape([cell([1])]), { userMessage: 'hello' })

    expect(stub.order).toEqual([])
    expect(result.reachedLimit).toBe(true)
  })

  test('an abort stops the tape and cuts the cells that never ran', async () => {
    const controller = new AbortController()
    const stub = stubResponder({ onRespond: (id) => { if (id === 1) controller.abort() } })
    const tape = new TurnTape([cell([1]), cell([2]), cell([3])])

    const result = await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      tape,
      { userMessage: 'hello', signal: controller.signal },
    )

    expect(stub.order).toEqual([1])
    expect(result.wasInterrupted).toBe(true)
    // Everything from the aborted position on is gone, so a resumed tape cannot
    // silently replay half a turn.
    expect(tape.cells).toHaveLength(1)
  })

  test('an abort mid-cell stops the remaining agents in that cell', async () => {
    const controller = new AbortController()
    const stub = stubResponder({ onRespond: (id) => { if (id === 1) controller.abort() } })

    await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([1, 2, 3])]),
      { userMessage: 'hello', signal: controller.signal },
    )

    expect(stub.order).toEqual([1])
  })

  test('an interrupt cell skips the agent whose message triggered it', async () => {
    const stub = stubResponder()
    await new TapeExecutor({ isPaused: () => false, respond: stub.respond }).execute(
      new TurnTape([cell([1, 2, 3], { cellType: 'interrupt', triggeringAgentId: 2 })]),
      { userMessage: 'hello' },
    )

    expect(stub.order).toEqual([1, 3])
  })

  test('onCellComplete runs after each cell — this is the travel re-resolution hook', async () => {
    const completed: number[][] = []
    const stub = stubResponder()

    await new TapeExecutor({
      isPaused: () => false,
      respond: stub.respond,
      onCellComplete: (c) => { completed.push(c.agentIds) },
    }).execute(new TurnTape([cell([1]), cell([2])]), { userMessage: 'hello' })

    expect(completed).toEqual([[1], [2]])
  })
})
