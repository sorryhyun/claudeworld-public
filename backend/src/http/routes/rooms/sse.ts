/**
 * SSE streaming — port of `backend/routers/sse.py`.
 *
 * Two routes that only make sense together:
 *
 *   POST /rooms/:room_id/stream/ticket   JWT in, single-use ticket out
 *   GET  /rooms/:room_id/stream?ticket=  the stream, authenticated by that ticket
 *
 * The split exists because `EventSource` cannot set a request header, so the
 * long-lived JWT would otherwise have to travel in the query string and land in
 * access logs. `middleware/auth.ts` excludes the GET for that reason and this
 * module authenticates it instead — the exclusion and the `validateTicket` call
 * below are two halves of one check, and removing either opens the stream.
 *
 * ## Gap against Python
 *
 * Python replays *catch-up* events on connect, so a client that reloads mid-turn
 * immediately sees the partial text an agent has already produced. It reads them
 * from `AgentManager.get_streaming_state_for_room`, a per-room registry of
 * in-flight response text. The TypeScript SDK keeps that state on the turn
 * rather than on a manager and nothing publishes it per room yet — the same gap
 * `routes/game/polling.ts` documents for `thinking_text`. The stream is correct
 * from the moment it connects; it just does not backfill.
 */

import { Hono } from 'hono'

import { KEEPALIVE_INTERVAL_MS } from '../../../infrastructure/sse'
import { getLogger } from '../../../infrastructure/logging/logger'
import { HttpError } from '../../errors'
import { identityOf, type AppState } from '../../state'
import type { AppEnv } from '../../types'
import { intPathParam } from '../game/shared'
import { ensureRoomAccessFor } from './shared'

const logger = getLogger('SSERouter')

/**
 * Render one SSE frame.
 *
 * `data` is written as a single line because every payload here is JSON, which
 * never contains a raw newline. A multi-line payload would need one `data:` per
 * line, and silently truncating at the first newline is the classic SSE bug.
 */
function frame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

export function createSseRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  /**
   * Trade a JWT for a ticket.
   *
   * Reached through the normal auth middleware, so `identityOf` is already the
   * verified caller. The room access check is *not* in Python — its handler
   * only reads `request.state` — but the ticket it mints is a bearer credential
   * for a room's entire event stream, and issuing one for a room the caller
   * cannot otherwise read would be a way around `ensure_room_access`.
   */
  routes.post('/rooms/:room_id/stream/ticket', (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)

    const identity = identityOf(c)
    const ticket = state.tickets.createTicket(identity.userId, identity.role, roomId)
    return c.json({ ticket })
  })

  /**
   * The event stream.
   *
   * Runs until the client goes away, the server shuts down, or the room's
   * broadcaster ends the queue. `ReadableStream.from` drives the generator, so
   * a disconnect runs its `finally` — which is what unsubscribes; there is no
   * separate disconnect handler to keep in step with it.
   */
  routes.get('/rooms/:room_id/stream', (c) => {
    const roomId = intPathParam(c, 'room_id')

    const ticket = c.req.query('ticket')
    const ticketData = ticket ? state.tickets.validateTicket(ticket, roomId) : null
    // One message for "absent", "expired", "already spent" and "wrong room":
    // distinguishing them would tell an attacker which half to vary.
    if (ticketData === null) throw new HttpError(401, 'Invalid or expired ticket')

    const queue = state.broadcaster.subscribe(roomId)
    logger.debug(`SSE stream opened for room ${roomId} by ${ticketData.userId}`)

    async function* events(): AsyncGenerator<string> {
      try {
        yield frame('connected', JSON.stringify({ room_id: roomId }))

        while (!state.broadcaster.isShuttingDown) {
          let data: string | null
          try {
            // The timeout is the keepalive clock: parking forever would let an
            // idle connection be reaped by any proxy in the path.
            data = await queue.next(AbortSignal.timeout(KEEPALIVE_INTERVAL_MS))
          } catch {
            // Only the timeout can land here — the queue itself resolves with
            // null rather than throwing when it ends.
            yield frame('keepalive', '')
            continue
          }

          // Null means the queue ended: unsubscribed, or server shutdown.
          if (data === null) break

          // The broadcaster serialises the event; `type` doubles as the SSE
          // event name so the frontend's per-name listeners fire.
          let eventName = 'message'
          try {
            const parsed = JSON.parse(data) as { type?: unknown }
            if (typeof parsed.type === 'string') eventName = parsed.type
          } catch {
            // Unreachable via `broadcast`, which serialises what it sends.
          }
          yield frame(eventName, data)
        }
      } finally {
        state.broadcaster.unsubscribe(roomId, queue)
        logger.debug(`SSE stream closed for room ${roomId}`)
      }
    }

    // Driven by an explicit pull rather than `ReadableStream.from`, which Bun
    // implements but these typings do not declare. `cancel` is what makes a
    // client disconnect run the generator's `finally`, and that is what
    // unsubscribes — so there is no separate disconnect path to keep in step.
    const iterator = events()[Symbol.asyncIterator]()
    const stream = new ReadableStream<string>({
      async pull(controller) {
        const { value, done } = await iterator.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
      },
      async cancel(reason) {
        await iterator.return?.(reason)
      },
    })

    return new Response(stream.pipeThrough(new TextEncoderStream()), {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        // Nginx buffers proxied responses by default, which would hold every
        // delta until the response ended — i.e. forever. Python's sse_starlette
        // sends this for the same reason.
        'x-accel-buffering': 'no',
      },
    })
  })

  return routes
}
