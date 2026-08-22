/**
 * Background scheduler for autonomous agent chat rounds.
 *
 * Port of `backend/infrastructure/scheduler.py`. Two periodic jobs, both of
 * which Python ran on APScheduler:
 *
 * - every **2 seconds**, give each active chat room one autonomous round, so
 *   the agents keep talking to each other while nobody is watching;
 * - every **5 minutes**, sweep expired cache entries and stale orchestrator
 *   state.
 *
 * The scheduler picks rooms; it does not orchestrate. Everything about *how* a
 * round runs — who speaks, in what order, when the room is finished — belongs to
 * {@link RoomOrchestrator.handleAutonomousRound}, which is also what gives a
 * background round the same interrupt and in-flight rules a user's message gets.
 *
 * ## `setInterval` is not APScheduler
 *
 * The Python jobs are declared `max_instances=1, coalesce=True,
 * misfire_grace_time=None`: a tick that comes round while the previous one is
 * still running is **dropped**, not queued. A bare `setInterval` with an async
 * callback does the opposite — it keeps firing, and a slow tick stacks up
 * overlapping runs that all hit the same rooms. {@link BackgroundScheduler.tick}
 * therefore guards on the in-flight promise and returns immediately, which is
 * the whole of `max_instances=1` plus `coalesce=True` for an interval job.
 *
 * ## Queries live here
 *
 * The active-room select and its agent-count filter are written against the
 * Drizzle handle in this file rather than added to `src/crud/`: they are the
 * scheduler's own selection policy, they exist nowhere else in the app, and
 * Python likewise builds them inline in `scheduler.py` rather than in `crud/`.
 */

import { and, count, desc, eq, gte, inArray, isNull } from 'drizzle-orm'

import type { Db } from '../db'
import { roomAgents, rooms, type Room } from '../db/schema'
import { getCache } from './cache'
import { getLogger } from './logging/logger'

const logger = getLogger('BackgroundScheduler')

/** Python's `seconds=2` interval job. */
export const PROCESS_INTERVAL_MS = 2_000

/** Python's `minutes=5` interval job. */
export const CLEANUP_INTERVAL_MS = 5 * 60_000

/**
 * How recently a room must have seen activity to be scheduled.
 *
 * Read off `rooms.last_activity_at` rather than by scanning messages — Python's
 * comment on the same query: the column exists so this poll does not re-count
 * a room's whole transcript every two seconds.
 */
export const ACTIVE_WINDOW_MS = 5 * 60_000

/** Below this, there is nobody for an agent to talk *to*. */
const MIN_AGENTS = 2

/**
 * What the scheduler needs from the orchestrator.
 *
 * Narrowed to two methods so a test can drive the scheduler without a session
 * pool, an SDK or a model — and so this module keeps depending on orchestration
 * only through a shape it declares itself.
 */
export interface SchedulerOrchestrator {
  handleAutonomousRound(roomId: number): Promise<{ skipped?: boolean }>
  /** Python's `ChatOrchestrator.cleanup_stale_entries`. */
  cleanupStaleEntries?(maxAgeSeconds?: number): number
}

export interface BackgroundSchedulerDeps {
  db: Db
  orchestrator: SchedulerOrchestrator
  /**
   * Caps both the number of rooms selected per tick and how many are processed
   * at once — Python applies it as a `LIMIT` *and* as a semaphore, and both
   * halves are kept because the limit is per tick while the semaphore also
   * covers a tick whose rooms are slower than the interval.
   */
  maxConcurrentRooms: number
  /** Overridable so tests do not have to wait on real wall-clock intervals. */
  processIntervalMs?: number
  cleanupIntervalMs?: number
}

export class BackgroundScheduler {
  private readonly db: Db
  private readonly orchestrator: SchedulerOrchestrator
  private readonly maxConcurrentRooms: number
  private readonly processIntervalMs: number
  private readonly cleanupIntervalMs: number

  private processTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  /** The in-flight tick, or null. Non-null is what makes the next tick a no-op. */
  private inFlight: Promise<void> | null = null
  private running = false

  constructor(deps: BackgroundSchedulerDeps) {
    this.db = deps.db
    this.orchestrator = deps.orchestrator
    this.maxConcurrentRooms = deps.maxConcurrentRooms
    this.processIntervalMs = deps.processIntervalMs ?? PROCESS_INTERVAL_MS
    this.cleanupIntervalMs = deps.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Idempotent, like Python's `if not self.is_running`. */
  start(): void {
    if (this.running) return
    this.running = true

    this.processTimer = setInterval(() => void this.tick(), this.processIntervalMs)
    this.cleanupTimer = setInterval(() => {
      this.cleanup()
    }, this.cleanupIntervalMs)

    // A pending timer must not be the reason the process stays alive: shutdown
    // is driven by the server, and an un-unref'd interval would outlive it.
    this.processTimer.unref?.()
    this.cleanupTimer.unref?.()

    logger.info(
      `🚀 Background scheduler started - processing rooms every ${this.processIntervalMs / 1000}s, ` +
        `cache cleanup every ${this.cleanupIntervalMs / 60_000} minutes`,
    )
  }

  /**
   * Stop the timers and wait for the tick already in flight.
   *
   * Idempotent, and awaitable for the reason Python's synchronous
   * `scheduler.shutdown()` does not have to be: a half-finished tick here holds
   * a database handle a test is about to delete, so shutdown has to be able to
   * join it rather than merely stop scheduling more.
   */
  async stop(): Promise<void> {
    if (this.processTimer) clearInterval(this.processTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.processTimer = null
    this.cleanupTimer = null

    const inFlight = this.inFlight
    if (!this.running && inFlight === null) return

    this.running = false
    // `tick` never rejects, so this cannot poison shutdown.
    if (inFlight) await inFlight

    logger.info('🛑 Background scheduler stopped')
  }

  /**
   * One pass over the active rooms. Public so tests can drive it directly
   * instead of sleeping on the interval.
   *
   * Never rejects and never leaves the scheduler wedged: one room's failure is
   * logged and the rest of the tick continues, and a failure of the tick itself
   * still clears {@link inFlight}.
   */
  async tick(): Promise<void> {
    // `max_instances=1` + `coalesce=True`: skip, do not queue.
    if (this.inFlight !== null) {
      logger.debug('Previous tick still running, skipping this one')
      return
    }

    const run = this.processActiveRooms().catch((error: unknown) => {
      logger.exception('💥 Error in background tick', error)
    })
    this.inFlight = run

    try {
      await run
    } finally {
      this.inFlight = null
    }
  }

  private async processActiveRooms(): Promise<void> {
    const active = this.activeRooms()
    // Silent when there is nothing to do: this runs every two seconds.
    if (active.length === 0) return

    logger.info(`🔄 Processing ${active.length} active room(s)`)

    const limit = semaphore(this.maxConcurrentRooms)
    await Promise.all(
      active.map((room) =>
        limit(async () => {
          try {
            await this.orchestrator.handleAutonomousRound(room.id)
          } catch (error: unknown) {
            // One bad room must not take the tick down with it.
            logger.exception(`❌ Error processing room ${room.id}`, error)
          }
        }),
      ),
    )
  }

  /**
   * The rooms that should get an autonomous round, in Python's order.
   *
   * Every clause is `scheduler.py::_get_active_rooms`, kept verbatim including
   * the NULL semantics: `is_paused = 0` and `is_finished = 0` compare *false*
   * for a NULL column in SQLite, so a room with NULL flags is skipped in both
   * backends rather than treated as active.
   *
   * - not paused, not finished
   * - active within {@link ACTIVE_WINDOW_MS}
   * - **`world_id IS NULL`** — a TRPG room's turns come from the game tapes, and
   *   scheduling one here would run chat-room agents inside a world
   * - most recently active first, capped at `maxConcurrentRooms`
   * - at least {@link MIN_AGENTS} agents
   *
   * The agent count is a second query rather than a join, because the cap
   * applies to the *rooms* selected: joining would either need a `GROUP BY`
   * before the limit or risk the limit counting membership rows.
   */
  activeRooms(): Room[] {
    const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS)

    const candidates = this.db
      .select()
      .from(rooms)
      .where(
        and(
          eq(rooms.isPaused, false),
          eq(rooms.isFinished, false),
          gte(rooms.lastActivityAt, cutoff),
          isNull(rooms.worldId),
        ),
      )
      .orderBy(desc(rooms.lastActivityAt))
      .limit(this.maxConcurrentRooms)
      .all()

    if (candidates.length === 0) return []

    const counts = new Map(
      this.db
        .select({ roomId: roomAgents.roomId, total: count() })
        .from(roomAgents)
        .where(
          inArray(
            roomAgents.roomId,
            candidates.map((room) => room.id),
          ),
        )
        .groupBy(roomAgents.roomId)
        .all()
        .map((row) => [row.roomId, row.total] as const),
    )

    return candidates.filter((room) => (counts.get(room.id) ?? 0) >= MIN_AGENTS)
  }

  /**
   * The five-minute sweep — `scheduler.py::_cleanup_cache`.
   *
   * Python cleaned three things; two of them have a counterpart here:
   *
   * 1. the request cache's expired entries, plus its stats line;
   * 2. the orchestrator's stale supersede stamps.
   *
   * The third, `agent_manager.cleanup_stale_resources()`, has **no TS
   * counterpart**. It swept per-client `asyncio.Lock` objects left behind for
   * clients no longer in the pool; `SessionPool` serializes concurrent opens
   * with a promise it deletes when the open settles, so there is no lock table
   * to grow stale. Nothing was reimplemented to fill the gap.
   */
  cleanup(): void {
    try {
      const cache = getCache()
      cache.cleanupExpired()
      cache.logStats()

      this.orchestrator.cleanupStaleEntries?.()
    } catch (error: unknown) {
      logger.exception('Error during cache cleanup', error)
    }
  }
}

/**
 * Cap on how many of the passed functions run at once.
 *
 * Python's `asyncio.Semaphore(max_concurrent_rooms)`, created once on the
 * scheduler and shared across ticks. Here a tick already awaits everything it
 * starts, so the semaphore is per tick — the only difference is a tick that
 * overruns the interval, and that tick is skipped rather than overlapped.
 */
function semaphore(limit: number): <T>(body: () => Promise<T>) => Promise<T> {
  if (limit <= 0) return (body) => body()

  let active = 0
  const waiting: Array<() => void> = []

  const release = (): void => {
    active--
    waiting.shift()?.()
  }

  return async <T>(body: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await body()
    } finally {
      release()
    }
  }
}
