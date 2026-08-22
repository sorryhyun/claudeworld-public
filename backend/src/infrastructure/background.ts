// Registry for fire-and-forget background work. Two reasons it exists: an
// unobserved rejection is a process-level `unhandledRejection`, fatal under
// Bun's default; and shutdown has to wait for in-flight turns to finish.

import { getLogger } from './logging/logger'

const logger = getLogger('BackgroundTasks')

interface BackgroundTask {
  readonly name: string
  readonly promise: Promise<void>
  readonly abort: AbortController
}

const tasks = new Set<BackgroundTask>()

export interface SpawnOptions {
  /** Task name for logs. Include context: `enter_world:world=12`, not `turn`. */
  name: string
}

/**
 * Start fire-and-forget work that stays registered and logs its failures.
 * `body`'s `AbortSignal` fires only if the task overruns shutdown, and the
 * returned promise never rejects.
 */
export function spawnBackground(
  body: (signal: AbortSignal) => Promise<unknown>,
  { name }: SpawnOptions,
): Promise<void> {
  const abort = new AbortController()

  // Deferred so the cleanup closure can capture `task`: the body may run
  // synchronously up to its first await.
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

// Called on shutdown so an in-flight turn can finish writing before the
// database handle closes; whatever overruns is aborted.
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
