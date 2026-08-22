/**
 * `GET /worlds/{id}/poll` and `GET /worlds/{id}/chatting-agents`.
 *
 * Split out from `game-routes.test.ts` because the poll is the endpoint the
 * whole frontend lives on and is not a read: it syncs the world's phase from
 * `world.json`, imports `player.json` into the database on the first request
 * after onboarding, writes the arrival message, and starts the opening turn.
 * Each of those is a distinct scenario with its own fixture.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resetSettings } from '../config/settings'
import { addAgentToRoom } from '../crud/rooms'
import { invalidateRoomCache } from '../crud/cache-invalidation'
import { createGameApp, rawExec, rawQuery, settle, type GameAppHarness } from './setup/game-app'

const originalEnv = { ...process.env }

const ONBOARDING_ROOM_ID = 1
const ACTION_MANAGER_ID = 2

interface PollBody {
  messages: { id: number; content: string; timestamp: string; thinking: string | null }[]
  state: {
    stats: Record<string, unknown>
    inventory_count: number
    turn_count: number
    phase: string
    pending_phase: string | null
    is_chat_mode: boolean
    chat_mode_start_message_id: number | null
    game_time: { hour: number; minute: number; day: number } | null
  } | null
  location?: { id: number; name: string }
  suggestions?: string[]
}

let app: GameAppHarness

beforeEach(async () => {
  app = await createGameApp()
})

afterEach(() => {
  app.cleanup()
})

afterAll(() => {
  process.env = { ...originalEnv }
  resetSettings()
})

/** Flip `world.json`, which is the source of truth the poll syncs *from*. */
function setFsPhase(worldName: string, phase: string, pendingPhase: string | null = null): void {
  const worlds = app.state.services.worlds
  const config = worlds.loadWorldConfig(worldName)!
  config.phase = phase
  config.pendingPhase = pendingPhase
  worlds.saveWorldConfig(worldName, config)
}

// =============================================================================
// Onboarding
// =============================================================================

describe('polling during onboarding', () => {
  test('returns the room transcript with system messages filtered out', async () => {
    const body = await app.json<PollBody>('/worlds/1/poll')

    // The fixture room holds three rows; the first is the system trigger that
    // starts the interview, and the player must never see it.
    expect(body.messages.map((m) => m.content)).toEqual(['반갑습니다.', '(무시함)'])
    expect(body.state).toEqual({
      stats: {},
      inventory_count: 0,
      turn_count: 0,
      phase: 'onboarding',
      pending_phase: null,
      is_chat_mode: false,
      chat_mode_start_message_id: null,
      game_time: { hour: 8, minute: 0, day: 1 },
    })
    // No location during onboarding: the key is absent, not null.
    expect('location' in body).toBe(false)
    expect(body.suggestions).toEqual([])
  })

  /**
   * Naive ISO, no `Z`. Every other timestamp in the API carries one; this
   * endpoint builds its messages by hand with `datetime.isoformat()`, and the
   * frontend parses what it is given.
   */
  test('message timestamps are the naive isoformat the poll alone uses', async () => {
    const body = await app.json<PollBody>('/worlds/1/poll')

    // The stored column reads `...04.245555`; `Date` resolves to milliseconds,
    // so the sub-millisecond digits become padding. The divergence is the port's
    // clock resolution, documented on `schemas/common.ts::serializeUtcDatetime`,
    // and `new Date(s)` parses both to the same instant.
    expect(body.messages[0]!.timestamp).toBe('2026-08-06T04:15:04.245000')
  })

  test('since_message_id returns only what the client has not seen', async () => {
    const all = await app.json<PollBody>('/worlds/1/poll')
    const lastId = all.messages[all.messages.length - 1]!.id

    const empty = await app.json<PollBody>(`/worlds/1/poll?since_message_id=${lastId}`)
    expect(empty.messages).toEqual([])

    const one = await app.json<PollBody>(`/worlds/1/poll?since_message_id=${lastId - 1}`)
    expect(one.messages.map((m) => m.content)).toEqual(['(무시함)'])
  })

  test('suggestions ride along on every poll, changed or not', async () => {
    app.state.services.rooms.saveSuggestions('asdf', ['ask about the town'])

    const body = await app.json<PollBody>('/worlds/1/poll')
    expect(body.suggestions).toEqual(['ask about the town'])
  })

  test('an unparseable poll_onboarding is a 422', async () => {
    const response = await app.request('/worlds/1/poll?poll_onboarding=perhaps')

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      detail: [{ loc: ['query', 'poll_onboarding'], type: 'bool_parsing' }],
    })
  })

  /** `"false"` is a truthy JavaScript string; pydantic reads it as false. */
  test('poll_onboarding=false is honoured as false', async () => {
    setFsPhase('asdf', 'active')

    const body = await app.json<PollBody>('/worlds/1/poll?poll_onboarding=false')

    // Active phase, no current location, so there is no room to poll at all —
    // which is the point: it did not fall back to the onboarding room.
    expect(body).toEqual({ messages: [], state: null })
  })
})

// =============================================================================
// Phase sync
// =============================================================================

describe('phase sync', () => {
  /**
   * The onboarding `complete` tool writes `pending_phase` into `world.json`.
   * Reporting it is what makes the frontend's "Enter World" banner appear, so it
   * has to survive the poll untouched — the phase itself is still `onboarding`.
   */
  test('reports a pending phase without applying it', async () => {
    setFsPhase('asdf', 'onboarding', 'active')

    const body = await app.json<PollBody>('/worlds/1/poll')

    expect(body.state).toMatchObject({ phase: 'onboarding', pending_phase: 'active' })
    expect(rawQuery<{ phase: string }>(app.dbPath, 'SELECT phase FROM worlds WHERE id = 1')[0])
      .toEqual({ phase: 'onboarding' })
  })

  /**
   * `poll_onboarding` keeps the client on the interview room after the phase has
   * already flipped, so the last few lines of the conversation do not vanish
   * from under the player at the moment the seed generator finishes.
   */
  test('poll_onboarding keeps the onboarding room after the phase flips', async () => {
    setFsPhase('asdf', 'active')

    const body = await app.json<PollBody>('/worlds/1/poll?poll_onboarding=true')

    expect(body.messages.map((m) => m.content)).toEqual(['반갑습니다.', '(무시함)'])
    expect(body.state).toMatchObject({ phase: 'active' })
    // The synced phase is written through, not just reported.
    expect(rawQuery<{ phase: string }>(app.dbPath, 'SELECT phase FROM worlds WHERE id = 1')[0])
      .toEqual({ phase: 'active' })
  })

  test('syncs user_name, genre and theme as well as the phase', async () => {
    const worlds = app.state.services.worlds
    const config = worlds.loadWorldConfig('asdf')!
    config.userName = '모험가'
    config.genre = 'fantasy'
    config.theme = 'redemption'
    worlds.saveWorldConfig('asdf', config)

    await app.json<PollBody>('/worlds/1/poll')

    expect(
      rawQuery<{ user_name: string; genre: string; theme: string }>(
        app.dbPath,
        'SELECT user_name, genre, theme FROM worlds WHERE id = 1',
      )[0],
    ).toEqual({ user_name: '모험가', genre: 'fantasy', theme: 'redemption' })
  })
})

// =============================================================================
// The onboarding → gameplay handover
// =============================================================================

/**
 * The most load-bearing behaviour in this file. When onboarding finishes, the
 * seed generator has written `player.json` and a location directory, and the
 * database knows about neither. The first poll of the now-active world has to
 * import all of it, write the arrival line, and start the opening turn — all
 * without the player having typed anything.
 */
describe('post-onboarding player-state sync', () => {
  let worldId: number

  beforeEach(async () => {
    const { worlds, locations, players } = app.state.services

    worlds.createWorld('seeded', 'admin', 'Rin', 'en')
    setFsPhase('seeded', 'active')
    locations.createLocation('seeded', 'glade', 'Glade', 'Sunlit.', [0, 0])

    // What the World Seed Generator leaves behind.
    players.savePlayerState('seeded', {
      currentLocation: 'glade',
      turnCount: 0,
      stats: { hp: 12 },
      inventory: [{ item_id: 'lantern', quantity: 1 }],
      effects: [],
      recentActions: [],
      gameTime: { hour: 9, minute: 30, day: 2 },
      equipment: {},
      flags: {},
    })

    const imported = (await app.json('/worlds/import/seeded', { method: 'POST' })) as { id: number }
    worldId = imported.id

    // The import mirrors stats and inventory but never a location, which is the
    // exact state the sync path keys off.
    expect(
      rawQuery<{ current_location_id: number | null }>(
        app.dbPath,
        `SELECT current_location_id FROM player_states WHERE world_id = ${worldId}`,
      )[0]!.current_location_id,
    ).toBeNull()
  })

  test('adopts the location, sends the arrival line and opens the scene', async () => {
    const body = await app.json<PollBody>(`/worlds/${worldId}/poll`)

    const location = rawQuery<{ id: number; room_id: number; name: string }>(
      app.dbPath,
      `SELECT id, room_id, name FROM locations WHERE world_id = ${worldId}`,
    )[0]!
    expect(location.name).toBe('glade')

    // The poll now reports where the player is standing.
    expect(body.location).toEqual({ id: location.id, name: 'Glade' })
    expect(body.state).toMatchObject({
      phase: 'active',
      turn_count: 0,
      game_time: { hour: 9, minute: 30, day: 2 },
    })

    // The arrival line is a *system* message, so it is written but not shown.
    expect(body.messages).toEqual([])
    const arrival = rawQuery<{ content: string; participant_type: string }>(
      app.dbPath,
      `SELECT content, participant_type FROM messages WHERE room_id = ${location.room_id}`,
    )
    expect(arrival).toHaveLength(1)
    expect(arrival[0]!.participant_type).toBe('system')
    expect(arrival[0]!.content).toContain('Rin')

    // …and it is the action the opening turn answers.
    await settle()
    expect(app.turns).toHaveLength(1)
    expect(app.turns[0]).toMatchObject({ kind: 'gameplay', roomId: location.room_id })
    expect(app.turns[0]!.action).toBe(arrival[0]!.content)

    // `_state.json` now maps the location to its new room.
    expect(app.state.services.rooms.getRoomMapping('seeded', 'location:glade')).toMatchObject({
      dbRoomId: location.room_id,
    })
  })

  test('runs exactly once — a second poll neither re-arrives nor re-opens', async () => {
    await app.json<PollBody>(`/worlds/${worldId}/poll`)
    await settle()
    const turnsAfterFirst = app.turns.length

    await app.json<PollBody>(`/worlds/${worldId}/poll`)
    await settle()

    expect(app.turns).toHaveLength(turnsAfterFirst)
    expect(
      rawQuery(app.dbPath, `SELECT id FROM messages WHERE room_id IN (SELECT room_id FROM locations WHERE world_id = ${worldId})`),
    ).toHaveLength(1)
  })
})

// =============================================================================
// A stalled opening scene
// =============================================================================

/**
 * The opening turn runs in the background with nothing behind it, so a backend
 * that stops before the `narration` tool call leaves a room holding only the
 * arrival line — which the poll filters out as a system message. The player is
 * then looking at an empty world. These pin the poll's recovery of that state.
 */
describe('restarting a stalled opening scene', () => {
  let worldId: number
  let roomId: number

  /** The arrival line as it looks two minutes after nobody answered it. */
  function backdateArrival(minutes: number): void {
    rawExec(
      app.dbPath,
      `UPDATE messages SET timestamp = datetime('now', '-${minutes} minutes')
       WHERE room_id = ${roomId} AND participant_type = 'system'`,
    )
  }

  beforeEach(async () => {
    const { worlds, locations, players } = app.state.services

    worlds.createWorld('stalled', 'admin', 'Rin', 'en')
    setFsPhase('stalled', 'active')
    locations.createLocation('stalled', 'glade', 'Glade', 'Sunlit.', [0, 0])
    players.savePlayerState('stalled', {
      currentLocation: 'glade',
      turnCount: 0,
      stats: {},
      inventory: [],
      effects: [],
      recentActions: [],
      gameTime: { hour: 9, minute: 0, day: 1 },
      equipment: {},
      flags: {},
    })

    const imported = (await app.json('/worlds/import/stalled', { method: 'POST' })) as { id: number }
    worldId = imported.id

    // The first poll is the one that adopts the location, writes the arrival
    // line and starts the opening turn — the turn this suite then strands.
    await app.json<PollBody>(`/worlds/${worldId}/poll`)
    await settle()
    roomId = rawQuery<{ room_id: number }>(
      app.dbPath,
      `SELECT room_id FROM locations WHERE world_id = ${worldId}`,
    )[0]!.room_id
    expect(app.turns).toHaveLength(1)
    app.turns.length = 0
  })

  test('restarts the turn, replaying the arrival line the room already holds', async () => {
    backdateArrival(3)

    await app.json<PollBody>(`/worlds/${worldId}/poll`)
    await settle()

    expect(app.turns).toHaveLength(1)
    expect(app.turns[0]).toMatchObject({ kind: 'gameplay', roomId })

    // The stranded arrival is replayed, not duplicated: a second system line
    // would make the Action Manager narrate two arrivals.
    const systemLines = rawQuery<{ content: string }>(
      app.dbPath,
      `SELECT content FROM messages WHERE room_id = ${roomId} AND participant_type = 'system'`,
    )
    expect(systemLines).toHaveLength(1)
    expect(app.turns[0]!.action).toBe(systemLines[0]!.content)
  })

  test('restarts once — a turn that keeps failing is not relaunched every poll', async () => {
    backdateArrival(3)

    await app.json<PollBody>(`/worlds/${worldId}/poll`)
    await settle()
    await app.json<PollBody>(`/worlds/${worldId}/poll`)
    await settle()

    expect(app.turns).toHaveLength(1)
  })

  test('leaves a fresh arrival alone — the opening is slow, not dead', async () => {
    await app.json<PollBody>(`/worlds/${worldId}/poll`)
    await settle()

    expect(app.turns).toEqual([])
  })

  test('leaves a room that has narrated alone', async () => {
    backdateArrival(3)
    rawExec(
      app.dbPath,
      `INSERT INTO messages (room_id, agent_id, content, role, participant_type, timestamp)
       VALUES (${roomId}, ${ACTION_MANAGER_ID}, 'The glade opens up.', 'assistant', NULL, datetime('now'))`,
    )
    invalidateRoomCache(roomId)

    await app.json<PollBody>(`/worlds/${worldId}/poll`)
    await settle()

    expect(app.turns).toEqual([])
  })
})

// =============================================================================
// Chat-mode filtering
// =============================================================================

describe('chat-mode message partitioning', () => {
  test('gameplay polls exclude chat-session messages', async () => {
    rawExec(
      app.dbPath,
      `INSERT INTO messages (room_id, agent_id, content, role, participant_type, chat_session_id, timestamp)
       VALUES (1, NULL, 'side chat', 'user', 'user', 99, '2026-08-21 06:00:00.000000')`,
    )

    // `poll_onboarding` shows everything — the onboarding room has no chat mode.
    const onboarding = await app.json<PollBody>('/worlds/1/poll?poll_onboarding=true')
    expect(onboarding.messages.map((m) => m.content)).toContain('side chat')

    // A gameplay poll of the same room does not.
    rawExec(app.dbPath, `UPDATE worlds SET phase = 'onboarding' WHERE id = 1`)
    const filtered = await app.json<PollBody>('/worlds/1/poll?since_message_id=0')
    expect(filtered.messages.map((m) => m.content)).not.toContain('side chat')
  })
})

// =============================================================================
// Chatting agents
// =============================================================================

describe('GET /worlds/{id}/chatting-agents', () => {
  test('is empty when nothing is running', async () => {
    expect(await app.json<Record<string, unknown>>('/worlds/1/chatting-agents')).toEqual({
      chatting_agents: [],
    })
  })

  test('reports the agents with a live session in the polled room', async () => {
    app.busyAgents.set(ONBOARDING_ROOM_ID, [1])

    const body = await app.json<{ chatting_agents: Record<string, unknown>[] }>(
      '/worlds/1/chatting-agents',
    )

    expect(body.chatting_agents).toEqual([
      {
        id: 1,
        name: 'Onboarding_Manager',
        profile_pic: null,
        // Known gap: the streaming registry Python reads these from has no
        // TypeScript counterpart yet, so they are always empty.
        thinking_text: '',
        response_text: '',
      },
    ])
  })

  /**
   * `has_narrated` is what unblocks the player's input box: the Action Manager
   * keeps working after the prose is on screen, and waiting for the turn to end
   * would leave the player staring at a disabled field.
   */
  test('the Action Manager carries has_narrated, and no avatar', async () => {
    addAgentToRoom(app.db, ONBOARDING_ROOM_ID, ACTION_MANAGER_ID)
    invalidateRoomCache(ONBOARDING_ROOM_ID)
    app.busyAgents.set(ONBOARDING_ROOM_ID, [ACTION_MANAGER_ID])

    const before = await app.json<{ chatting_agents: { has_narrated: boolean }[] }>(
      '/worlds/1/chatting-agents',
    )
    expect(before.chatting_agents[0]).toMatchObject({
      name: 'Action_Manager',
      profile_pic: null,
      has_narrated: false,
    })

    app.state.orchestrator.setNarrationProduced(ONBOARDING_ROOM_ID)

    const after = await app.json<{ chatting_agents: { has_narrated: boolean }[] }>(
      '/worlds/1/chatting-agents',
    )
    expect(after.chatting_agents[0]!.has_narrated).toBe(true)
  })

  /**
   * The two virtual rows. Both do tens of seconds of work without owning a room
   * agent, and the ids are negative so the frontend cannot collapse them into a
   * real agent's row.
   */
  test('the world seed generator appears as id -1', async () => {
    app.state.orchestrator.setSeedGenerationActive(ONBOARDING_ROOM_ID)

    const body = await app.json<{ chatting_agents: Record<string, unknown>[] }>(
      '/worlds/1/chatting-agents',
    )

    expect(body.chatting_agents).toEqual([
      {
        id: -1,
        name: 'World Seed Generator',
        profile_pic: null,
        thinking_text: 'Creating your world...',
        response_text: '',
      },
    ])
  })

  test('a Task sub-agent appears as id -2', async () => {
    app.state.orchestrator.setSubAgentActive(
      ONBOARDING_ROOM_ID,
      'Chat_Summarizer',
      'Summarizing conversation...',
    )

    const body = await app.json<{ chatting_agents: Record<string, unknown>[] }>(
      '/worlds/1/chatting-agents',
    )

    expect(body.chatting_agents).toEqual([
      {
        id: -2,
        name: 'Chat_Summarizer',
        profile_pic: null,
        thinking_text: 'Summarizing conversation...',
        response_text: '',
      },
    ])
  })

  test('is behind the same ownership check as the rest of the surface', async () => {
    const response = await app.request('/worlds/999/chatting-agents')
    expect(response.status).toBe(404)
  })
})
