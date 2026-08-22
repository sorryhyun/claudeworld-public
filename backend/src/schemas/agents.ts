/** Agent request/response schemas. */

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

// `interrupt_every_turn` and `priority` are behaviour settings a
// `group_config.yaml` can override, not per-agent data.
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

// From a `config_file` or the three markdown fields inline. `system_prompt` is
// built server-side, so it is on the response and not here.
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

/** The agent response: base fields first, then the four declared here. */
export const Agent = AgentBase.extend({
  id: pydanticInt(),
  /** Built from the markdown files by the prompt builder, never client-supplied. */
  system_prompt: z.string(),
  session_id: optionalString(),
  created_at: isoDatetime(),
})

export type Agent = z.infer<typeof Agent>

/**
 * Drizzle row → `Agent` response. `session_id` is always `null` — there is no
 * such column, SDK session ids live in `room_agent_sessions` — but the wire
 * contract carries it. `world_name` is deliberately not exposed.
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
