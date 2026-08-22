/**
 * Agent request/response schemas — port of `backend/schemas/agents.py`.
 */

import { z } from 'zod'
import type { Agent as AgentRow } from '../db/schema'
import {
  isoDatetime,
  optionalString,
  pydanticBool,
  pydanticInt,
  requiredTimestamp,
  serializeBool,
} from './common'

/**
 * The fields shared by the create request and the response.
 *
 * `interrupt_every_turn` and `priority` are the only two with non-null
 * defaults, and both are *behaviour* settings a `group_config.yaml` can
 * override rather than per-agent data — see `agents/group_config.yaml.example`.
 */
export const AgentBase = z.object({
  name: z.string(),
  group: optionalString(),
  config_file: optionalString(),
  profile_pic: optionalString(),
  in_a_nutshell: optionalString(),
  characteristics: optionalString(),
  recent_events: optionalString(),
  interrupt_every_turn: pydanticBool().default(false),
  priority: pydanticInt().default(0),
})

export type AgentBase = z.infer<typeof AgentBase>

/**
 * Create an agent from either a `config_file` to load the markdown from, or the
 * three markdown fields inline. `system_prompt` is built server-side either way,
 * which is why it is on the response and not here.
 */
export const AgentCreate = AgentBase

export type AgentCreate = z.infer<typeof AgentCreate>

/** The runtime-editable subset: the picture and the three markdown files. */
export const AgentUpdate = z.object({
  profile_pic: optionalString(),
  in_a_nutshell: optionalString(),
  characteristics: optionalString(),
  recent_events: optionalString(),
})

export type AgentUpdate = z.infer<typeof AgentUpdate>

/**
 * The agent response.
 *
 * Field order matches Pydantic's — base fields first, then the four declared on
 * the subclass — so a byte-level diff against the Python backend in the Phase 4
 * parity harness has nothing to trip on.
 */
export const Agent = AgentBase.extend({
  id: pydanticInt(),
  /** Built from the markdown files by the prompt builder, never client-supplied. */
  system_prompt: z.string(),
  session_id: optionalString(),
  created_at: isoDatetime(),
})

export type Agent = z.infer<typeof Agent>

/**
 * Drizzle row → `Agent` response.
 *
 * Two fields do not come from the row, and both are deliberate:
 *
 * - **`session_id` is always `null`.** There is no such column on `agents`;
 *   SDK session ids live in `room_agent_sessions`, keyed by (room, agent). The
 *   Pydantic model declares the field with `from_attributes = True`, so Python
 *   looks for the attribute, fails to find it, and falls back to the default.
 *   The frontend's `Agent` type still lists it. Emitting `null` is what the API
 *   has always done, not an omission here.
 * - **`world_name` is not exposed.** The column exists and scopes an agent to
 *   one world's cast, but no response schema carries it.
 *
 * `interrupt_every_turn` and `priority` fold NULL into their declared defaults;
 * see {@link requiredTimestamp} for why `created_at` does not get the same
 * treatment.
 */
export function toAgent(row: AgentRow): Agent {
  return {
    name: row.name,
    group: row.group,
    config_file: row.configFile,
    profile_pic: row.profilePic,
    in_a_nutshell: row.inANutshell,
    characteristics: row.characteristics,
    recent_events: row.recentEvents,
    interrupt_every_turn: serializeBool(row.interruptEveryTurn),
    priority: row.priority ?? 0,
    id: row.id,
    system_prompt: row.systemPrompt,
    session_id: null,
    created_at: requiredTimestamp(row.createdAt, 'Agent', 'created_at'),
  }
}
