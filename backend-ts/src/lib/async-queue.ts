/**
 * A bounded async queue with an explicit end-of-stream sentinel.
 *
 * Bun has no `asyncio.Queue`, and the pump/consumer split needs one: the pump
 * must keep reading the SDK stream even while the consumer is slow, so that the
 * CLI's control channel stays serviceable (see session.ts).
 *
 * `push` never blocks. On overflow it drops the *oldest* item rather than
 * refusing the newest, because the newest is the one carrying the turn's
 * terminal `result` — dropping it would hang the consumer until its idle
 * timeout. Drops are counted so a truncated turn is distinguishable from a
 * clean one.
 */
export class AsyncQueue<T> {
  private readonly buffer: T[] = []
  private notify: (() => void) | null = null
  private ended = false
  private dropped = 0

  constructor(private readonly maxSize = 2000) {}

  get droppedCount(): number {
    return this.dropped
  }

  push(item: T): void {
    if (this.ended) return
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift()
      this.dropped++
    }
    this.buffer.push(item)
    this.notify?.()
  }

  end(): void {
    this.ended = true
    this.notify?.()
  }

  /**
   * Take the next item, or `null` once the queue has ended and drained.
   *
   * Rejects with the abort reason if `signal` fires while parked — an
   * interrupted turn must not sit here until its idle timeout.
   */
  async next(signal?: AbortSignal): Promise<T | null> {
    for (;;) {
      const item = this.buffer.shift()
      if (item !== undefined) return item
      if (this.ended) return null
      if (signal?.aborted) throw signal.reason
      let onAbort: (() => void) | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          this.notify = resolve
          if (signal) {
            onAbort = () => reject(signal.reason)
            signal.addEventListener('abort', onAbort, { once: true })
          }
        })
      } finally {
        this.notify = null
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
    }
  }
}
