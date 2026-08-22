/**
 * The MCP-tools wire contract — port of the Pydantic models declared inline in
 * `backend/routers/mcp_tools.py`.
 *
 * Python declares these six models in the router file itself rather than in
 * `backend/schemas/`; they live here anyway, because every other request and
 * response shape in this backend does and a caller looking for "the shape of
 * `POST /mcp-tools/chat`" should find it in one place.
 *
 * The requests use the `pydanticInt()` helpers for the same reason the rest of
 * `src/schemas/` does: this surface is called by an LLM through a generated
 * client, which is *more* likely than the React app to send `{"room_id": "3"}`,
 * and Pydantic has always accepted that.
 */

import { z } from 'zod'

import type { MessageWithAgent } from '../crud/messages'
import type { Agent as AgentRow } from '../db/schema'
import { optionalString, pydanticInt } from './common'

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** `POST /mcp-tools/chat`. */
export const ChatRequest = z.object({
  /** e.g. `'프리렌'`, `'Dr. Chen'`. Matched exactly first, then as a substring. */
  agent_name: z.string(),
  message: z.string(),
})

export type ChatRequest = z.infer<typeof ChatRequest>

/** `POST /mcp-tools/room`. */
export const RoomRequest = z.object({
  name: z.string(),
  agent_names: z.array(z.string()),
})

export type RoomRequest = z.infer<typeof RoomRequest>

/** `POST /mcp-tools/room/message`. */
export const RoomMessageRequest = z.object({
  room_id: pydanticInt(),
  message: z.string(),
})

export type RoomMessageRequest = z.infer<typeof RoomMessageRequest>

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * One row of `GET /mcp-tools/agents`.
 *
 * Three fields out of the fourteen on `schemas.Agent`: this surface exists so a
 * model can pick an agent to talk to, and the system prompt and markdown
 * sections are noise for that.
 */
export const AgentInfo = z.object({
  id: pydanticInt(),
  name: z.string(),
  group: optionalString(),
})

export type AgentInfo = z.infer<typeof AgentInfo>

export function toAgentInfo(row: AgentRow): AgentInfo {
  return { id: row.id, name: row.name, group: row.group }
}

/**
 * One agent's reply.
 *
 * `agent_name` is the *responding* agent, and on `POST /mcp-tools/chat` it is
 * the name of the agent the caller asked for rather than the name on the
 * message — Python builds it from `agent.name` in both the responded and the
 * silent branch, so a partial-name match answers under the agent's real name.
 */
export const ChatResponse = z.object({
  agent_name: z.string(),
  response: z.string(),
  thinking: optionalString(),
  room_id: pydanticInt(),
})

export type ChatResponse = z.infer<typeof ChatResponse>

/**
 * One line of `GET /mcp-tools/conversation/{agent_name}`.
 *
 * `sender` collapses the three ways a message can be attributed — an agent, a
 * named participant, or nothing at all — into one display string, because a
 * model reading a transcript needs a name per line, not a participant model.
 */
export const ConversationMessage = z.object({
  role: z.string(),
  sender: z.string(),
  content: z.string(),
  thinking: optionalString(),
})

export type ConversationMessage = z.infer<typeof ConversationMessage>

/**
 * Row → `ConversationMessage`.
 *
 * Python writes `m.agent_name or m.participant_name or m.role`. `agent_name` is
 * not a column: `schemas.Message` derives it from the eager-loaded
 * `Message.agent`, which is what `MessageWithAgent` carries here. The `or`
 * chain treats an empty string as absent, and `??` would not, so the fallbacks
 * are spelled out rather than nullish-coalesced.
 */
export function toConversationMessage(row: MessageWithAgent): ConversationMessage {
  return {
    role: row.role,
    sender: row.agent?.name || row.participantName || row.role,
    content: row.content,
    thinking: row.thinking,
  }
}

/**
 * `POST /mcp-tools/room`.
 *
 * Python returns a bare `dict` with no `response_model`, so FastAPI serializes
 * these four keys as-is. Declared here so the shape is checkable in a test.
 */
export const RoomCreated = z.object({
  room_id: pydanticInt(),
  room_name: z.string(),
  /** Real agent names, not the requested spellings — a substring match resolves. */
  agents_added: z.array(z.string()),
  /** The requested spellings that matched nothing. */
  agents_not_found: z.array(z.string()),
})

export type RoomCreated = z.infer<typeof RoomCreated>
