/**
 * Request models: what they accept, what they reject, and what a minimal body
 * fills in.
 *
 * Every `expect(...).toEqual({...})` in this file is the literal output of
 * `Model(...).model_dump()` on the Python side, so a change to a default or an
 * optionality shows up here as a diff rather than as a frontend bug.
 */

import { describe, expect, test } from 'bun:test'

import { AgentCreate, AgentUpdate } from '@/schemas/agents'
import {
  GameTime,
  InventoryItem,
  LocationCreate,
  LocationUpdate,
  PlayerAction,
  StatDefinition,
  StatDefinitions,
  WorldCreate,
  WorldResetRequest,
  WorldUpdate,
} from '@/schemas/game'
import { MessageCreate } from '@/schemas/messages'
import { RoomCreate, RoomUpdate } from '@/schemas/rooms'

describe('AgentCreate / AgentUpdate', () => {
  test('a name is the only required field', () => {
    expect(AgentCreate.parse({ name: 'a' })).toEqual({
      name: 'a',
      group: null,
      config_file: null,
      profile_pic: null,
      in_a_nutshell: null,
      characteristics: null,
      recent_events: null,
      interrupt_every_turn: false,
      priority: 0,
    })
  })

  test('rejects a body with no name', () => {
    expect(AgentCreate.safeParse({}).success).toBe(false)
  })

  test('the two behaviour settings coerce like Pydantic', () => {
    const parsed = AgentCreate.parse({ name: 'a', interrupt_every_turn: 'true', priority: '5' })
    expect(parsed.interrupt_every_turn).toBe(true)
    expect(parsed.priority).toBe(5)
  })

  test('unknown keys are dropped rather than rejected', () => {
    // The frontend's AgentCreate type still carries `backgrounds` and `memory`,
    // fields the backend removed. Pydantic ignores extras; so must this.
    const parsed = AgentCreate.parse({ name: 'a', backgrounds: 'x', memory: 'y' })
    expect(parsed).not.toHaveProperty('backgrounds')
    expect(parsed).not.toHaveProperty('memory')
  })

  test('AgentUpdate is the four runtime-editable fields, all optional', () => {
    expect(AgentUpdate.parse({})).toEqual({
      profile_pic: null,
      in_a_nutshell: null,
      characteristics: null,
      recent_events: null,
    })
  })

  test('AgentUpdate cannot rename an agent', () => {
    expect(AgentUpdate.parse({ name: 'other' })).not.toHaveProperty('name')
  })
})

describe('RoomCreate / RoomUpdate', () => {
  test('minimal body', () => {
    expect(RoomCreate.parse({ name: 'r' })).toEqual({ name: 'r', max_interactions: null })
  })

  test('max_interactions accepts a numeric string, as Pydantic does', () => {
    expect(RoomCreate.parse({ name: 'r', max_interactions: '20' }).max_interactions).toBe(20)
  })

  test('max_interactions rejects a fractional value', () => {
    expect(RoomCreate.safeParse({ name: 'r', max_interactions: 1.5 }).success).toBe(false)
  })

  test('an empty update is all-null and touches nothing', () => {
    expect(RoomUpdate.parse({})).toEqual({
      max_interactions: null,
      is_paused: null,
      is_finished: null,
    })
  })

  test('explicit null is indistinguishable from omission', () => {
    expect(RoomUpdate.parse({ is_paused: null })).toEqual(RoomUpdate.parse({}))
  })

  test('booleans coerce from strings', () => {
    expect(RoomUpdate.parse({ is_paused: 'yes', is_finished: 0 })).toEqual({
      max_interactions: null,
      is_paused: true,
      is_finished: false,
    })
  })
})

describe('WorldCreate / WorldUpdate', () => {
  test('language defaults to English', () => {
    expect(WorldCreate.parse({ name: 'w' })).toEqual({ name: 'w', user_name: null, language: 'en' })
  })

  test('only the three supported languages are accepted', () => {
    expect(WorldCreate.parse({ name: 'w', language: 'ko' }).language).toBe('ko')
    expect(WorldCreate.parse({ name: 'w', language: 'jp' }).language).toBe('jp')
    expect(WorldCreate.safeParse({ name: 'w', language: 'fr' }).success).toBe(false)
  })

  test('an empty update is all-null', () => {
    expect(WorldUpdate.parse({})).toEqual({
      phase: null,
      genre: null,
      theme: null,
      user_name: null,
      stat_definitions: null,
    })
  })

  test('phase is constrained to the three world phases', () => {
    expect(WorldUpdate.parse({ phase: 'active' }).phase).toBe('active')
    expect(WorldUpdate.safeParse({ phase: 'paused' }).success).toBe(false)
  })

  test('stat_definitions on the write path is an open dict, not the read shape', () => {
    // The read path returns `{stats: [...]}`; the write path stores whatever it
    // is handed. Preserving that asymmetry is the point of this assertion.
    expect(WorldUpdate.parse({ stat_definitions: { anything: [1, 2] } }).stat_definitions).toEqual({
      anything: [1, 2],
    })
  })
})

describe('WorldResetRequest', () => {
  test('defaults to not confirmed', () => {
    expect(WorldResetRequest.parse({})).toEqual({ confirm: false })
  })

  test('coerces the confirmation flag', () => {
    expect(WorldResetRequest.parse({ confirm: 'true' }).confirm).toBe(true)
    expect(WorldResetRequest.safeParse({ confirm: 2 }).success).toBe(false)
  })
})

describe('LocationCreate / LocationUpdate', () => {
  test('a new location is discovered and not a draft, at the origin', () => {
    expect(LocationCreate.parse({ name: 'l' })).toEqual({
      name: 'l',
      display_name: null,
      description: null,
      position_x: 0,
      position_y: 0,
      adjacent_to: null,
      is_discovered: true,
      is_draft: false,
    })
  })

  test('adjacency comes in as adjacent_to and must be integers', () => {
    expect(LocationCreate.parse({ name: 'l', adjacent_to: [1, '2'] }).adjacent_to).toEqual([1, 2])
    expect(LocationCreate.safeParse({ name: 'l', adjacent_to: ['a'] }).success).toBe(false)
  })

  test('an empty update is all-null', () => {
    expect(LocationUpdate.parse({})).toEqual({
      name: null,
      display_name: null,
      description: null,
      label: null,
      position_x: null,
      position_y: null,
      is_discovered: null,
      is_draft: null,
    })
  })

  test('the label PATCH route reads only `label`', () => {
    expect(LocationUpdate.parse({ label: 'Home base' }).label).toBe('Home base')
  })
})

describe('MessageCreate', () => {
  test('content and role are required, everything else defaults to null', () => {
    expect(MessageCreate.parse({ content: 'c', role: 'user' })).toEqual({
      content: 'c',
      role: 'user',
      participant_type: null,
      participant_name: null,
      images: null,
      image_data: null,
      image_media_type: null,
      agent_id: null,
      thinking: null,
      anthropic_calls: null,
      mentioned_agent_ids: null,
      chat_session_id: null,
      game_time_snapshot: null,
    })
  })

  test('role is limited to the two MessageRole values', () => {
    expect(MessageCreate.parse({ content: 'c', role: 'assistant' }).role).toBe('assistant')
    expect(MessageCreate.safeParse({ content: 'c', role: 'system' }).success).toBe(false)
  })

  test('participant_type admits the four ParticipantType values, including legacy `agent`', () => {
    for (const value of ['user', 'character', 'system', 'agent'] as const) {
      expect(MessageCreate.parse({ content: 'c', role: 'user', participant_type: value }).participant_type).toBe(
        value,
      )
    }
    expect(MessageCreate.safeParse({ content: 'c', role: 'user', participant_type: 'npc' }).success).toBe(false)
  })

  test('an image needs both a payload and a media type', () => {
    const ok = MessageCreate.parse({
      content: 'c',
      role: 'user',
      images: [{ data: 'AAA', media_type: 'image/png' }],
    })
    expect(ok.images).toEqual([{ data: 'AAA', media_type: 'image/png' }])
    expect(
      MessageCreate.safeParse({ content: 'c', role: 'user', images: [{ data: 'AAA' }] }).success,
    ).toBe(false)
  })

  test('game_time_snapshot is an open int-valued mapping, not a GameTime', () => {
    expect(
      MessageCreate.parse({
        content: 'c',
        role: 'user',
        game_time_snapshot: { hour: 9, minute: 30, day: 2 },
      }).game_time_snapshot,
    ).toEqual({ hour: 9, minute: 30, day: 2 })
    expect(
      MessageCreate.safeParse({ content: 'c', role: 'user', game_time_snapshot: { hour: 'nine' } }).success,
    ).toBe(false)
  })

  test('a numeric content is rejected — Pydantic never coerces into str', () => {
    expect(MessageCreate.safeParse({ content: 5, role: 'user' }).success).toBe(false)
  })
})

describe('PlayerAction', () => {
  test('text is required; the image pair is optional', () => {
    expect(PlayerAction.parse({ text: 'go north' })).toEqual({
      text: 'go north',
      image_data: null,
      image_media_type: null,
    })
    expect(PlayerAction.safeParse({}).success).toBe(false)
  })

  test('an empty action text is allowed', () => {
    // No `min_length` on the Python field; the orchestrator decides what to do
    // with an empty action, not the schema.
    expect(PlayerAction.parse({ text: '' }).text).toBe('')
  })
})

describe('value models', () => {
  test('GameTime opens a world at 08:00 on day 1', () => {
    expect(GameTime.parse({})).toEqual({ hour: 8, minute: 0, day: 1 })
  })

  test('InventoryItem defaults to a single unpropertied item', () => {
    expect(InventoryItem.parse({ id: 'i', name: 'n' })).toEqual({
      id: 'i',
      name: 'n',
      description: null,
      quantity: 1,
      properties: null,
    })
  })

  test('StatDefinition needs a name and a display label', () => {
    expect(StatDefinition.parse({ name: 'hp', display: 'HP' })).toEqual({
      name: 'hp',
      display: 'HP',
      min: null,
      max: null,
      default: 0,
      color: null,
    })
    expect(StatDefinition.safeParse({ name: 'hp' }).success).toBe(false)
  })

  test('StatDefinitions defaults to an empty list', () => {
    expect(StatDefinitions.parse({})).toEqual({ stats: [] })
  })
})
