// The `/mcp-tools` wire contract. Requests use `pydanticInt()` because this
// surface is called by an LLM through a generated client, which is more likely
// than the React app to send `{"room_id": "3"}`.

import { z } from 'zod'

import type { MessageWithAgent } from '@/crud/messages'
import type { Agent as AgentRow } from '@/db/schema'
import { optionalString, pydanticInt } from './common'

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

/** One row of `GET /mcp-tools/agents`: enough for a model to pick someone. */
export const AgentInfo = z.object({
  id: pydanticInt(),
  name: z.string(),
  group: optionalString(),
})

export type AgentInfo = z.infer<typeof AgentInfo>

export function toAgentInfo(row: AgentRow): AgentInfo {
  return { id: row.id, name: row.name, group: row.group }
}

/** `agent_name` is the *resolved* agent, so a partial-name match answers under
 * the real name even in the silent branch. */
export const ChatResponse = z.object({
  agent_name: z.string(),
  response: z.string(),
  thinking: optionalString(),
  room_id: pydanticInt(),
})

export type ChatResponse = z.infer<typeof ChatResponse>

/** `sender` collapses the three attribution paths into one display string. */
export const ConversationMessage = z.object({
  role: z.string(),
  sender: z.string(),
  content: z.string(),
  thinking: optionalString(),
})

export type ConversationMessage = z.infer<typeof ConversationMessage>

// The `||` chain is deliberate: an empty name must fall through to the next
// candidate, and `??` would not.
export function toConversationMessage(row: MessageWithAgent): ConversationMessage {
  return {
    role: row.role,
    sender: row.agent?.name || row.participantName || row.role,
    content: row.content,
    thinking: row.thinking,
  }
}

/** `POST /mcp-tools/room`. */
export const RoomCreated = z.object({
  room_id: pydanticInt(),
  room_name: z.string(),
  /** Real agent names, not the requested spellings — a substring match resolves. */
  agents_added: z.array(z.string()),
  /** The requested spellings that matched nothing. */
  agents_not_found: z.array(z.string()),
})

export type RoomCreated = z.infer<typeof RoomCreated>
