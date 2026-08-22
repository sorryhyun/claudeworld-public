/**
 * Background scheduler for autonomous agent chat rounds: every **2 seconds**
 * each active chat room gets one round, so the agents keep talking while nobody
 * is watching; every **5 minutes** expired cache entries and stale orchestrator
 * state are swept. It picks rooms and does not orchestrate — *how* a round runs
 * belongs to {@link RoomOrchestrator.handleAutonomousRound}, which gives a
 * background round the interrupt and in-flight rules a user message gets.
 *
 * **A tick arriving while the previous one is still running is dropped, not
 * queued.** A bare `setInterval` with an async callback does the opposite: a
 * slow tick stacks up overlapping runs that all hit the same rooms.
 * {@link BackgroundScheduler.tick} guards on the in-flight promise instead.
 *
 * The active-room select lives here rather than in `src/crud/`: it is the
 * scheduler's own selection policy and exists nowhere else.
 */

import { and, count, desc, eq, gte, inArray, isNull } from 'drizzle-orm'

import type { Db } from '../db'
import { roomAgents, rooms, type Room } from '../db/schema'
import { getCache } from './cache'
import { getLogger } from './logging/logger'

const logger = getLogger('BackgroundScheduler')

export const PROCESS_INTERVAL_MS = 2_000

export const CLEANUP_INTERVAL_MS = 5 * 60_000

/**
 * How recently a room must have seen activity to be scheduled. Read off
 * `rooms.last_activity_at` rather than by scanning messages: the column exists
 * so this poll does not re-count a room's whole transcript every two seconds.
 */
export const ACTIVE_WINDOW_MS = 5 * 60_000

/** Below this, there is nobody for an agent to talk *to*. */
const MIN_AGENTS = 2

/** Narrowed to two methods, so a test can drive the scheduler without a session
 * pool or a model and this module declares its own dependency shape. */
export interface SchedulerOrchestrator {
  handleAutonomousRound(roomId: number): Promise<{ skipped?: boolean }>
  cleanupStaleEntries?(maxAgeSeconds?: number): number
}

export interface BackgroundSchedulerDeps {
  db: Db
  orchestrator: SchedulerOrchestrator
  /** Caps the rooms selected per tick (`LIMIT`) *and* how many run at once (a
   * semaphore) — the latter also covers a tick slower than the interval. */
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

  /** Idempotent. */
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
   * Stop the timers and wait for the in-flight tick. Idempotent, and awaitable
   * because a half-finished tick holds a database handle a test is about to
   * delete — shutdown must join it, not merely stop scheduling more.
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
   * One pass over the active rooms; public so tests can drive it directly. Never
   * rejects and never wedges: one room's failure is logged and the tick
   * continues, and a failure of the tick itself still clears {@link inFlight}.
   */
  async tick(): Promise<void> {
    // Skip, do not queue — overlapping ticks would hit the same rooms twice.
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
   * The rooms that get an autonomous round: not paused, not finished, active
   * within {@link ACTIVE_WINDOW_MS}, `world_id IS NULL` (a TRPG room's turns
   * come from the game tapes; scheduling one here would run chat-room agents
   * inside a world), newest first, capped, and holding {@link MIN_AGENTS} agents.
   * `= 0` is *false* for a NULL column in SQLite, so NULL flags mean skipped.
   *
   * The agent count is a second query rather than a join because the cap applies
   * to the *rooms* selected: a join would need a `GROUP BY` before the limit or
   * risk the limit counting membership rows.
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
   * The five-minute sweep: expired cache entries, the stats line, and the
   * orchestrator's stale supersede stamps. No per-session lock sweep is needed —
   * `SessionPool` deletes its open-serializing promise when the open settles.
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

// Cap on how many of the passed functions run at once. Per tick rather than
// shared across ticks, which is safe because a tick awaits everything it starts
// and an overrunning tick is skipped rather than overlapped.
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
