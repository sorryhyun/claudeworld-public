/**
 * Registry for fire-and-forget background work.
 *
 * Port of `backend/infrastructure/background.py`. The Python original exists
 * because asyncio keeps only a *weak* reference to a running task, so
 * fire-and-forget work could be collected mid-flight. Promises are not
 * collected while pending, so that specific hazard does not exist here — but
 * the other two reasons the registry exists do:
 *
 *   1. An unobserved rejection is a process-level `unhandledRejection`, which
 *      under Bun's default is fatal. Every spawned promise gets a `.catch`.
 *   2. Shutdown has to be able to wait for in-flight turns to finish writing.
 *
 * `run_uninterruptible` has deliberately **no counterpart**. It exists in
 * Python to stop `asyncio.CancelledError` from landing between an INSERT and
 * its COMMIT. JavaScript has no preemptive cancellation: an `AbortSignal` is a
 * flag that cooperating code chooses to read, so a synchronous `bun:sqlite`
 * write cannot be torn in half by a cancellation. The guarantee it bought is
 * free here.
 */

import { getLogger } from './logging/logger'

const logger = getLogger('BackgroundTasks')

interface BackgroundTask {
  readonly name: string
  readonly promise: Promise<void>
  readonly abort: AbortController
}

const tasks = new Set<BackgroundTask>()

export interface SpawnOptions {
  /**
   * Task name, used in logs. Include identifying context the way Python's
   * callers do — `trigger_trpg_responses:room=12`, not `turn`.
   */
  name: string
}

/**
 * Start fire-and-forget work that stays registered and logs its failures.
 *
 * `body` receives an `AbortSignal` that fires only if the task overruns
 * shutdown. Work that cannot be resumed should read it; work that must land
 * may ignore it.
 *
 * The returned promise never rejects — callers are not expected to await it,
 * and a rejection nobody observes is exactly what this function exists to
 * prevent.
 */
export function spawnBackground(
  body: (signal: AbortSignal) => Promise<unknown>,
  { name }: SpawnOptions,
): Promise<void> {
  const abort = new AbortController()

  // Deferred so `task` can be captured by the cleanup closure below without a
  // read-before-assign: the body may complete synchronously up to its first
  // await, and `tasks.delete(task)` would then run before `task` is bound.
  let settle: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })

  const task: BackgroundTask = { name, promise, abort }
  tasks.add(task)

  void (async () => {
    try {
      await body(abort.signal)
    } catch (error) {
      if (abort.signal.aborted) {
        logger.warning(`Background task '${name}' was cancelled at shutdown`)
      } else {
        logger.exception(`Background task '${name}' failed`, error)
      }
    } finally {
      tasks.delete(task)
      settle()
    }
  })()

  return promise
}

/** The tasks that have not finished yet (for tests and diagnostics). */
export function pendingBackgroundTasks(): { name: string }[] {
  return [...tasks].map(({ name }) => ({ name }))
}

/**
 * Wait for outstanding background work, aborting whatever overruns.
 *
 * Called on shutdown so an in-flight agent turn gets a chance to finish
 * writing before the database handle closes.
 */
export async function drainBackgroundTasks(timeoutMs = 10_000): Promise<void> {
  if (tasks.size === 0) return

  const inFlight = [...tasks]
  logger.info(`Waiting up to ${Math.round(timeoutMs / 1000)}s for ${inFlight.length} background task(s)`)

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  const all = Promise.all(inFlight.map((task) => task.promise)).then(() => 'done' as const)
  const outcome = await Promise.race([all, deadline])
  if (timer !== undefined) clearTimeout(timer)

  if (outcome === 'timeout') {
    const overran = [...tasks]
    if (overran.length > 0) {
      const names = overran
        .map((task) => task.name)
        .sort()
        .join(', ')
      logger.warning(`Cancelling ${overran.length} background task(s) that overran shutdown: ${names}`)
      for (const task of overran) task.abort.abort()
      await Promise.all(overran.map((task) => task.promise))
    }
  }
}

/** Drop all registrations. Tests only — it does not abort anything. */
export function resetBackgroundTasks(): void {
  tasks.clear()
}
