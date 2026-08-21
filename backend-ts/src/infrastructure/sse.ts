/**
 * Per-room SSE event fan-out.
 *
 * Port of `backend/infrastructure/sse.py`. One queue per connected client; a
 * broadcast is a non-blocking push onto every queue subscribed to the room, so
 * a slow reader can never stall the agent generating the events.
 *
 * The queue is {@link AsyncQueue}, the same primitive the SDK stream pump uses.
 * That brings one deliberate divergence from Python: on overflow it drops the
 * *oldest* buffered event, where `asyncio.Queue.put_nowait` raises `QueueFull`
 * and Python drops the *newest*. For a stream of `content_delta`s the newest is
 * the one that matters — dropping it strands the reader a chunk behind forever,
 * while dropping the oldest costs a chunk the reader has already been shown a
 * superset of on the next poll. Message events survive either way, because
 * `usePolling` re-fetches them independently of the stream.
 */

import { AsyncQueue } from '../lib/async-queue'
import { getLogger } from './logging/logger'

const logger = getLogger('SSE')

/**
 * How many events a single client may fall behind before the oldest are shed.
 *
 * Python's default is 256 and this matches it. It is a per-client buffer, not a
 * per-room one: a room with twenty viewers holds twenty of these.
 */
const DEFAULT_MAX_QUEUE_SIZE = 256

/**
 * An event as the frontend reads it.
 *
 * `type` doubles as the SSE `event:` name — `useSSE.ts` attaches listeners by
 * that name (`stream_start`, `content_delta`, `thinking_delta`, `stream_end`,
 * `new_message`) — so it is required rather than defaulted.
 */
export interface SseEvent {
  type: string
  [key: string]: unknown
}

/** A subscriber's end of the fan-out. */
export type SseSubscription = AsyncQueue<string>

export class EventBroadcaster {
  private readonly subscribers = new Map<number, Set<SseSubscription>>()
  private shuttingDown = false

  constructor(private readonly maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE) {}

  /** Whether {@link shutdown} has been called; the stream loop polls this. */
  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  /** Open a queue for one client. The caller must {@link unsubscribe} it. */
  subscribe(roomId: number): SseSubscription {
    const queue = new AsyncQueue<string>(this.maxQueueSize)
    let room = this.subscribers.get(roomId)
    if (!room) {
      room = new Set()
      this.subscribers.set(roomId, room)
    }
    room.add(queue)
    logger.debug(`SSE subscriber added for room ${roomId} (total: ${room.size})`)
    return queue
  }

  /**
   * Close one client's queue.
   *
   * Ending the queue as well as dropping it matters: a reader parked in
   * `next()` — the normal state for an idle stream — is only woken by `end()`
   * or a push, so without it a disconnecting client's loop would hang until the
   * next keepalive rather than unwinding immediately.
   */
  unsubscribe(roomId: number, queue: SseSubscription): void {
    const room = this.subscribers.get(roomId)
    if (room) {
      room.delete(queue)
      if (room.size === 0) this.subscribers.delete(roomId)
    }
    queue.end()
    logger.debug(
      `SSE subscriber removed for room ${roomId} (remaining: ${this.getSubscriberCount(roomId)})`,
    )
  }

  /**
   * Push an event to every client watching a room.
   *
   * Serialised once for all subscribers, and a no-op when nobody is listening —
   * which is the common case, since the polling fallback works without any SSE
   * client attached at all.
   */
  broadcast(roomId: number, event: SseEvent): void {
    const room = this.subscribers.get(roomId)
    if (!room || room.size === 0) return

    let data: string
    try {
      data = JSON.stringify(event)
    } catch (error) {
      // A non-serialisable payload is a bug in the caller, but it must not take
      // down the turn that produced it.
      logger.exception(`Dropping unserialisable SSE event type=${event.type}`, error)
      return
    }

    for (const queue of room) queue.push(data)
  }

  getSubscriberCount(roomId: number): number {
    return this.subscribers.get(roomId)?.size ?? 0
  }

  hasSubscribers(roomId: number): boolean {
    return this.getSubscriberCount(roomId) > 0
  }

  /**
   * Tell every open stream to finish.
   *
   * Ends the queues rather than only setting the flag, so readers parked in
   * `next()` wake at once instead of after their keepalive timeout — shutdown
   * would otherwise wait out one full {@link KEEPALIVE_INTERVAL_MS} per client.
   */
  shutdown(): void {
    this.shuttingDown = true
    for (const room of this.subscribers.values()) {
      for (const queue of room) queue.end()
    }
    logger.info('SSE broadcaster shutdown signalled')
  }
}

/** Silence between events before a comment frame is sent. Python's is 15s. */
export const KEEPALIVE_INTERVAL_MS = 15_000
