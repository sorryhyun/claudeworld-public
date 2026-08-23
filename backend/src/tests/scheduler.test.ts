/**
 * The background scheduler: which rooms it picks, and what it does when a tick
 * overruns its own interval.
 *
 * The orchestrator is stubbed — everything the scheduler owns is room selection
 * and tick discipline, so no model, no session pool and no tape are involved.
 * The interval is driven by calling `tick()` directly rather than by sleeping:
 * the suite runs under `bun test --parallel` and a 2-second wait would dominate
 * the whole run.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, type Db } from '@/db'
import { openAndInitDb } from '@/db/migrate'
import { agents, messages, roomAgents, rooms, worlds } from '@/db/schema'
import { getCache } from '@/infrastructure/cache'
import {
  ACTIVE_WINDOW_MS,
  BackgroundScheduler,
  type SchedulerOrchestrator,
} from '@/infrastructure/scheduler'
import {
  RoomOrchestrator,
  type RoomOrchestratorDeps,
  type TurnImplementations,
} from '@/orchestration/room-orchestrator'
import type { ExecutionResult } from '@/orchestration/tape/models'
import { runAutonomousRound, type TurnDeps } from '@/orchestration/turn'

const OWNER = 'admin'
const WORLD_ID = 1

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-sched-'))
  const created = openAndInitDb({ path: join(dir, 'test.db') })
  created.close()

  db = openDb({ path: join(dir, 'test.db') })

  db.insert(worlds)
    .values({ id: WORLD_ID, name: 'testworld', ownerId: OWNER, phase: 'active', language: 'en' })
    .run()
  db.insert(agents)
    .values([
      { id: 1, name: 'Kurisu', systemPrompt: 'p' },
      { id: 2, name: 'Okabe', systemPrompt: 'p' },
      { id: 3, name: 'Mayuri', systemPrompt: 'p' },
    ])
    .run()

  getCache().clear()
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

// ============================================================================
// Fixtures
// ============================================================================

interface RoomOptions {
  id: number
  /** Milliseconds ago; defaults to "just now". */
  activeMsAgo?: number
  isPaused?: boolean
  isFinished?: boolean
  worldId?: number | null
  agentIds?: number[]
}

function room({
  id,
  activeMsAgo = 0,
  isPaused = false,
  isFinished = false,
  worldId = null,
  agentIds = [1, 2],
}: RoomOptions): number {
  db.insert(rooms)
    .values({
      id,
      name: `room-${id}`,
      ownerId: OWNER,
      worldId,
      isPaused,
      isFinished,
      createdAt: new Date(),
      lastActivityAt: new Date(Date.now() - activeMsAgo),
    })
    .run()

  for (const agentId of agentIds) {
    db.insert(roomAgents).values({ roomId: id, agentId, joinedAt: new Date() }).run()
  }
  return id
}

/** Records every room it is handed, and answers however the test says. */
function stubOrchestrator(
  handle: (roomId: number) => Promise<void> = () => Promise.resolve(),
): SchedulerOrchestrator & { seen: number[]; swept: number } {
  const stub = {
    seen: [] as number[],
    swept: 0,
    async handleAutonomousRound(roomId: number): Promise<{ skipped?: boolean }> {
      stub.seen.push(roomId)
      await handle(roomId)
      return {}
    },
    cleanupStaleEntries(): number {
      stub.swept++
      return 0
    },
  }
  return stub
}

function makeScheduler(
  orchestrator: SchedulerOrchestrator,
  maxConcurrentRooms = 5,
): BackgroundScheduler {
  return new BackgroundScheduler({ db, orchestrator, maxConcurrentRooms })
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

// ============================================================================
// Active-room selection
// ============================================================================

describe('activeRooms', () => {
  test('picks a recently-active, unpaused, unfinished chat room with 2 agents', () => {
    room({ id: 10 })

    expect(makeScheduler(stubOrchestrator()).activeRooms().map((r) => r.id)).toEqual([10])
  })

  test('skips a paused room', () => {
    room({ id: 10, isPaused: true })

    expect(makeScheduler(stubOrchestrator()).activeRooms()).toEqual([])
  })

  test('skips a finished room', () => {
    room({ id: 10, isFinished: true })

    expect(makeScheduler(stubOrchestrator()).activeRooms()).toEqual([])
  })

  test('skips a room whose last activity is outside the 5-minute window', () => {
    room({ id: 10, activeMsAgo: ACTIVE_WINDOW_MS + 60_000 })
    room({ id: 11, activeMsAgo: ACTIVE_WINDOW_MS - 60_000 })

    expect(makeScheduler(stubOrchestrator()).activeRooms().map((r) => r.id)).toEqual([11])
  })

  test('skips a TRPG game room — world_id IS NULL is what separates the two modes', () => {
    room({ id: 10, worldId: WORLD_ID })
    room({ id: 11 })

    expect(makeScheduler(stubOrchestrator()).activeRooms().map((r) => r.id)).toEqual([11])
  })

  test('skips rooms with fewer than 2 agents', () => {
    room({ id: 10, agentIds: [] })
    room({ id: 11, agentIds: [1] })
    room({ id: 12, agentIds: [1, 2, 3] })

    expect(makeScheduler(stubOrchestrator()).activeRooms().map((r) => r.id)).toEqual([12])
  })

  test('orders by last activity, most recent first', () => {
    room({ id: 10, activeMsAgo: 30_000 })
    room({ id: 11, activeMsAgo: 1_000 })
    room({ id: 12, activeMsAgo: 60_000 })

    expect(makeScheduler(stubOrchestrator()).activeRooms().map((r) => r.id)).toEqual([11, 10, 12])
  })

  test('caps the selection at maxConcurrentRooms, keeping the most recent', () => {
    room({ id: 10, activeMsAgo: 30_000 })
    room({ id: 11, activeMsAgo: 1_000 })
    room({ id: 12, activeMsAgo: 60_000 })

    expect(
      makeScheduler(stubOrchestrator(), 2)
        .activeRooms()
        .map((r) => r.id),
    ).toEqual([11, 10])
  })

  test('the agent-count filter runs after the cap, as in Python', () => {
    // The two most recent rooms are one-agent rooms, so the cap consumes them
    // and the older two-agent room is not reached. Reproduced deliberately:
    // Python limits the room query and only then counts agents.
    room({ id: 10, activeMsAgo: 60_000 })
    room({ id: 11, activeMsAgo: 1_000, agentIds: [1] })

    expect(
      makeScheduler(stubOrchestrator(), 1)
        .activeRooms()
        .map((r) => r.id),
    ).toEqual([])
  })
})

// ============================================================================
// Ticks
// ============================================================================

describe('tick', () => {
  test('hands every active room to the orchestrator', async () => {
    room({ id: 10 })
    room({ id: 11 })
    const orchestrator = stubOrchestrator()

    await makeScheduler(orchestrator).tick()

    expect(orchestrator.seen.sort()).toEqual([10, 11])
  })

  test('a tick that fires while the previous one runs is skipped, not queued', async () => {
    room({ id: 10 })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const orchestrator = stubOrchestrator(() => gate)
    const scheduler = makeScheduler(orchestrator)

    const first = scheduler.tick()
    await tick()

    // Three more ticks land while the first is still inside the orchestrator.
    await scheduler.tick()
    await scheduler.tick()
    await scheduler.tick()
    expect(orchestrator.seen).toEqual([10])

    release()
    await first

    // And the skipped ticks were dropped rather than deferred: the next tick
    // processes the room once, not four times.
    await scheduler.tick()
    expect(orchestrator.seen).toEqual([10, 10])
  })

  test('a room that throws does not stop the other rooms or the tick', async () => {
    room({ id: 10 })
    room({ id: 11 })
    const orchestrator = stubOrchestrator((roomId) =>
      roomId === 10 ? Promise.reject(new Error('session died')) : Promise.resolve(),
    )
    const scheduler = makeScheduler(orchestrator)

    await scheduler.tick()

    expect(orchestrator.seen.sort()).toEqual([10, 11])
    // The failure is contained, so the scheduler keeps ticking.
    await scheduler.tick()
    expect(orchestrator.seen).toHaveLength(4)
  })

  test('a tick with no active rooms touches nothing', async () => {
    room({ id: 10, isPaused: true })
    const orchestrator = stubOrchestrator()

    await makeScheduler(orchestrator).tick()

    expect(orchestrator.seen).toEqual([])
  })

  test('maxConcurrentRooms bounds both the selection and the in-flight rounds', async () => {
    for (const id of [10, 11, 12, 13]) room({ id, activeMsAgo: id })
    let active = 0
    let peak = 0
    const gates: Array<() => void> = []
    const orchestrator = stubOrchestrator(
      () =>
        new Promise<void>((resolve) => {
          active++
          peak = Math.max(peak, active)
          gates.push(() => {
            active--
            resolve()
          })
        }),
    )
    const scheduler = makeScheduler(orchestrator, 2)

    const running = scheduler.tick()
    await tick()
    expect(peak).toBe(2)

    while (gates.length > 0) {
      gates.shift()?.()
      await tick()
    }
    await running

    // Four rooms are eligible; the LIMIT takes two of them and the semaphore
    // holds the tick to two at a time. Python applies the same number twice for
    // the same reason, so the semaphore only ever bites on a tick that overruns.
    expect(peak).toBe(2)
    expect(orchestrator.seen).toHaveLength(2)
  })
})

// ============================================================================
// Lifecycle
// ============================================================================

describe('start / stop', () => {
  test('start is idempotent and stop clears the timers', async () => {
    const scheduler = makeScheduler(stubOrchestrator())

    scheduler.start()
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)

    await scheduler.stop()
    expect(scheduler.isRunning).toBe(false)
  })

  test('stop on a scheduler that never started is a no-op', async () => {
    await makeScheduler(stubOrchestrator()).stop()
  })

  test('stop waits for the tick already in flight', async () => {
    room({ id: 10 })
    let finished = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const orchestrator = stubOrchestrator(() =>
      gate.then(() => {
        finished = true
      }),
    )
    const scheduler = makeScheduler(orchestrator)
    scheduler.start()

    const running = scheduler.tick()
    await tick()

    const stopped = scheduler.stop()
    release()
    await stopped
    await running

    expect(finished).toBe(true)
  })

  test('the timers actually fire once started', async () => {
    room({ id: 10 })
    const orchestrator = stubOrchestrator()
    const scheduler = new BackgroundScheduler({
      db,
      orchestrator,
      maxConcurrentRooms: 5,
      processIntervalMs: 1,
      cleanupIntervalMs: 1,
    })

    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await scheduler.stop()

    expect(orchestrator.seen.length).toBeGreaterThan(0)
    expect(orchestrator.swept).toBeGreaterThan(0)
  })
})

// ============================================================================
// The round itself
//
// Only the paths that decide *whether* a round runs are exercised here: the
// tape a round executes is `chat-room-tape.ts`'s follow-up round, already
// covered by `chat-room-tape.test.ts`, and executing it for real would need a
// session pool and a model.
// ============================================================================

describe('runAutonomousRound', () => {
  const deps = (): TurnDeps => ({ db }) as unknown as TurnDeps

  test('a room with fewer than 2 agents schedules nothing', async () => {
    room({ id: 10, agentIds: [1] })

    const result = await runAutonomousRound(deps(), { roomId: 10 })

    expect(result.cellsExecuted).toBe(0)
    expect(result.reachedLimit).toBe(false)
  })

  test('a room at its max_interactions ceiling reports reachedLimit', async () => {
    room({ id: 10 })
    db.update(rooms).set({ maxInteractions: 2 }).where(eq(rooms.id, 10)).run()
    for (const agentId of [1, 2]) {
      db.insert(messages)
        .values({ roomId: 10, agentId, content: 'hi', role: 'assistant', timestamp: new Date() })
        .run()
    }

    const result = await runAutonomousRound(deps(), { roomId: 10 })

    expect(result.reachedLimit).toBe(true)
    expect(result.cellsExecuted).toBe(0)
  })

  test('a room of nothing but interrupt agents has no round to open', async () => {
    room({ id: 10 })
    db.update(agents).set({ interruptEveryTurn: true }).where(inArray(agents.id, [1, 2])).run()
    getCache().clear()

    const result = await runAutonomousRound(deps(), { roomId: 10 })

    expect(result.cellsExecuted).toBe(0)
  })
})

describe('RoomOrchestrator.handleAutonomousRound', () => {
  function orchestratorWith(round: TurnImplementations['autonomousRound']): RoomOrchestrator {
    const never = () => new Promise<ExecutionResult>(() => {})
    return new RoomOrchestrator({
      pool: { interruptRoom: () => Promise.resolve([]), agentsInRoom: () => [] },
      turns: { gameplay: never, chat: never, chatRoom: never, autonomousRound: round },
    } as unknown as RoomOrchestratorDeps)
  }

  const executionResult = (overrides: Partial<ExecutionResult> = {}): ExecutionResult => ({
    totalResponses: 1,
    totalSkips: 0,
    cellsExecuted: 1,
    wasInterrupted: false,
    wasPaused: false,
    reachedLimit: false,
    allSkipped: false,
    reactions: [],
    ...overrides,
  })

  test('runs the round and reports its result', async () => {
    const orchestrator = orchestratorWith(() => Promise.resolve(executionResult()))

    const outcome = await orchestrator.handleAutonomousRound(10)

    expect(outcome.completed).toBe(true)
    expect(outcome.skipped).toBeUndefined()
    expect(outcome.result?.totalResponses).toBe(1)
  })

  test('skips a room that already has a turn in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    const orchestrator = orchestratorWith(() => {
      started++
      return gate.then(() => executionResult())
    })

    const first = orchestrator.handleAutonomousRound(10)
    await tick()
    const second = await orchestrator.handleAutonomousRound(10)

    expect(second.skipped).toBe(true)
    expect(second.completed).toBe(false)
    expect(started).toBe(1)

    release()
    await first
    // Once the room is idle again the next tick is free to run.
    await orchestrator.handleAutonomousRound(10)
    expect(started).toBe(2)
  })

  test('a round that throws is contained, like any other turn', async () => {
    const orchestrator = orchestratorWith(() => Promise.reject(new Error('no agents')))

    const outcome = await orchestrator.handleAutonomousRound(10)

    expect(outcome.completed).toBe(false)
    expect(outcome.error).toBeInstanceOf(Error)
  })
})

describe('RoomOrchestrator.cleanupStaleEntries', () => {
  test('drops supersede stamps older than the max age and keeps the rest', async () => {
    const orchestrator = new RoomOrchestrator({
      pool: { interruptRoom: () => Promise.resolve([]), agentsInRoom: () => [] },
      turns: {
        gameplay: () => Promise.resolve(undefined as unknown as ExecutionResult),
        chat: () => Promise.resolve(undefined as unknown as ExecutionResult),
        chatRoom: () => Promise.resolve(undefined as unknown as ExecutionResult),
        autonomousRound: () => Promise.resolve(undefined as unknown as ExecutionResult),
      },
    } as unknown as RoomOrchestratorDeps)

    await orchestrator.handleAutonomousRound(10)

    // Nothing is stale yet at an hour's age...
    expect(orchestrator.cleanupStaleEntries()).toBe(0)
    // ...and everything is at a zero-second one.
    expect(orchestrator.cleanupStaleEntries(0)).toBe(1)
    expect(orchestrator.cleanupStaleEntries(0)).toBe(0)
  })
})

// ============================================================================
// Cleanup sweep
// ============================================================================

describe('cleanup', () => {
  test('drops expired cache entries and sweeps the orchestrator', () => {
    const cache = getCache()
    cache.set('sched:live', 'v', 60)
    cache.set('sched:dead', 'v', -1)
    const orchestrator = stubOrchestrator()

    makeScheduler(orchestrator).cleanup()

    expect(cache.get<string>('sched:live')).toBe('v')
    expect(cache.get('sched:dead')).toBeUndefined()
    expect(orchestrator.swept).toBe(1)
  })

  test('an orchestrator that throws does not propagate out of the sweep', () => {
    const orchestrator: SchedulerOrchestrator = {
      handleAutonomousRound: () => Promise.resolve({}),
      cleanupStaleEntries: () => {
        throw new Error('boom')
      },
    }

    expect(() => makeScheduler(orchestrator).cleanup()).not.toThrow()
  })
})
