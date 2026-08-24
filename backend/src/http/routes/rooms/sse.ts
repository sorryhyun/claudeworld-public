/**
 * SSE streaming: `POST /rooms/:id/stream/ticket` trades a JWT for a single-use
 * ticket, `GET /rooms/:id/stream?ticket=` is the stream it authenticates —
 * `EventSource` cannot set a header, and the JWT must not land in access logs.
 * `middleware/auth.ts` excludes the GET *because* this module authenticates it;
 * the exclusion and the `validateTicket` call are two halves of one check.
 *
 * A connect replays whatever is mid-stream in the room as `catch_up` frames —
 * see `http/live-streams.ts` for why a client that misses `stream_start` sees
 * nothing at all afterwards.
 */

import { Hono } from 'hono'

import { KEEPALIVE_INTERVAL_MS } from '@/infrastructure/sse'
import { getLogger } from '@/infrastructure/logging/logger'
import { HttpError } from '@/domain/errors'
import { identityOf, type AppState } from '@/http/state'
import type { AppEnv } from '@/http/types'
import { intPathParam } from '@/http/routes/game/shared'
import { ensureRoomAccessFor } from './shared'

const logger = getLogger('SSERouter')

// One `data:` line: every payload here is JSON, so it carries no raw newline.
function frame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

export function createSseRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  // The ticket is a bearer credential for a room's entire event stream, so
  // minting one without this check routes around `ensureRoomAccess`.
  routes.post('/rooms/:room_id/stream/ticket', (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)

    const identity = identityOf(c)
    const ticket = state.tickets.createTicket(identity.userId, identity.role, roomId)
    return c.json({ ticket })
  })

  routes.get('/rooms/:room_id/stream', (c) => {
    const roomId = intPathParam(c, 'room_id')

    const ticket = c.req.query('ticket')
    const ticketData = ticket ? state.tickets.validateTicket(ticket, roomId) : null
    // One message for "absent", "expired", "already spent" and "wrong room":
    // distinguishing them would tell an attacker which half to vary.
    if (ticketData === null) throw new HttpError(401, 'Invalid or expired ticket')

    // Both in this tick, before the first `await`: an event broadcast after the
    // subscribe is queued, one folded in before it is in the snapshot, and no
    // ordering of the two can drop or double a delta.
    const queue = state.broadcaster.subscribe(roomId)
    const catchUp = state.liveStreams.snapshot(roomId)
    logger.debug(`SSE stream opened for room ${roomId} by ${ticketData.userId}`)

    async function* events(): AsyncGenerator<string> {
      try {
        yield frame('connected', JSON.stringify({ room_id: roomId }))

        // Before any queued delta, or the client would apply deltas to a bubble
        // the catch-up is about to overwrite.
        for (const stream of catchUp) {
          yield frame(
            'catch_up',
            JSON.stringify({
              type: 'catch_up',
              agent_id: stream.agentId,
              agent_name: stream.agentName,
              temp_id: stream.tempId,
              thinking_text: stream.thinkingText,
              response_text: stream.responseText,
              narration_text: stream.narrationText,
            }),
          )
        }

        while (!state.broadcaster.isShuttingDown) {
          let data: string | null
          try {
            // The keepalive clock: parking forever lets a proxy reap this.
            data = await queue.next(AbortSignal.timeout(KEEPALIVE_INTERVAL_MS))
          } catch {
            // Only the timeout lands here; the queue resolves null when it ends.
            yield frame('keepalive', '')
            continue
          }

          // Null means the queue ended: unsubscribed, or server shutdown.
          if (data === null) break

          // `type` doubles as the SSE event name so per-name listeners fire.
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

    // Explicit pull rather than `ReadableStream.from`, which these typings do not
    // declare. `cancel` makes a disconnect run the generator's `finally`, which is
    // what unsubscribes.
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
        // Nginx buffers proxied responses by default, holding every delta until
        // the response ends — i.e. forever.
        'x-accel-buffering': 'no',
      },
    })
  })

  return routes
}
