/**
 * A push-based async iterable used as the SDK's `prompt`. `query()` drains it for
 * the life of the subprocess, and a turn pushes one message in and wakes the
 * parked generator — which a generator over a fixed list cannot do. Closing it
 * ends the CLI's stdin and with it the session, so `close()` is teardown, not
 * end-of-turn.
 */
export interface InputChannel {
  push(message: unknown): void
  close(): void
  readonly iterable: AsyncGenerator<unknown>
}

export function createInputChannel(): InputChannel {
  const buffer: unknown[] = []
  let notify: (() => void) | null = null
  let closed = false

  async function* iterate(): AsyncGenerator<unknown> {
    for (;;) {
      while (buffer.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        notify = null
      }
      if (buffer.length === 0) return
      yield buffer.shift()
    }
  }

  return {
    push(message: unknown) {
      buffer.push(message)
      notify?.()
    },
    close() {
      closed = true
      notify?.()
    },
    iterable: iterate(),
  }
}
