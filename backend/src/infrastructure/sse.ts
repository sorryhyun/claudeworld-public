/**
 * Per-room SSE fan-out. One queue per client; a broadcast is a non-blocking push
 * onto each, so a slow reader can never stall the agent generating events. On
 * overflow {@link AsyncQueue} drops the *oldest* event, deliberately: for a stream
 * of `content_delta`s the newest is the one that matters, and message events
 * survive either way since `usePolling` re-fetches them.
 */

import { AsyncQueue } from '@/lib/async-queue'
import { getLogger } from './logging/logger'

const logger = getLogger('SSE')

// Per client, not per room: a room with twenty viewers holds twenty of these.
const DEFAULT_MAX_QUEUE_SIZE = 256

/** `type` doubles as the SSE `event:` name — `useSSE.ts` attaches listeners by
 * it — so it is required, never defaulted. */
export interface SseEvent {
  type: string
  [key: string]: unknown
}

export type SseSubscription = AsyncQueue<string>

export class EventBroadcaster {
  private readonly subscribers = new Map<number, Set<SseSubscription>>()
  private shuttingDown = false

  constructor(private readonly maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE) {}

  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  /** The caller must {@link unsubscribe} it. */
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

  /** Ending the queue as well as dropping it matters: a reader parked in `next()`
   * is only woken by `end()` or a push, so the loop would hang until keepalive. */
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

  /** A no-op when nobody is listening — the polling fallback needs no SSE. */
  broadcast(roomId: number, event: SseEvent): void {
    const room = this.subscribers.get(roomId)
    if (!room || room.size === 0) return

    let data: string
    try {
      data = JSON.stringify(event)
    } catch (error) {
      // A caller bug, but it must not take down the turn that produced it.
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

  /** Ends the queues rather than only setting the flag, so parked readers wake at
   * once instead of after one full {@link KEEPALIVE_INTERVAL_MS} each. */
  shutdown(): void {
    this.shuttingDown = true
    for (const room of this.subscribers.values()) {
      for (const queue of room) queue.end()
    }
    logger.info('SSE broadcaster shutdown signalled')
  }
}

/** Silence between events before a comment frame is sent. */
export const KEEPALIVE_INTERVAL_MS = 15_000
