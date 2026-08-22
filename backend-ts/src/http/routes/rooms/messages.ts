/**
 * Chat room messages — port of `backend/routers/messages.py`.
 *
 * Four routes: the full transcript, the incremental poll, the typing
 * indicators, and the send that starts a turn. `usePolling.ts` drives all four.
 *
 * The rate limits are Python's slowapi decorators, per-IP and per-route:
 * 60/min on the poll, 120/min on the indicators (which the frontend polls
 * faster), 30/min on sends.
 */

import { Hono } from 'hono'

import { getAgentsCached, getMessagesSinceCached, getRoomCached } from '../../../crud/cached'
import { createMessage, getMessages } from '../../../crud/messages'
import { RoomNotFoundError } from '../../../domain/errors'
import { getLogger } from '../../../infrastructure/logging/logger'
import { MessageCreate, toMessage } from '../../../schemas/messages'
import { assertRoomAccess } from '../../access-control'
import { rateLimit } from '../../middleware/rate-limit'
import { identityOf, type AppState } from '../../state'
import type { AppEnv } from '../../types'
import { intPathParam, intQueryParam, parseBody, startBackground, tryCompressImage } from '../game/shared'
import { ensureRoomAccessFor } from './shared'

const logger = getLogger('MessageRouter')

/** Python's `MAX_IMAGES` in `send_message`. */
const MAX_IMAGES = 5

export function createRoomMessageRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  const pollLimit = rateLimit({
    limit: 60,
    windowMs: 60_000,
    description: '60 per 1 minute',
  })
  const chattingLimit = rateLimit({
    limit: 120,
    windowMs: 60_000,
    description: '120 per 1 minute',
  })
  const sendLimit = rateLimit({
    limit: 30,
    windowMs: 60_000,
    description: '30 per 1 minute',
  })

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * The whole transcript.
   *
   * Uncached on purpose, and Python says why: a hard reload must not be served
   * a stale or half-warmed cache, because unlike the poll there is no later
   * request to correct it.
   */
  routes.get('/rooms/:room_id/messages', (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)
    return c.json(getMessages(state.db, roomId).map(toMessage))
  })

  routes.get('/rooms/:room_id/messages/poll', pollLimit, (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)
    const sinceId = intQueryParam(c, 'since_id')
    return c.json(getMessagesSinceCached(state.db, roomId, sinceId).map(toMessage))
  })

  /**
   * Who is mid-response, for the "…is typing" rows.
   *
   * The access check here is written out rather than delegated to
   * `ensureRoomAccess`, because Python's is: it reads the *cached* room to keep
   * this hot path off the relational load, and answers 404 through
   * `RoomNotFoundError` before the ownership test.
   *
   * **Gap: `thinking_text` and `response_text` are always empty**, exactly as in
   * `routes/game/polling.ts` — the TypeScript SDK keeps partial response text on
   * the turn rather than in a per-room registry, so the indicator shows *that*
   * an agent is working, not what it has written so far.
   */
  routes.get('/rooms/:room_id/chatting-agents', chattingLimit, (c) => {
    const roomId = intPathParam(c, 'room_id')

    const room = getRoomCached(state.db, roomId)
    if (room === null) throw new RoomNotFoundError(roomId)
    assertRoomAccess(identityOf(c), room.ownerId)

    const chattingIds = state.orchestrator.getChattingAgents(roomId)
    if (chattingIds.length === 0) return c.json({ chatting_agents: [] })

    const byId = new Map(getAgentsCached(state.db, roomId).map((agent) => [agent.id, agent]))
    const chattingAgents = chattingIds.flatMap((agentId) => {
      const agent = byId.get(agentId)
      if (!agent) return []
      return [
        {
          id: agent.id,
          name: agent.name,
          profile_pic: agent.profilePic,
          thinking_text: '',
          response_text: '',
        },
      ]
    })

    return c.json({ chatting_agents: chattingAgents })
  })

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  /**
   * Save the user's message, then start the agents on it in the background.
   *
   * The response carries only the saved user message; the replies arrive over
   * SSE and the poll. That is what keeps the request fast, and it is why the
   * turn is started with `startBackground` rather than awaited — `bun:sqlite`
   * is synchronous, so an `async` function handed to a plain call would run to
   * its first `await` *inside* this request. See `routes/game/shared.ts`.
   */
  routes.post('/rooms/:room_id/messages/send', sendLimit, async (c) => {
    const roomId = intPathParam(c, 'room_id')
    ensureRoomAccessFor(c, state.db, roomId)

    const body = await parseBody(c, MessageCreate)
    logger.info(
      `[send_message] Received message for room ${roomId}: ` +
        `content='${body.content.slice(0, 50)}...', participant_type=${String(body.participant_type)}`,
    )

    const images = await compressImages(body.images, roomId)

    const saved = createMessage(state.db, roomId, {
      content: body.content,
      role: body.role,
      agentId: body.agent_id,
      participantType: body.participant_type,
      participantName: body.participant_name,
      thinking: body.thinking,
      anthropicCalls: body.anthropic_calls,
      images,
      // The legacy single-image columns are folded into `images` above, so they
      // are never written by this path — only read off older rows.
      imageData: null,
      imageMediaType: null,
      chatSessionId: body.chat_session_id,
      gameTimeSnapshot: toGameTime(body.game_time_snapshot),
    })
    logger.info(`[send_message] Message saved with ID: ${saved.id}`)

    // The saved message is a new event for anyone already watching.
    state.broadcaster.broadcast(roomId, { type: 'new_message', message_id: saved.id })

    // A room that belongs to a world is a TRPG room and its turns run through
    // the `/worlds` action surface, which the frontend uses for those; only a
    // plain chat room starts a turn from here.
    const room = getRoomCached(state.db, roomId)
    if (room?.worldId == null) {
      startBackground(
        () =>
          state.orchestrator.handleChatRoomMessage({
            roomId,
            action: body.content,
            mentionedAgentIds: body.mentioned_agent_ids,
          }),
        { name: `trigger_agent_responses:room=${roomId}` },
      )
    } else {
      logger.info(`[send_message] Room ${roomId} belongs to world ${room.worldId}; no chat turn started`)
    }

    return c.json(toMessage({ ...saved, agent: null }))
  })

  return routes
}

/**
 * Narrow a client-supplied clock to the three fields the column stores.
 *
 * The request schema accepts any `Record<string, int>`, because Pydantic's
 * `Dict[str, int]` does — but the stored snapshot is `{hour, minute, day}` and
 * anything else is not a game time. A partial object is dropped rather than
 * stored half-filled, which would render as a broken timestamp forever.
 */
function toGameTime(
  raw: Record<string, number> | null,
): { hour: number; minute: number; day: number } | null {
  if (!raw) return null
  const { hour, minute, day } = raw
  if (hour === undefined || minute === undefined || day === undefined) {
    logger.warning(`[send_message] Ignoring partial game_time_snapshot: ${JSON.stringify(raw)}`)
    return null
  }
  return { hour, minute, day }
}

/**
 * Fold every supplied image into the modern `images` array, capped and
 * compressed — port of the two image branches in Python's `send_message`.
 *
 * The cap and the legacy-format migration are applied here too, so the stored
 * row has one shape regardless of which format the client sent.
 *
 * The images are encoded concurrently — Python compresses them in a loop, but
 * it has no choice, and libvips runs each encode on its own thread. The order
 * of the array is preserved, which is the only part of the loop that mattered.
 */
async function compressImages(
  images: { data: string; media_type: string }[] | null,
  roomId: number,
): Promise<{ data: string; mediaType: string }[] | null> {
  if (!images || images.length === 0) return null

  const capped = images.slice(0, MAX_IMAGES)
  if (capped.length < images.length) {
    logger.info(`[send_message] Dropping ${images.length - capped.length} image(s) over the cap of ${MAX_IMAGES}`)
  }

  return await Promise.all(
    capped.map(async (image) => {
      const { imageData, imageMediaType } = await tryCompressImage(
        image.data,
        image.media_type,
        `room ${roomId}`,
      )
      return { data: imageData ?? image.data, mediaType: imageMediaType ?? image.media_type }
    }),
  )
}
