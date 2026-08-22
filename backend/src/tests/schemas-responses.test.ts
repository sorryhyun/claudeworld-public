/**
 * Response models: the exact JSON each mapper produces from a Drizzle row.
 *
 * The expected objects are transcriptions of `model_dump_json()` output from the
 * Python backend for the same row, key order included — Pydantic serializes in
 * field-declaration order and the Phase 4 parity harness diffs whole responses,
 * so `Object.keys` is asserted alongside the values.
 *
 * Timestamps in the fixtures are whole milliseconds. Python stores microseconds
 * and a JS `Date` cannot; that divergence is pinned once in
 * `schemas-common.test.ts` rather than smeared across every fixture here.
 */

import { describe, expect, test } from 'bun:test'

import type { MessageWithAgent } from '../crud/messages'
import type { PlayerStateWithLocation } from '../crud/player-state'
import type {
  Agent as AgentRow,
  Location as LocationRow,
  PlayerState as PlayerStateRow,
  Room as RoomRow,
  World as WorldRow,
} from '../db/schema'
import { Agent, toAgent } from '../schemas/agents'
import {
  GameStateResponse,
  ImportableWorld,
  Location,
  PlayerState,
  StatDefinitions,
  World,
  WorldResetResponse,
  WorldSummary,
  parseStatDefinitionsColumn,
  toImportableWorld,
  toInventoryItem,
  toLocation,
  toPlayerState,
  toStatDefinitions,
  toWorld,
  toWorldSummary,
} from '../schemas/game'
import { Message, PollResponse, toMessage } from '../schemas/messages'
import { Room, RoomSummary, toRoom, toRoomSummary, type RoomResponseSource } from '../schemas/rooms'

const CREATED = new Date('2026-08-06T04:14:54.931Z')
const UPDATED = new Date('2026-08-07T01:02:03Z')

// ---------------------------------------------------------------------------
// Row fixtures
// ---------------------------------------------------------------------------

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 1,
    name: 'Frieren',
    worldName: 'Eldoria',
    group: null,
    configFile: null,
    profilePic: '/agents/frieren/profile.png',
    inANutshell: 'nut',
    characteristics: 'ch',
    recentEvents: 're',
    systemPrompt: 'sp',
    interruptEveryTurn: false,
    priority: 3,
    transparent: true,
    createdAt: CREATED,
    ...overrides,
  }
}

function messageRow(overrides: Partial<MessageWithAgent> = {}): MessageWithAgent {
  return {
    id: 7,
    roomId: 2,
    agentId: 1,
    content: 'hi',
    role: 'assistant',
    participantType: null,
    participantName: null,
    thinking: 'th',
    anthropicCalls: '["a","b"]',
    timestamp: CREATED,
    imageData: null,
    imageMediaType: null,
    images: '[{"data":"x","media_type":"image/png"}]',
    chatSessionId: null,
    gameTimeSnapshot: '{"hour":9,"minute":30,"day":2}',
    agent: agentRow(),
    ...overrides,
  }
}

function roomRow(overrides: Partial<RoomRow> = {}): RoomRow {
  return {
    id: 2,
    ownerId: 'admin',
    name: 'Location: Village',
    maxInteractions: null,
    isPaused: false,
    isFinished: false,
    createdAt: CREATED,
    lastActivityAt: null,
    lastReadAt: null,
    worldId: 3,
    ...overrides,
  }
}

function worldRow(overrides: Partial<WorldRow> = {}): WorldRow {
  return {
    id: 3,
    name: 'Eldoria',
    ownerId: 'admin',
    userName: 'Traveler',
    language: 'ko',
    phase: 'active',
    genre: 'fantasy',
    theme: 'dark',
    statDefinitions: '{"stats":[{"name":"hp","display":"HP","min":0,"max":100,"default":50,"color":"#f00"}]}',
    onboardingRoomId: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    lastPlayedAt: null,
    ...overrides,
  }
}

function locationRow(overrides: Partial<LocationRow> = {}): LocationRow {
  return {
    id: 5,
    worldId: 3,
    name: 'village',
    displayName: 'Village',
    description: 'A quiet village.',
    label: 'home',
    positionX: 1,
    positionY: 2,
    adjacentLocations: '[6,7]',
    roomId: 2,
    isCurrent: true,
    isDiscovered: true,
    isDraft: false,
    ...overrides,
  }
}

function playerStateRow(overrides: Partial<PlayerStateWithLocation> = {}): PlayerStateWithLocation {
  const base: PlayerStateRow = {
    id: 9,
    worldId: 3,
    currentLocationId: 5,
    turnCount: 4,
    stats: '{"hp":10}',
    inventory: '[{"item_id":"sword","name":"Sword","quantity":1}]',
    effects: '[{"n":1}]',
    actionHistory: '[{"turn":1,"action":"a","result":"r"}]',
    isChatMode: false,
    chatModeStartMessageId: null,
    chatSessionId: null,
  }
  return { ...base, currentLocation: locationRow(), ...overrides }
}

const NO_OVERLAY = { inventory: [], gameTime: null, equipment: null }

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

describe('toAgent', () => {
  test('produces the Python field order and values', () => {
    const result = toAgent(agentRow())
    expect(result).toEqual({
      name: 'Frieren',
      group: null,
      config_file: null,
      profile_pic: '/agents/frieren/profile.png',
      in_a_nutshell: 'nut',
      characteristics: 'ch',
      recent_events: 're',
      interrupt_every_turn: false,
      priority: 3,
      id: 1,
      system_prompt: 'sp',
      session_id: null,
      created_at: '2026-08-06T04:14:54.931000Z',
    })
    expect(Object.keys(result)).toEqual([
      'name',
      'group',
      'config_file',
      'profile_pic',
      'in_a_nutshell',
      'characteristics',
      'recent_events',
      'interrupt_every_turn',
      'priority',
      'id',
      'system_prompt',
      'session_id',
      'created_at',
    ])
    expect(Agent.parse(result)).toEqual(result)
  })

  test('session_id is always null — there is no such column', () => {
    expect(toAgent(agentRow()).session_id).toBeNull()
  })

  test('world_name is not exposed', () => {
    expect(toAgent(agentRow())).not.toHaveProperty('world_name')
  })

  test('NULL priority and interrupt_every_turn fall back to their declared defaults', () => {
    const result = toAgent(agentRow({ priority: null, interruptEveryTurn: null }))
    expect(result.priority).toBe(0)
    expect(result.interrupt_every_turn).toBe(false)
  })

  test('a NULL created_at throws, as Pydantic does for a required datetime', () => {
    expect(() => toAgent(agentRow({ createdAt: null }))).toThrow('Agent.created_at')
  })
})

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

describe('toMessage', () => {
  test('decodes the three JSON columns and flattens the joined agent', () => {
    const result = toMessage(messageRow())
    expect(result).toEqual({
      content: 'hi',
      role: 'assistant',
      participant_type: null,
      participant_name: null,
      images: [{ data: 'x', media_type: 'image/png' }],
      image_data: null,
      image_media_type: null,
      id: 7,
      room_id: 2,
      agent_id: 1,
      thinking: 'th',
      anthropic_calls: ['a', 'b'],
      timestamp: '2026-08-06T04:14:54.931000Z',
      agent_name: 'Frieren',
      agent_profile_pic: '/agents/frieren/profile.png',
      chat_session_id: null,
      game_time_snapshot: { hour: 9, minute: 30, day: 2 },
    })
    expect(Message.parse(result)).toEqual(result)
  })

  test('`images` serializes fifth, keeping its base-class position', () => {
    // Python redeclares `images` on the subclass; Pydantic keeps a redeclared
    // field where the base put it, so it lands between participant_name and
    // image_data rather than at the end.
    expect(Object.keys(toMessage(messageRow()))).toEqual([
      'content',
      'role',
      'participant_type',
      'participant_name',
      'images',
      'image_data',
      'image_media_type',
      'id',
      'room_id',
      'agent_id',
      'thinking',
      'anthropic_calls',
      'timestamp',
      'agent_name',
      'agent_profile_pic',
      'chat_session_id',
      'game_time_snapshot',
    ])
  })

  test('the deprecated image columns are back-filled into `images` and also kept', () => {
    const result = toMessage(
      messageRow({ images: null, imageData: 'ddd', imageMediaType: 'image/webp' }),
    )
    expect(result.images).toEqual([{ data: 'ddd', media_type: 'image/webp' }])
    expect(result.image_data).toBe('ddd')
    expect(result.image_media_type).toBe('image/webp')
  })

  test('the back-fill needs both legacy columns', () => {
    expect(toMessage(messageRow({ images: null, imageData: 'ddd', imageMediaType: null })).images).toBeNull()
  })

  test('an existing images blob wins over the legacy columns', () => {
    const result = toMessage(messageRow({ imageData: 'ddd', imageMediaType: 'image/webp' }))
    expect(result.images).toEqual([{ data: 'x', media_type: 'image/png' }])
  })

  test('undecodable JSON columns become null instead of failing the row', () => {
    const result = toMessage(
      messageRow({ anthropicCalls: 'notjson', gameTimeSnapshot: 'bad', images: '{' }),
    )
    expect(result.anthropic_calls).toBeNull()
    expect(result.game_time_snapshot).toBeNull()
    expect(result.images).toBeNull()
  })

  test('a message with no agent reports null name and picture', () => {
    const result = toMessage(messageRow({ agent: null, agentId: null }))
    expect(result.agent_name).toBeNull()
    expect(result.agent_profile_pic).toBeNull()
  })

  test('an unrecognized participant_type degrades to null rather than 500-ing', () => {
    expect(toMessage(messageRow({ participantType: 'npc' })).participant_type).toBeNull()
    expect(toMessage(messageRow({ participantType: 'system' })).participant_type).toBe('system')
  })

  test('a NULL timestamp throws', () => {
    expect(() => toMessage(messageRow({ timestamp: null as unknown as Date }))).toThrow('Message.timestamp')
  })
})

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

describe('toRoom / toRoomSummary', () => {
  function roomWithRelations(overrides: Partial<RoomResponseSource> = {}): RoomResponseSource {
    return {
      ...roomRow(),
      agents: [agentRow()],
      messages: [messageRow()],
      world: worldRow(),
      ...overrides,
    }
  }

  test('inlines the cast and the transcript, and reads the phase through the world', () => {
    const result = toRoom(roomWithRelations())
    expect(Object.keys(result)).toEqual([
      'name',
      'id',
      'owner_id',
      'max_interactions',
      'is_paused',
      'is_finished',
      'created_at',
      'last_activity_at',
      'agents',
      'messages',
      'world_id',
      'world_phase',
    ])
    expect(result.world_id).toBe(3)
    expect(result.world_phase).toBe('active')
    expect(result.agents).toEqual([toAgent(agentRow())])
    expect(result.messages).toEqual([toMessage(messageRow())])
    expect(Room.parse(result)).toEqual(result)
  })

  test('a room with no world has a null phase', () => {
    expect(toRoom(roomWithRelations({ world: null, worldId: null })).world_phase).toBeNull()
  })

  test('resolves a message author from the room cast when the row carries no join', () => {
    // `crud.getRoom` does not join agents onto the room's messages the way
    // Python's selectinload chain does; the mapper covers the gap.
    const { agent: _joined, ...bare } = messageRow()
    const result = toRoom(roomWithRelations({ messages: [bare] }))
    expect(result.messages[0]?.agent_name).toBe('Frieren')
  })

  test('an author who has left the room reports a null name', () => {
    const { agent: _joined, ...bare } = messageRow()
    const result = toRoom(roomWithRelations({ messages: [bare], agents: [] }))
    expect(result.messages[0]?.agent_name).toBeNull()
  })

  test('NULL is_paused / is_finished serialize as false', () => {
    const result = toRoom(roomWithRelations({ isPaused: null, isFinished: null }))
    expect(result.is_paused).toBe(false)
    expect(result.is_finished).toBe(false)
  })

  test('the summary drops agents, messages and the world link', () => {
    const result = toRoomSummary(roomRow({ lastActivityAt: UPDATED }))
    expect(result).toEqual({
      name: 'Location: Village',
      id: 2,
      owner_id: 'admin',
      max_interactions: null,
      is_paused: false,
      is_finished: false,
      created_at: '2026-08-06T04:14:54.931000Z',
      last_activity_at: '2026-08-07T01:02:03Z',
    })
    expect(RoomSummary.parse(result)).toEqual(result)
  })
})

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

describe('toWorldSummary / toWorld', () => {
  test('the summary is the row, snake-cased', () => {
    const result = toWorldSummary(worldRow())
    expect(result).toEqual({
      name: 'Eldoria',
      user_name: 'Traveler',
      language: 'ko',
      id: 3,
      owner_id: 'admin',
      phase: 'active',
      genre: 'fantasy',
      theme: 'dark',
      onboarding_room_id: 1,
      created_at: '2026-08-06T04:14:54.931000Z',
      updated_at: '2026-08-07T01:02:03Z',
      last_played_at: null,
    })
    expect(WorldSummary.parse(result)).toEqual(result)
  })

  test('NULL language and phase fall back to the declared defaults', () => {
    const result = toWorldSummary(worldRow({ language: null, phase: null }))
    expect(result.language).toBe('en')
    expect(result.phase).toBe('onboarding')
  })

  test('a NULL updated_at throws', () => {
    expect(() => toWorldSummary(worldRow({ updatedAt: null }))).toThrow('WorldSummary.updated_at')
  })

  test('without an overlay, lore is null and stats come from the column', () => {
    const result = toWorld(worldRow())
    expect(result.lore).toBeNull()
    expect(result.stat_definitions).toEqual({
      stats: [{ name: 'hp', display: 'HP', min: 0, max: 100, default: 50, color: '#f00' }],
    })
    expect(Object.keys(result).slice(-2)).toEqual(['stat_definitions', 'lore'])
    expect(World.parse(result)).toEqual(result)
  })

  test('the filesystem overlay replaces both fields', () => {
    const overlay = { lore: '# Eldoria', stat_definitions: { stats: [] } }
    const result = toWorld(worldRow(), overlay)
    expect(result.lore).toBe('# Eldoria')
    expect(result.stat_definitions).toEqual({ stats: [] })
  })

  test('a bare array in the stat_definitions column is normalized to the wrapper', () => {
    const result = parseStatDefinitionsColumn('[{"name":"hp","display":"HP"}]')
    expect(result).toEqual({ stats: [{ name: 'hp', display: 'HP', min: null, max: null, default: 0, color: null }] })
  })

  test('an unreadable stat_definitions column gives null', () => {
    expect(parseStatDefinitionsColumn('not json')).toBeNull()
    expect(parseStatDefinitionsColumn(null)).toBeNull()
  })

  test('toStatDefinitions throws on a malformed stats.json entry', () => {
    expect(toStatDefinitions([{ name: 'hp', display: 'HP', color: '#f00', extra: 1 }])).toEqual({
      stats: [{ name: 'hp', display: 'HP', min: null, max: null, default: 0, color: '#f00' }],
    })
    expect(() => toStatDefinitions([{ name: 'hp' }])).toThrow()
    expect(StatDefinitions.parse(toStatDefinitions([]))).toEqual({ stats: [] })
  })
})

describe('toImportableWorld', () => {
  test('maps a world folder that has no database row', () => {
    const result = toImportableWorld({
      name: 'Eldoria',
      ownerId: 'admin',
      userName: '손님',
      language: 'ko',
      phase: 'onboarding',
      genre: null,
      theme: null,
      createdAt: CREATED,
    })
    expect(result).toEqual({
      name: 'Eldoria',
      owner_id: 'admin',
      user_name: '손님',
      language: 'ko',
      phase: 'onboarding',
      genre: null,
      theme: null,
      created_at: '2026-08-06T04:14:54.931000Z',
    })
    expect(ImportableWorld.parse(result)).toEqual(result)
  })

  test('an unrecognized language or phase in world.json falls back to the defaults', () => {
    const result = toImportableWorld({
      name: 'w',
      ownerId: null,
      userName: null,
      language: 'fr',
      phase: 'paused',
      genre: null,
      theme: null,
      createdAt: null,
    })
    expect(result.language).toBe('en')
    expect(result.phase).toBe('onboarding')
    expect(result.created_at).toBeNull()
  })
})

describe('WorldResetResponse', () => {
  test('is a plain hand-built response', () => {
    expect(
      WorldResetResponse.parse({
        success: true,
        message: "World 'Eldoria' has been reset to its initial state",
        world_id: 3,
        starting_location: 'Village',
      }),
    ).toEqual({
      success: true,
      message: "World 'Eldoria' has been reset to its initial state",
      world_id: 3,
      starting_location: 'Village',
    })
  })
})

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

describe('toLocation', () => {
  test('decodes the adjacency list', () => {
    const result = toLocation(locationRow())
    expect(result).toEqual({
      name: 'village',
      display_name: 'Village',
      description: 'A quiet village.',
      id: 5,
      world_id: 3,
      label: 'home',
      position_x: 1,
      position_y: 2,
      adjacent_locations: [6, 7],
      room_id: 2,
      is_current: true,
      is_discovered: true,
      is_draft: false,
    })
    expect(Location.parse(result)).toEqual(result)
  })

  test('reproduced bug: is_draft is forced false whenever adjacencies decode', () => {
    // Python's `parse_adjacent_locations` rebuilds the model as a dict that omits
    // `is_draft`, so the field falls back to its default. Kept so the Phase 4
    // parity diff stays clean; nothing in frontend/ reads it.
    expect(toLocation(locationRow({ isDraft: true })).is_draft).toBe(false)
  })

  test('...but a location with no adjacencies reports is_draft honestly', () => {
    const result = toLocation(locationRow({ adjacentLocations: null, isDraft: true }))
    expect(result.adjacent_locations).toBeNull()
    expect(result.is_draft).toBe(true)
  })

  test('an unreadable adjacency column gives null and leaves is_draft alone', () => {
    const result = toLocation(locationRow({ adjacentLocations: 'bad', isDraft: true }))
    expect(result.adjacent_locations).toBeNull()
    expect(result.is_draft).toBe(true)
  })

  test('NULL positions and is_discovered take their declared defaults', () => {
    const result = toLocation(
      locationRow({ positionX: null, positionY: null, isDiscovered: null, isCurrent: null }),
    )
    expect(result.position_x).toBe(0)
    expect(result.position_y).toBe(0)
    // `is_discovered` defaults to True, `is_current` to False — not the same fold.
    expect(result.is_discovered).toBe(true)
    expect(result.is_current).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------

describe('toPlayerState', () => {
  test('merges the row with the filesystem overlay', () => {
    const result = toPlayerState(playerStateRow(), {
      inventory: [{ item_id: 'sword', name: 'Sword', quantity: 1, properties: { sharpness: 3 } }],
      gameTime: { hour: 9, minute: 30, day: 2 },
      equipment: { main_hand: 'sword', off_hand: null },
    })
    expect(result).toEqual({
      turn_count: 4,
      id: 9,
      world_id: 3,
      current_location_id: 5,
      current_location_name: 'Village',
      stats: { hp: 10 },
      inventory: [
        { id: 'sword', name: 'Sword', description: null, quantity: 1, properties: { sharpness: 3 } },
      ],
      effects: [{ n: 1 }],
      action_history: [{ turn: 1, action: 'a', result: 'r' }],
      is_chat_mode: false,
      chat_mode_start_message_id: null,
      game_time: { hour: 9, minute: 30, day: 2 },
      equipment: { main_hand: 'sword', off_hand: null },
    })
    expect(Object.keys(result)).toEqual([
      'turn_count',
      'id',
      'world_id',
      'current_location_id',
      'current_location_name',
      'stats',
      'inventory',
      'effects',
      'action_history',
      'is_chat_mode',
      'chat_mode_start_message_id',
      'game_time',
      'equipment',
    ])
    expect(PlayerState.parse(result)).toEqual(result)
  })

  test('empty JSON columns are null, not {} or []', () => {
    // The /state route decodes with a bare `json.loads` behind a truthiness
    // check, so an unset column and an empty one are both null on the wire.
    // `PlayerStateSerializer`'s empty-collection defaults do not apply here.
    const result = toPlayerState(
      playerStateRow({ stats: null, effects: '', actionHistory: null }),
      NO_OVERLAY,
    )
    expect(result.stats).toBeNull()
    expect(result.effects).toBeNull()
    expect(result.action_history).toBeNull()
  })

  test('inventory is always a list, never null, on this path', () => {
    expect(toPlayerState(playerStateRow(), NO_OVERLAY).inventory).toEqual([])
  })

  test('the location name prefers display_name and falls back to the folder name', () => {
    expect(
      toPlayerState(playerStateRow({ currentLocation: locationRow({ displayName: null }) }), NO_OVERLAY)
        .current_location_name,
    ).toBe('village')
    expect(
      toPlayerState(playerStateRow({ currentLocation: null, currentLocationId: null }), NO_OVERLAY)
        .current_location_name,
    ).toBeNull()
  })

  test('a world with no player.json has neither a clock nor equipment', () => {
    const result = toPlayerState(playerStateRow(), NO_OVERLAY)
    expect(result.game_time).toBeNull()
    expect(result.equipment).toBeNull()
  })

  test('NULL turn_count and is_chat_mode take their declared defaults', () => {
    const result = toPlayerState(playerStateRow({ turnCount: null, isChatMode: null }), NO_OVERLAY)
    expect(result.turn_count).toBe(0)
    expect(result.is_chat_mode).toBe(false)
  })
})

describe('toInventoryItem', () => {
  test('renames item_id to id', () => {
    expect(toInventoryItem({ item_id: 'rope', name: 'Rope' })).toEqual({
      id: 'rope',
      name: 'Rope',
      description: null,
      quantity: 1,
      properties: null,
    })
  })

  test('item_id wins over id when both are present', () => {
    expect(toInventoryItem({ item_id: 'rope', id: 'other', name: 'Rope' }).id).toBe('rope')
  })

  test('falls back to id, then to the empty string', () => {
    expect(toInventoryItem({ id: 'rope', name: 'Rope' }).id).toBe('rope')
    expect(toInventoryItem({ name: 'Rope' }).id).toBe('')
    expect(toInventoryItem({}).name).toBe('')
  })

  test('drops keys the response model does not declare', () => {
    const result = toInventoryItem({ item_id: 'rope', name: 'Rope', instance_properties: { worn: true } })
    expect(result).not.toHaveProperty('instance_properties')
  })
})

// ---------------------------------------------------------------------------
// Unused-but-ported
// ---------------------------------------------------------------------------

describe('PollResponse', () => {
  test('defaults to an empty message list and no state', () => {
    // Declared by schemas/messages.py and used by nothing — the poll route
    // builds its own dict with a different message shape.
    expect(PollResponse.parse({})).toEqual({ messages: [], state: null, location: null })
  })
})

describe('GameStateResponse', () => {
  test('nests a world summary, a player state, and an optional location', () => {
    // Also unused: no route returns it. Pinned so the composition stays correct
    // if one ever does.
    const result = GameStateResponse.parse({
      world: toWorldSummary(worldRow()),
      player_state: toPlayerState(playerStateRow(), NO_OVERLAY),
      current_location: toLocation(locationRow()),
    })
    expect(result.world.name).toBe('Eldoria')
    expect(result.player_state.id).toBe(9)
    expect(result.current_location?.id).toBe(5)
    expect(result.suggestions).toBeNull()
  })

  test('the location and the suggestions are both optional', () => {
    const result = GameStateResponse.parse({
      world: toWorldSummary(worldRow()),
      player_state: toPlayerState(playerStateRow(), NO_OVERLAY),
    })
    expect(result.current_location).toBeNull()
    expect(result.suggestions).toBeNull()
  })
})
