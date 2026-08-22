/**
 * The simplified agent surface: five request/response endpoints under
 * `/mcp-tools`, meant to be wrapped as MCP tools and driven by another model.
 *
 * **Unauthenticated** — `middleware/auth.ts` excludes anything under `/mcp`, and
 * `"/mcp-tools".startsWith("/mcp")`. There is no identity here, so every room
 * this router touches is owned by the literal `admin`; do not "fix" the
 * exclusion without deciding what an MCP caller's identity is. `chat` and
 * `room/message` block on the whole turn instead of streaming, because a tool
 * call has nowhere to put a stream.
 */

import { Hono } from 'hono'

import { getSettings } from '../../config/settings'
import { getAllAgents } from '../../crud/agents'
import { createMessage, getMessagesSince, getRecentMessages } from '../../crud/messages'
import {
  addAgentToRoom,
  createRoom,
  getAgentsInRoom,
  getOrCreateDirectRoom,
  getRoom,
} from '../../crud/rooms'
import type { Agent } from '../../db/schema'
import { getLogger } from '../../infrastructure/logging/logger'
import {
  ChatRequest,
  RoomMessageRequest,
  RoomRequest,
  toAgentInfo,
  toConversationMessage,
  type ChatResponse,
  type RoomCreated,
} from '../../schemas/mcp-tools'
import { HttpError } from '../errors'
import type { AppState } from '../state'
import type { AppEnv } from '../types'
import { intQueryParamOr, parseBody } from './game/shared'

const logger = getLogger('McpToolsRouter')

// An unauthenticated request carries no identity to derive an owner from.
const MCP_OWNER_ID = 'admin'

const STAYS_SILENT = '*stays silent*'

const UNKNOWN_AGENT_NAME = 'Agent'

const AVAILABLE_LIMIT = 10

export function createMcpToolsRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/mcp-tools/agents', (c) => c.json(getAllAgents(state.db).map(toAgentInfo)))

  // Say something to one agent and wait for the reply, in the agent's dedicated
  // direct room — the same one `GET /agents/{id}/direct-room` hands the frontend.
  routes.post('/mcp-tools/chat', async (c) => {
    const body = await parseBody(c, ChatRequest)

    const agents = getAllAgents(state.db)
    const agent = findAgent(agents, body.agent_name)
    if (!agent) throw agentNotFoundWithList(body.agent_name, agents)

    const room = getOrCreateDirectRoom(state.db, agent.id, MCP_OWNER_ID)
    // Unreachable: null only for an agent id that does not exist.
    if (room === null) throw new HttpError(404, `Agent '${body.agent_name}' not found`)

    // `getOrCreateDirectRoom` adds the agent when it *creates* the room, so this
    // only matters for a room whose membership was cleared later.
    if (!getAgentsInRoom(state.db, room.id).some((member) => member.id === agent.id)) {
      addAgentToRoom(state.db, room.id, agent.id)
    }

    const replies = await runTurnAndCollect(state, {
      roomId: room.id,
      message: body.message,
      // One agent, not the whole room — and a one-agent room schedules no
      // follow-up rounds either.
      mentionedAgentIds: [agent.id],
    })

    const first = replies[0]
    const response: ChatResponse = {
      // The requested agent's name in both branches.
      agent_name: agent.name,
      response: first ? first.content : STAYS_SILENT,
      thinking: first?.thinking ?? null,
      room_id: room.id,
    }
    return c.json(response)
  })

  // The newest `limit` messages of the direct conversation. Uses the creating
  // variant, so a never-used agent gets an empty room and `[]`, not a 404.
  routes.get('/mcp-tools/conversation/:agent_name', (c) => {
    const agentName = c.req.param('agent_name') ?? ''
    const limit = intQueryParamOr(c, 'limit', 20)

    const agent = findAgent(getAllAgents(state.db), agentName)
    // No "Available:" list on this one; the two 404 strings deliberately differ.
    if (!agent) throw new HttpError(404, `Agent '${agentName}' not found`)

    const room = getOrCreateDirectRoom(state.db, agent.id, MCP_OWNER_ID)
    if (room === null) return c.json([])

    return c.json(getRecentMessages(state.db, room.id, limit).map(toConversationMessage))
  })

  // Unmatched names are reported rather than raised: a model composing a cast
  // from memory will get some wrong, and failing the call costs it the rest.
  routes.post('/mcp-tools/room', async (c) => {
    const body = await parseBody(c, RoomRequest)

    const room = createRoom(state.db, { name: body.name }, MCP_OWNER_ID)

    const agents = getAllAgents(state.db)
    const added: string[] = []
    const notFound: string[] = []

    for (const name of body.agent_names) {
      const agent = findAgent(agents, name)
      if (!agent) {
        notFound.push(name)
        continue
      }
      addAgentToRoom(state.db, room.id, agent.id)
      // The real name, not the requested spelling a substring match resolved.
      added.push(agent.name)
    }

    logger.info(
      `Created MCP room '${room.name}' (id ${room.id}) with ${added.length} agent(s); ` +
        `${notFound.length} name(s) unmatched`,
    )

    const response: RoomCreated = {
      room_id: room.id,
      room_name: room.name,
      agents_added: added,
      agents_not_found: notFound,
    }
    return c.json(response)
  })

  // Say something to a room and wait for every agent that answers.
  routes.post('/mcp-tools/room/message', async (c) => {
    const body = await parseBody(c, RoomMessageRequest)

    const room = getRoom(state.db, body.room_id)
    if (room === null) throw new HttpError(404, `Room ${body.room_id} not found`)

    const replies = await runTurnAndCollect(state, {
      roomId: room.id,
      message: body.message,
      mentionedAgentIds: null,
    })

    return c.json(
      replies.map(
        (reply): ChatResponse => ({
          agent_name: reply.agent?.name ?? UNKNOWN_AGENT_NAME,
          response: reply.content,
          thinking: reply.thinking,
          room_id: room.id,
        }),
      ),
    )
  })

  return routes
}

interface TurnInput {
  roomId: number
  message: string
  /** Agent ids that may answer, or null for the whole room. */
  mentionedAgentIds: number[] | null
}

// The replies come back out of the table rather than from the turn:
// `ExecutionResult.reactions` covers only cells flagged `isReaction`, and every
// chat-room cell is a visible cell whose output is already a persisted, ordered
// message. Rows with no `agent_id` are dropped.
async function runTurnAndCollect(state: AppState, input: TurnInput) {
  const userMessage = createMessage(state.db, input.roomId, {
    content: input.message,
    role: 'user',
    participantType: 'user',
    participantName: getSettings().userName,
  })

  // Deliberately not broadcast over SSE: a browser watching this room gets the
  // message from its next poll either way.
  const outcome = await state.orchestrator.handleChatRoomMessage({
    roomId: input.roomId,
    action: input.message,
    mentionedAgentIds: input.mentionedAgentIds,
  })

  // A cancelled turn keeps what it wrote; a turn that *threw* produced nothing,
  // and a 200 with `*stays silent*` would report a broken agent as a quiet one.
  if (outcome.error !== undefined) {
    const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    logger.error(`Chat turn failed | Room: ${input.roomId} | ${detail}`)
    throw new HttpError(500, `Agent turn failed: ${detail}`)
  }

  return getMessagesSince(state.db, input.roomId, userMessage.id).filter(
    (message) => message.agentId !== null,
  )
}

// Exact name, then case-insensitive substring, so a model can say "Chen" and
// reach "Dr. Chen". The *first* match in table order, not the best: stable
// rather than dependent on an unstated scoring rule.
function findAgent(agents: Agent[], name: string): Agent | undefined {
  const exact = agents.find((agent) => agent.name === name)
  if (exact) return exact

  const needle = name.toLowerCase()
  return agents.find((agent) => agent.name.toLowerCase().includes(needle))
}

// The 404 body is a wire contract: `Available: ['프리렌', 'Dr. Chen']` —
// brackets, single quotes and all. {@link pythonListRepr} produces that shape.
function agentNotFoundWithList(requested: string, agents: Agent[]): HttpError {
  const available = agents.slice(0, AVAILABLE_LIMIT).map((agent) => agent.name)
  return new HttpError(
    404,
    `Agent '${requested}' not found. Available: ${pythonListRepr(available)}`,
  )
}

/** `['a', 'b']`, or `[]` when empty. */
function pythonListRepr(values: string[]): string {
  return `[${values.map(pythonRepr).join(', ')}]`
}

// Single quotes, switching to double only when the string holds a single quote
// and no double one. Non-printable Unicode is emitted literally: escaping it
// needs the Unicode category table JavaScript does not expose.
function pythonRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"

  let escaped = ''
  for (const char of value) {
    if (char === '\\') escaped += '\\\\'
    else if (char === quote) escaped += `\\${quote}`
    else if (char === '\n') escaped += '\\n'
    else if (char === '\r') escaped += '\\r'
    else if (char === '\t') escaped += '\\t'
    else {
      const code = char.codePointAt(0) ?? 0
      escaped +=
        code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : char
    }
  }

  return `${quote}${escaped}${quote}`
}
