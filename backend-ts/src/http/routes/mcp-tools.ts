/**
 * The simplified agent surface — port of `backend/routers/mcp_tools.py`.
 *
 * Five endpoints under `/mcp-tools`, designed to be wrapped as MCP tools and
 * driven by another model: list the agents, say something to one, read the
 * transcript back, make a group room, say something to the group. The `/rooms`
 * surface can do all of this, but only as a sequence of six calls with an
 * `EventSource` in the middle; this one is request/response.
 *
 * **Unauthenticated in both backends.** `middleware/auth.ts` excludes anything
 * under `/mcp`, and `"/mcp-tools".startsWith("/mcp")` — which is how Python's
 * `EXCLUDED_PREFIXES` reaches it too. So there is no identity here: the direct
 * room is opened under the literal owner `admin`, exactly as Python hardcodes
 * it, and a created group room is owned by `admin` for the same reason. Do not
 * "fix" the exclusion without also deciding what an MCP caller's identity is.
 *
 * **`chat` and `room/message` block.** They await the whole turn and serialize
 * the agents' replies into the body, unlike `POST /rooms/{id}/messages/send`,
 * which returns the saved user message and lets SSE deliver the replies. A tool
 * call has nowhere to put a stream, so the wait is the point.
 *
 * ## Parity note: four of these five endpoints raise in Python
 *
 * This router was written against APIs that do not exist, and nothing calls it,
 * so nobody noticed. Reproducing the crashes would make the router pointless,
 * so the *intended* behaviour is implemented and the divergences are listed
 * here:
 *
 * - `chat` and `room/message` call `chat_orchestrator.orchestrate_responses(...)`.
 *   `ChatOrchestrator` has no such method (`orchestration/orchestrator.py`), and
 *   its closest relative, `_process_agent_responses`, returns `None` rather than
 *   a list of responses. Both endpoints raise `AttributeError` → 500. Here they
 *   run the real chat-room turn through {@link RoomOrchestrator.handleChatRoomMessage}
 *   and read the persisted replies back — see {@link runTurnAndCollect}.
 * - `get_conversation` calls `crud.get_messages(db, room.id, limit=limit)`;
 *   `crud.get_messages` takes no `limit` (`crud/messages.py:134`) → `TypeError`
 *   → 500. Here `limit` selects the newest N, which is what its docstring says.
 * - `create_room` calls `crud.create_room(db, name=request.name)`; the real
 *   signature is `(db, room: schemas.RoomCreate, owner_id, world_id=None)` →
 *   `TypeError` → 500. Here the room is created with the requested name under
 *   the `admin` owner.
 *
 * Only `GET /mcp-tools/agents` works as written in Python, and it is ported
 * unchanged.
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

/**
 * The owner every room this router touches belongs to.
 *
 * Python hardcodes `owner_id="admin"` on `get_or_create_direct_room` with the
 * comment "for MCP access". There is no identity on an unauthenticated request
 * to derive anything better from, and an MCP caller is by construction the
 * machine's operator.
 */
const MCP_OWNER_ID = 'admin'

/** What an agent that produced no message answers with. Python's literal. */
const STAYS_SILENT = '*stays silent*'

/** Python's `r.agent_name or "Agent"` fallback on a message with no agent. */
const UNKNOWN_AGENT_NAME = 'Agent'

/** How many agent names the 404 lists. Python's `agents[:10]`. */
const AVAILABLE_LIMIT = 10

export function createMcpToolsRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  routes.get('/mcp-tools/agents', (c) => c.json(getAllAgents(state.db).map(toAgentInfo)))

  // ---------------------------------------------------------------------------
  // 1-on-1
  // ---------------------------------------------------------------------------

  /**
   * Say something to one agent and wait for the reply.
   *
   * The room is the agent's dedicated direct room, created on first use — the
   * same one `GET /agents/{id}/direct-room` hands the frontend, since both go
   * through `getOrCreateDirectRoom` under the `admin` owner.
   */
  routes.post('/mcp-tools/chat', async (c) => {
    const body = await parseBody(c, ChatRequest)

    const agents = getAllAgents(state.db)
    const agent = findAgent(agents, body.agent_name)
    if (!agent) throw agentNotFoundWithList(body.agent_name, agents)

    const room = getOrCreateDirectRoom(state.db, agent.id, MCP_OWNER_ID)
    // Unreachable: `getOrCreateDirectRoom` returns null only for an agent id
    // that does not exist, and this one was just read out of the table.
    if (room === null) throw new HttpError(404, `Agent '${body.agent_name}' not found`)

    // `getOrCreateDirectRoom` adds the agent when it *creates* the room, so
    // this only matters for a room whose membership was cleared later. Python
    // checks the same thing for the same reason.
    if (!getAgentsInRoom(state.db, room.id).some((member) => member.id === agent.id)) {
      addAgentToRoom(state.db, room.id, agent.id)
    }

    const replies = await runTurnAndCollect(state, {
      roomId: room.id,
      message: body.message,
      // One agent responds, not the whole room — Python's
      // `responding_agents=[agent]`. A one-agent room also has nobody to talk
      // to, so `runChatRoomTurn` schedules no follow-up rounds.
      mentionedAgentIds: [agent.id],
    })

    const first = replies[0]
    const response: ChatResponse = {
      // The requested agent's name in both branches, as in Python — so a reply
      // that came back on a message with no agent still reads correctly.
      agent_name: agent.name,
      response: first ? first.content : STAYS_SILENT,
      thinking: first?.thinking ?? null,
      room_id: room.id,
    }
    return c.json(response)
  })

  /**
   * The last `limit` messages of the direct conversation with an agent.
   *
   * `get_or_create`, not `get`: Python uses the creating variant here too, so
   * asking for the history of a never-used agent creates its empty room and
   * answers `[]` rather than 404ing.
   */
  routes.get('/mcp-tools/conversation/:agent_name', (c) => {
    const agentName = c.req.param('agent_name') ?? ''
    const limit = intQueryParamOr(c, 'limit', 20)

    const agent = findAgent(getAllAgents(state.db), agentName)
    // No "Available:" list on this one — Python's two 404 strings differ, and
    // the frontend-visible half of the parity contract is the string, not the
    // consistency.
    if (!agent) throw new HttpError(404, `Agent '${agentName}' not found`)

    const room = getOrCreateDirectRoom(state.db, agent.id, MCP_OWNER_ID)
    if (room === null) return c.json([])

    return c.json(getRecentMessages(state.db, room.id, limit).map(toConversationMessage))
  })

  // ---------------------------------------------------------------------------
  // Group rooms
  // ---------------------------------------------------------------------------

  /**
   * Create a room and put several agents in it.
   *
   * Names that match nothing are reported rather than raised: a model composing
   * a cast from memory will get some of them wrong, and failing the whole call
   * for one bad name costs it the room it did get right.
   */
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
      // The agent's real name, not the requested spelling: a substring match
      // resolved it, and the caller needs to know to what.
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

  /** Say something to a room and wait for every agent that answers. */
  routes.post('/mcp-tools/room/message', async (c) => {
    const body = await parseBody(c, RoomMessageRequest)

    const room = getRoom(state.db, body.room_id)
    if (room === null) throw new HttpError(404, `Room ${body.room_id} not found`)

    const replies = await runTurnAndCollect(state, {
      roomId: room.id,
      message: body.message,
      // Everyone in the room — Python's `responding_agents=room_agents`.
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

// =============================================================================
// Running a turn synchronously
// =============================================================================

interface TurnInput {
  roomId: number
  message: string
  /** Agent ids that may answer, or null for the whole room. */
  mentionedAgentIds: number[] | null
}

/**
 * Save the user's message, run the chat-room turn to completion, and return the
 * agent messages it wrote.
 *
 * **Why the replies are read back out of the table rather than returned by the
 * turn.** `ExecutionResult` counts responses and carries `reactions`, but
 * reactions are collected only from cells flagged `isReaction`, and every
 * chat-room cell is a *visible* cell — its output is a persisted message, not a
 * reaction handed to a later cell (`orchestration/tape/chat-room-tape.ts`).
 * Widening the executor to accumulate every visible response would put a
 * transcript in memory for the benefit of one unauthenticated debug endpoint,
 * on a path where the messages are already durable and already ordered. So the
 * turn stays untouched and this reads `messages` newer than the trigger. That
 * is also what Python's `orchestrate_responses` was reaching for: its callers
 * read `.content`, `.thinking` and `.agent_name` off the results, which are
 * `models.Message` attributes.
 *
 * Rows with no `agent_id` are dropped — the "X joined the chat" notices that
 * `addAgentToRoom` writes, and the user's own message if the id filter ever
 * slips. Only agents' replies are replies.
 */
async function runTurnAndCollect(state: AppState, input: TurnInput) {
  const userMessage = createMessage(state.db, input.roomId, {
    content: input.message,
    role: 'user',
    participantType: 'user',
    participantName: getSettings().userName,
  })

  // Deliberately not broadcast over SSE: Python's `mcp_tools` does not, and a
  // browser watching this room gets the message from its next poll either way.
  const outcome = await state.orchestrator.handleChatRoomMessage({
    roomId: input.roomId,
    action: input.message,
    mentionedAgentIds: input.mentionedAgentIds,
  })

  // A cancelled turn (`completed: false` with no error) keeps whatever it wrote
  // before it was cut; a turn that *threw* produced nothing meaningful, and
  // answering 200 with `*stays silent*` would report a broken agent as a quiet
  // one. The caller here is a model deciding what to do next, so it gets the
  // failure.
  if (outcome.error !== undefined) {
    const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    logger.error(`Chat turn failed | Room: ${input.roomId} | ${detail}`)
    throw new HttpError(500, `Agent turn failed: ${detail}`)
  }

  return getMessagesSince(state.db, input.roomId, userMessage.id).filter(
    (message) => message.agentId !== null,
  )
}

// =============================================================================
// Name matching
// =============================================================================

/**
 * Python's two-step lookup: exact name, then case-insensitive substring.
 *
 * The substring step is what lets a model say "Chen" and reach "Dr. Chen". It
 * takes the *first* match in table order rather than the best one, which is
 * Python's `next(...)` and is worth keeping: it makes the result stable and
 * explainable rather than dependent on a scoring rule neither backend states.
 */
function findAgent(agents: Agent[], name: string): Agent | undefined {
  const exact = agents.find((agent) => agent.name === name)
  if (exact) return exact

  const needle = name.toLowerCase()
  return agents.find((agent) => agent.name.toLowerCase().includes(needle))
}

/**
 * Python's `f"Agent '{name}' not found. Available: {available}"`, where
 * `available` is a *Python list of strings* interpolated with `str()` — so the
 * body reads `Available: ['프리렌', 'Dr. Chen']`, brackets, single quotes and
 * all. {@link pythonListRepr} reproduces that.
 */
function agentNotFoundWithList(requested: string, agents: Agent[]): HttpError {
  const available = agents.slice(0, AVAILABLE_LIMIT).map((agent) => agent.name)
  return new HttpError(
    404,
    `Agent '${requested}' not found. Available: ${pythonListRepr(available)}`,
  )
}

/** `str(list_of_str)` in Python: `['a', 'b']`, or `[]` when empty. */
function pythonListRepr(values: string[]): string {
  return `[${values.map(pythonRepr).join(', ')}]`
}

/**
 * `repr()` of a Python 3 `str`, for the character classes an agent name can
 * plausibly contain.
 *
 * Python prefers single quotes and switches to double quotes only when the
 * string contains a single quote and no double quote; a backslash and the
 * chosen quote are escaped, and C0 control characters take their short escape
 * or `\xNN`.
 *
 * **Not reproduced:** Python also escapes every character Unicode classifies as
 * non-printable — unassigned code points, format characters such as U+200B, and
 * the surrogate range — as `\uXXXX`/`\UXXXXXXXX`. Doing that needs the Unicode
 * category table, which JavaScript does not expose. Printable non-ASCII (every
 * real agent name, Korean and Japanese included) is emitted literally by both,
 * so the strings match; a zero-width space in an agent name would not.
 */
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
