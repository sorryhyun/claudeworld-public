/**
 * A push-based async iterable used as the SDK's `prompt`.
 *
 * `query()` takes the prompt as an async iterable and drains it for the life of
 * the subprocess. A turn needs to push one message into that iterable and have
 * the parked generator wake up, which a generator over a fixed list cannot do —
 * hence a channel. Closing it ends the CLI's stdin and with it the session, so
 * `close()` is teardown, not end-of-turn.
 *
 * Adapted from yaar's `providers/claude/input-channel.ts`, which solves the
 * identical problem against the same SDK.
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
