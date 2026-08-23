/**
 * Chat room messages: the full transcript, the incremental poll, the typing
 * indicators, and the send that starts a turn. `usePolling.ts` drives all four.
 * Rate limits are per-IP and per-route.
 */

import { Hono } from 'hono'

import {
  getAgentCached,
  getAgentsCached,
  getMessagesSinceCached,
  getRoomCached,
} from '@/crud/cached'
import { createMessage, getMessages } from '@/crud/messages'
import { RoomNotFoundError } from '@/domain/errors'
import { getLogger } from '@/infrastructure/logging/logger'
import { MessageCreate, toMessage } from '@/schemas/messages'
import { assertRoomAccess } from '@/http/access-control'
import { rateLimit } from '@/http/middleware/rate-limit'
import { identityOf, type AppState } from '@/http/state'
import type { AppEnv } from '@/http/types'
import { intPathParam, intQueryParam, parseBody, startBackground, tryCompressImage } from '@/http/routes/game/shared'
import { ensureRoomAccessFor } from './shared'

const logger = getLogger('MessageRouter')

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

  // Uncached on purpose: a hard reload must not be served a stale or
  // half-warmed cache, since unlike the poll no later request corrects it.
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
   * Who is mid-response, for the "…is typing" rows. The access check is spelled
   * out rather than delegated to `ensureRoomAccess` so it can read the *cached*
   * room, keeping this hot path off the relational load.
   *
   * **Gap: `thinking_text` and `response_text` are always empty**, as in
   * `routes/game/polling.ts` — partial response text lives on the turn, not in
   * a per-room registry.
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

  /**
   * Save the user's message, then start the agents on it in the background.
   * `startBackground` rather than a plain call because `bun:sqlite` is
   * synchronous: an `async` function would otherwise run to its first `await`
   * *inside* this request.
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
      // Folded into `images` above; written never, read off older rows only.
      imageData: null,
      imageMediaType: null,
      chatSessionId: body.chat_session_id,
      gameTimeSnapshot: toGameTime(body.game_time_snapshot),
    })
    logger.info(`[send_message] Message saved with ID: ${saved.id}`)

    // The full row rides along: `useSSE.ts` only acts on events carrying
    // `message` — a bare `message_id` is ignored by every client.
    state.broadcaster.broadcast(roomId, {
      type: 'new_message',
      message_id: saved.id,
      message: toMessage({
        ...saved,
        agent: saved.agentId === null ? null : getAgentCached(state.db, saved.agentId),
      }),
    })

    // A room with a world is a TRPG room; its turns run through the `/worlds`
    // action surface instead, so only a plain chat room starts a turn here.
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

// The request schema accepts any `Record<string, int>`, but the stored snapshot
// is `{hour, minute, day}`. A partial object is dropped rather than stored
// half-filled, which would render as a broken timestamp forever.
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

// Capped and compressed into the modern `images` array, so the stored row has
// one shape whatever the client sent. Array order is preserved.
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
