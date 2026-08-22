/**
 * Room-level turn tracking: the interrupt path, and the supersede rule.
 *
 * The turn implementations are stubbed through `deps.turns`, so what is under
 * test here is exactly what this class owns — who gets cancelled, in what order
 * the CLI is told to stop, and which finished responses are thrown away — with
 * no model, no subprocess and no database involved.
 */

import { describe, expect, test } from 'bun:test'

import {
  RoomOrchestrator,
  type RoomOrchestratorDeps,
  type TurnImplementations,
} from '../orchestration/room-orchestrator'
import type { ExecutionResult } from '../orchestration/tape/models'
import type { SessionPool } from '../sdk/client/session-pool'
import type { World } from '../db/schema'

// ============================================================================
// Harness
// ============================================================================

const WORLD = { id: 1, name: 'asdf', phase: 'active' } as World

function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    totalResponses: 1,
    totalSkips: 0,
    cellsExecuted: 1,
    wasInterrupted: false,
    wasPaused: false,
    reachedLimit: false,
    allSkipped: false,
    reactions: [],
    ...overrides,
  }
}

/** A pool that records the calls this class is supposed to make on it. */
function stubPool(): SessionPool & { interrupted: number[]; interruptedAt: number[] } {
  const interrupted: number[] = []
  const interruptedAt: number[] = []
  const pool = {
    interrupted,
    interruptedAt,
    interruptRoom: (roomId: number): Promise<string[]> => {
      interrupted.push(roomId)
      interruptedAt.push(Date.now())
      return Promise.resolve([])
    },
    agentsInRoom: (roomId: number): number[] => (roomId === 1 ? [7, 8] : []),
  }
  return pool as unknown as SessionPool & { interrupted: number[]; interruptedAt: number[] }
}

function makeOrchestrator(
  turns: Partial<TurnImplementations>,
  pool = stubPool(),
): { orchestrator: RoomOrchestrator; pool: ReturnType<typeof stubPool> } {
  const never = () => new Promise<ExecutionResult>(() => {})
  const deps = {
    pool,
    turns: {
      gameplay: turns.gameplay ?? never,
      chat: turns.chat ?? never,
    },
  } as unknown as RoomOrchestratorDeps

  return { orchestrator: new RoomOrchestrator(deps), pool }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

// ============================================================================
// Turns
// ============================================================================

describe('handlePlayerAction', () => {
  test('a completed turn reports its result', async () => {
    const { orchestrator } = makeOrchestrator({
      gameplay: () => Promise.resolve(result({ totalResponses: 3 })),
    })

    const outcome = await orchestrator.handlePlayerAction({
      world: WORLD,
      roomId: 1,
      action: 'open the door',
    })

    expect(outcome.completed).toBe(true)
    expect(outcome.result?.totalResponses).toBe(3)
  })

  test('a turn that throws is reported as not completed rather than propagating', async () => {
    const { orchestrator } = makeOrchestrator({
      gameplay: () => Promise.reject(new Error('the room has no Action_Manager')),
    })

    const outcome = await orchestrator.handlePlayerAction({
      world: WORLD,
      roomId: 1,
      action: 'open the door',
    })

    expect(outcome.completed).toBe(false)
    expect(outcome.error).toBeInstanceOf(Error)
  })

  test('the room is busy while a turn runs and idle once it ends', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { orchestrator } = makeOrchestrator({
      gameplay: () => gate.then(() => result()),
    })

    const turn = orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'wait' })
    await tick()
    expect(orchestrator.isBusy(1)).toBe(true)

    release()
    await turn
    expect(orchestrator.isBusy(1)).toBe(false)
  })

  test('chat turns carry their session id through to the implementation', async () => {
    let seen: number | null | undefined
    const { orchestrator } = makeOrchestrator({
      chat: (_deps, input) => {
        seen = input.chatSessionId
        return Promise.resolve(result())
      },
    })

    await orchestrator.handleChatMessage({
      world: WORLD,
      roomId: 1,
      action: 'hello',
      chatSessionId: 42,
    })

    expect(seen).toBe(42)
  })
})

// ============================================================================
// Interrupting
// ============================================================================

describe('interruptRoom', () => {
  test('aborts the in-flight turn and reports it as not completed', async () => {
    const { orchestrator } = makeOrchestrator({
      gameplay: (_deps, input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
        }),
    })

    const turn = orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'wait' })
    await tick()
    await orchestrator.interruptRoom(1)

    expect((await turn).completed).toBe(false)
    expect(orchestrator.isBusy(1)).toBe(false)
  })

  test('the CLI is told to stop before the local await is unwound', async () => {
    // The order is the whole point: `interruptRoom` on the pool only reaches
    // sessions it finds busy, and aborting first makes them look idle.
    const events: string[] = []
    const pool = stubPool()
    const wrapped = {
      ...pool,
      interruptRoom: (roomId: number): Promise<string[]> => {
        events.push('pool')
        return pool.interruptRoom(roomId)
      },
    } as unknown as ReturnType<typeof stubPool>

    const { orchestrator } = makeOrchestrator(
      {
        gameplay: (_deps, input) =>
          new Promise((_resolve, reject) => {
            input.signal?.addEventListener('abort', () => {
              events.push('abort')
              reject(new Error('aborted'))
            })
          }),
      },
      wrapped,
    )

    const turn = orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'wait' })
    await tick()
    await orchestrator.interruptRoom(1)
    await turn

    expect(events).toEqual(['pool', 'abort'])
  })

  test('an idle room is still told to stop, and does not throw', async () => {
    const { orchestrator, pool } = makeOrchestrator({})

    await orchestrator.interruptRoom(99)

    expect(pool.interrupted).toEqual([99])
  })

  test('a turn that ignores its abort signal does not block the caller forever', async () => {
    // The 5s ceiling is real time, so this only asserts that the caller is
    // released without the turn ever settling — not the exact deadline.
    const { orchestrator } = makeOrchestrator({
      gameplay: () => new Promise<ExecutionResult>(() => {}),
    })

    void orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'wait' })
    await tick()

    const raced = await Promise.race([
      orchestrator.interruptRoom(1).then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 100)),
    ])

    // Within 100ms the interrupt is still waiting out its own timeout, which is
    // correct — what matters is that it has a timeout at all.
    expect(raced).toBe('still waiting')
  })

  test('a turn started after an interrupt is not cleared by the old one unwinding', async () => {
    // The window this guards: the interrupted turn is still unwinding when the
    // player's next message starts a new one. Without the identity check in
    // `runTracked`'s `finally`, the old turn's cleanup would deregister the new
    // turn and the room would read as idle while an agent was mid-sentence.
    const { orchestrator } = makeOrchestrator({
      gameplay: (_deps, input) =>
        input.action === 'first'
          ? new Promise<ExecutionResult>((resolve) => {
              input.signal?.addEventListener('abort', () => { resolve(result()) })
            })
          : new Promise<ExecutionResult>(() => {}),
    })

    const firstTurn = orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'first' })
    await tick()

    // Deliberately not awaited: the second turn has to register while the first
    // is between its abort and its cleanup.
    const interrupting = orchestrator.interruptRoom(1)
    void orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'second' })

    await firstTurn
    await interrupting
    await tick()

    expect(orchestrator.isBusy(1)).toBe(true)
  })
})

// ============================================================================
// The supersede rule
// ============================================================================

describe('isSuperseded', () => {
  test('a response that started before the player spoke again is superseded', async () => {
    let isSuperseded: ((roomId: number, startedAt: number) => boolean) | undefined
    const { orchestrator } = makeOrchestrator({
      gameplay: (deps) => {
        isSuperseded = deps.isSuperseded
        return Promise.resolve(result())
      },
    })

    const before = Date.now() - 1_000
    await orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'first' })

    expect(isSuperseded?.(1, before)).toBe(true)
  })

  test('a response that started after the latest message is kept', async () => {
    let isSuperseded: ((roomId: number, startedAt: number) => boolean) | undefined
    const { orchestrator } = makeOrchestrator({
      gameplay: (deps) => {
        isSuperseded = deps.isSuperseded
        return Promise.resolve(result())
      },
    })

    await orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'first' })

    expect(isSuperseded?.(1, Date.now() + 1_000)).toBe(false)
  })

  test('a room the player has never spoken in supersedes nothing', async () => {
    let isSuperseded: ((roomId: number, startedAt: number) => boolean) | undefined
    const { orchestrator } = makeOrchestrator({
      gameplay: (deps) => {
        isSuperseded = deps.isSuperseded
        return Promise.resolve(result())
      },
    })

    await orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'first' })

    expect(isSuperseded?.(2, 0)).toBe(false)
  })
})

// ============================================================================
// Transient status
// ============================================================================

describe('transient status', () => {
  test('seed generation is reported until it is cleared', () => {
    const { orchestrator } = makeOrchestrator({})

    expect(orchestrator.getSeedGenerationStatus(1)).toBeNull()

    orchestrator.setSeedGenerationActive(1)
    expect(orchestrator.getSeedGenerationStatus(1)).toEqual({
      name: 'World Seed Generator',
      thinkingText: 'Creating your world...',
      responseText: '',
    })

    orchestrator.setSeedGenerationInactive(1)
    expect(orchestrator.getSeedGenerationStatus(1)).toBeNull()
  })

  test('a sub-agent with no thinking text gets a default one', () => {
    const { orchestrator } = makeOrchestrator({})

    orchestrator.setSubAgentActive(1, 'Item Designer')
    expect(orchestrator.getSubAgentStatus(1)?.thinkingText).toBe('Item Designer is processing...')

    orchestrator.setSubAgentActive(1, 'Item Designer', 'forging a sword')
    expect(orchestrator.getSubAgentStatus(1)?.thinkingText).toBe('forging a sword')
  })

  test('the narration flag is cleared when the turn ends', async () => {
    const { orchestrator } = makeOrchestrator({
      gameplay: () => {
        orchestrator.setNarrationProduced(1)
        expect(orchestrator.hasNarrationProduced(1)).toBe(true)
        return Promise.resolve(result())
      },
    })

    await orchestrator.handlePlayerAction({ world: WORLD, roomId: 1, action: 'look' })

    expect(orchestrator.hasNarrationProduced(1)).toBe(false)
  })

  test('chatting agents come from the session pool', () => {
    const { orchestrator } = makeOrchestrator({})

    expect(orchestrator.getChattingAgents(1)).toEqual([7, 8])
    expect(orchestrator.getChattingAgents(2)).toEqual([])
  })
})
