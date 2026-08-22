/**
 * The game surface as the React app sees it: worlds, actions, chat mode, state
 * and locations.
 *
 * Every assertion here is about the wire — status code, `detail` string, body
 * keys — because that is what the parity contract freezes and what
 * `frontend/src/services/gameService.ts` reads without knowing which backend
 * answered. Nothing reaches inside a handler.
 *
 * The polling endpoints have their own file; they are the subtlest part of this
 * surface and deserve the room.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resetSettings } from '../config/settings'
import { WorldResetService } from '../services/world-reset-service'
import {
  createGameApp,
  guestToken,
  rawExec,
  rawQuery,
  settle,
  type GameAppHarness,
} from './setup/game-app'

const originalEnv = { ...process.env }

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

// =============================================================================
// Authentication and access control
// =============================================================================

describe('access control', () => {
  test('the game surface is behind authentication', async () => {
    const response = await app.request('/worlds', { token: null })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: 'Invalid or missing authentication token' })
  })

  test('a guest sees none of the admin\'s worlds', async () => {
    const response = await app.request('/worlds', { token: await guestToken() })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  test('a guest reading someone else\'s world gets 403 "Not your world"', async () => {
    const response = await app.request('/worlds/1', { token: await guestToken() })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ detail: 'Not your world' })
  })

  /**
   * The delete handler is the one place Python words the 403 differently. It is
   * observable — the frontend surfaces `detail` verbatim — so it is pinned.
   */
  test('the delete 403 carries its own detail string', async () => {
    const response = await app.request('/worlds/1', {
      method: 'DELETE',
      token: await guestToken(),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ detail: 'Not authorized to delete this world' })
  })

  test('an unknown world is 404 before it is 403', async () => {
    const response = await app.request('/worlds/999', { token: await guestToken() })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: 'World not found' })
  })

  test('a non-numeric world id is a 422, not a 404', async () => {
    const response = await app.request('/worlds/abc')

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      detail: [{ loc: ['path', 'world_id'], type: 'int_parsing' }],
    })
  })
})

// =============================================================================
// Worlds
// =============================================================================

describe('GET /worlds', () => {
  test('lists the caller\'s worlds as summaries', async () => {
    const worlds = await app.json<Record<string, unknown>[]>('/worlds')

    expect(worlds).toHaveLength(1)
    expect(worlds[0]).toMatchObject({
      id: 1,
      name: 'asdf',
      owner_id: 'admin',
      user_name: '손님',
      language: 'ko',
      phase: 'onboarding',
      onboarding_room_id: 1,
      last_played_at: null,
    })
  })

  /**
   * Python's canonical path is `/worlds/` and Starlette redirects `/worlds` onto
   * it; the frontend only ever sends the unslashed form. Both must answer, or
   * one of the two backends 404s where the other 200s.
   */
  test('answers on the trailing-slash spelling too', async () => {
    const slashed = await app.request('/worlds/')
    expect(slashed.status).toBe(200)
    expect(await slashed.json()).toEqual(await app.json('/worlds'))
  })
})

describe('POST /worlds', () => {
  test('creates the filesystem tree, the row, and the onboarding trigger', async () => {
    const response = await app.request('/worlds', {
      method: 'POST',
      body: JSON.stringify({ name: 'new_world', user_name: 'Hero', language: 'en' }),
    })

    expect(response.status).toBe(200)
    const created = (await response.json()) as { id: number; onboarding_room_id: number }
    expect(created).toMatchObject({
      name: 'new_world',
      user_name: 'Hero',
      language: 'en',
      phase: 'onboarding',
      owner_id: 'admin',
    })

    // The filesystem is written first and is the source of truth.
    expect(app.state.services.worlds.loadWorldConfig('new_world')).toMatchObject({
      name: 'new_world',
      ownerId: 'admin',
      phase: 'onboarding',
    })

    // `_state.json` is what links the on-disk world to its database room.
    expect(app.state.services.rooms.getRoomMapping('new_world', 'onboarding')).toMatchObject({
      dbRoomId: created.onboarding_room_id,
      agents: ['Onboarding_Manager'],
    })

    // The trigger message is written but not acted on: `/start-onboarding` does
    // that, once the client is listening.
    const messages = rawQuery<{ content: string; participant_type: string }>(
      app.dbPath,
      `SELECT content, participant_type FROM messages WHERE room_id = ${created.onboarding_room_id}`,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]!.participant_type).toBe('system')
    expect(app.turns).toEqual([])
  })

  test('rejects a duplicate name with 400', async () => {
    const response = await app.request('/worlds', {
      method: 'POST',
      body: JSON.stringify({ name: 'asdf' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: "World 'asdf' already exists" })
  })

  test('a body with no name is a 422', async () => {
    const response = await app.request('/worlds', { method: 'POST', body: JSON.stringify({}) })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ detail: [{ loc: ['body', 'name'] }] })
  })
})

describe('GET /worlds/{id}', () => {
  test('overlays lore and stat definitions from the filesystem', async () => {
    const world = await app.json<Record<string, unknown>>('/worlds/1')

    expect(world).toMatchObject({ id: 1, name: 'asdf', phase: 'onboarding' })
    // `lore.md` from the fixture, not the (empty) `stat_definitions` column.
    expect(world.lore).toContain('# World Lore')
    expect(world.stat_definitions).toEqual({ stats: [] })
  })

  /**
   * `world.json` is the source of truth for phase, genre, theme and user name.
   * Reading the world is one of the two places that copies a filesystem change
   * onto the row — the other is the poll.
   */
  test('syncs phase and genre from world.json onto the row', async () => {
    const worlds = app.state.services.worlds
    const config = worlds.loadWorldConfig('asdf')!
    config.phase = 'active'
    config.genre = 'noir'
    worlds.saveWorldConfig('asdf', config)

    const world = await app.json<Record<string, unknown>>('/worlds/1')

    expect(world).toMatchObject({ phase: 'active', genre: 'noir' })
    expect(rawQuery<{ phase: string; genre: string }>(app.dbPath, 'SELECT phase, genre FROM worlds WHERE id = 1')[0])
      .toEqual({ phase: 'active', genre: 'noir' })
  })
})

describe('DELETE /worlds/{id}', () => {
  test('removes the rows and the world directory', async () => {
    const response = await app.request('/worlds/1', { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'deleted' })
    expect(rawQuery(app.dbPath, 'SELECT id FROM worlds')).toEqual([])
    expect(app.state.services.worlds.worldExists('asdf')).toBe(false)
  })
})

describe('import', () => {
  test('offers on-disk worlds the database does not know about', async () => {
    app.state.services.worlds.createWorld('orphan', 'someone-else', 'Wanderer', 'en')

    const importable = await app.json<Record<string, unknown>[]>('/worlds/importable')

    // "asdf" is in the database already, so only the orphan is offered.
    expect(importable).toHaveLength(1)
    expect(importable[0]).toMatchObject({
      name: 'orphan',
      owner_id: 'someone-else',
      user_name: 'Wanderer',
      phase: 'onboarding',
    })
  })

  /**
   * `/importable` and `/{world_id}` both match this path. Registration order is
   * what decides, and getting it wrong turns the import picker into a 422.
   */
  test('/importable is not swallowed by the /{world_id} route', async () => {
    const response = await app.request('/worlds/importable')
    expect(response.status).toBe(200)
  })

  test('adopts an on-disk world, and refuses to adopt it twice', async () => {
    app.state.services.worlds.createWorld('orphan', 'admin', 'Wanderer', 'en')

    const first = await app.request('/worlds/import/orphan', { method: 'POST' })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ name: 'orphan', owner_id: 'admin' })

    const second = await app.request('/worlds/import/orphan', { method: 'POST' })
    expect(second.status).toBe(400)
    expect(await second.json()).toEqual({
      detail: "World 'orphan' already exists in database",
    })
  })

  test('importing a world that is not on disk is a 404', async () => {
    const response = await app.request('/worlds/import/nope', { method: 'POST' })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      detail: "World 'nope' not found in filesystem",
    })
  })
})

describe('characters and history', () => {
  test('reports an empty cast for a world with no locations', async () => {
    expect(await app.json<Record<string, unknown>>('/worlds/1/characters')).toEqual({ characters: [] })
  })

  test('returns history.md verbatim', async () => {
    expect(await app.json<Record<string, unknown>>('/worlds/1/history')).toEqual({ history: '# World History\n\n' })
  })

  /**
   * The fixture world's `history.md` holds only its heading, so there is
   * nothing to batch and the summarizer is never reached — which is the point:
   * this asserts the route reaches the real service and returns its result,
   * without the test depending on a model. The batching and summarizing are
   * covered by `history-compression.test.ts`.
   */
  test('history compression returns the service result', async () => {
    const response = await app.request('/worlds/1/history/compress', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      // `success: true` for an empty history is Python's own answer: nothing to
      // compress is not a failure.
      success: true,
      turns_compressed: 0,
      sections_created: 0,
      message: 'No history to compress',
    })
  })
})

describe('POST /worlds/{id}/start-onboarding', () => {
  test('starts the interview turn in the onboarding room', async () => {
    const response = await app.request('/worlds/1/start-onboarding', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'started' })

    await settle()
    expect(app.turns).toHaveLength(1)
    expect(app.turns[0]).toMatchObject({ kind: 'gameplay', roomId: 1, worldId: 1 })
  })

  test('refuses once the world has left onboarding', async () => {
    const worlds = app.state.services.worlds
    const config = worlds.loadWorldConfig('asdf')!
    config.phase = 'active'
    worlds.saveWorldConfig('asdf', config)
    // The row is what this endpoint checks, so it has to be synced first.
    await app.request('/worlds/1')

    const response = await app.request('/worlds/1/start-onboarding', { method: 'POST' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: 'World is not in onboarding phase' })
  })

  /**
   * No ownership check, deliberately: Python takes the identity dependency and
   * never reads it. Pinned because "fixing" it would be a silent contract change.
   */
  test('is reachable by any authenticated caller', async () => {
    const response = await app.request('/worlds/1/start-onboarding', {
      method: 'POST',
      token: await guestToken(),
    })

    expect(response.status).toBe(200)
  })
})

describe('reset', () => {
  test('refuses without confirm, before it even looks the world up', async () => {
    const response = await app.request('/worlds/999/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: false }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: 'Must set confirm=true to reset world' })
  })

  test('refuses to reset a world still in onboarding', async () => {
    const response = await app.request('/worlds/1/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: 'Can only reset active worlds' })
  })
})

/**
 * Entering a world is the transition from "onboarding finished" to "playable":
 * it resets to `_initial.json`, adopts the starting location from disk, writes
 * the arrival line and runs the opening turn.
 */
describe('POST /worlds/{id}/enter', () => {
  async function seedActiveWorld(): Promise<number> {
    const { worlds, locations } = app.state.services

    worlds.createWorld('quest', 'admin', 'Hero', 'en')
    const config = worlds.loadWorldConfig('quest')!
    config.phase = 'active'
    worlds.saveWorldConfig('quest', config)

    locations.createLocation('quest', 'village', 'Village', 'A quiet village.', [0, 0])

    new WorldResetService(app.worldsDir).saveInitialState(
      'quest',
      WorldResetService.createInitialStateSnapshot({
        startingLocation: 'village',
        initialStats: { hp: 10 },
        initialInventory: [],
      }),
    )

    const imported = (await app.json('/worlds/import/quest', { method: 'POST' })) as { id: number }
    return imported.id
  }

  test('resets, adopts the starting location, and opens the scene', async () => {
    const worldId = await seedActiveWorld()

    const response = await app.request(`/worlds/${worldId}/enter`, { method: 'POST' })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { world: { id: number }; arrival_message_sent: boolean }
    expect(body.arrival_message_sent).toBe(true)
    expect(body.world.id).toBe(worldId)

    // The location existed only on disk; the reset created its row and room.
    const location = rawQuery<{ id: number; room_id: number; is_discovered: number }>(
      app.dbPath,
      `SELECT id, room_id, is_discovered FROM locations WHERE world_id = ${worldId}`,
    )[0]!
    expect(location.is_discovered).toBe(1)

    // Player state comes from `_initial.json`, not from the empty import.
    const player = rawQuery<{ stats: string; turn_count: number; current_location_id: number }>(
      app.dbPath,
      `SELECT stats, turn_count, current_location_id FROM player_states WHERE world_id = ${worldId}`,
    )[0]!
    expect(JSON.parse(player.stats)).toEqual({ hp: 10 })
    expect(player.turn_count).toBe(0)
    expect(player.current_location_id).toBe(location.id)

    // The arrival line is a real system message *and* the opening turn's action.
    const arrival = rawQuery<{ content: string; participant_type: string }>(
      app.dbPath,
      `SELECT content, participant_type FROM messages WHERE room_id = ${location.room_id}`,
    )
    expect(arrival).toHaveLength(1)
    expect(arrival[0]!.participant_type).toBe('system')

    await settle()
    expect(app.turns).toHaveLength(1)
    expect(app.turns[0]).toMatchObject({ kind: 'gameplay', roomId: location.room_id })
    expect(app.turns[0]!.action).toBe(arrival[0]!.content)
  })

  test('a world with no _initial.json cannot be entered', async () => {
    const { worlds } = app.state.services
    worlds.createWorld('bare', 'admin', 'Hero', 'en')
    const config = worlds.loadWorldConfig('bare')!
    config.phase = 'active'
    worlds.saveWorldConfig('bare', config)

    const imported = (await app.json('/worlds/import/bare', { method: 'POST' })) as { id: number }
    const response = await app.request(`/worlds/${imported.id}/enter`, { method: 'POST' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: 'No initial state found for this world' })
  })

  test('a world still in onboarding cannot be entered', async () => {
    const response = await app.request('/worlds/1/enter', { method: 'POST' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      detail: 'World is not ready yet (still in onboarding phase)',
    })
  })
})

// =============================================================================
// Actions
// =============================================================================

describe('POST /worlds/{id}/action', () => {
  test('stores the message, advances the turn, and runs the tape in the background', async () => {
    const response = await app.request('/worlds/1/action', {
      method: 'POST',
      body: JSON.stringify({ text: 'look around' }),
    })

    // Answered immediately: everything the agents produce arrives via `/poll`.
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'processing',
      message: 'Action received, processing turn...',
      turn: 1,
    })

    const message = rawQuery<{ content: string; role: string }>(
      app.dbPath,
      "SELECT content, role FROM messages WHERE room_id = 1 AND participant_type = 'user' ORDER BY id DESC LIMIT 1",
    )[0]!
    expect(message).toEqual({ content: 'look around', role: 'user' })

    await settle()
    expect(app.turns).toEqual([
      { kind: 'gameplay', roomId: 1, worldId: 1, action: 'look around' },
    ])

    // The background task seeds the room's gameplay agents before the tape is
    // built — a room created before they existed would otherwise have no Action
    // Manager to run.
    const members = rawQuery<{ name: string }>(
      app.dbPath,
      'SELECT a.name FROM room_agents ra JOIN agents a ON a.id = ra.agent_id WHERE ra.room_id = 1 ORDER BY a.name',
    ).map((row) => row.name)
    expect(members).toEqual(['Action_Manager', 'Narrator', 'Onboarding_Manager'])
  })

  test('records the attempt in the action history', async () => {
    await app.request('/worlds/1/action', {
      method: 'POST',
      body: JSON.stringify({ text: 'open the door' }),
    })

    const history = rawQuery<{ action_history: string }>(
      app.dbPath,
      'SELECT action_history FROM player_states WHERE world_id = 1',
    )[0]!
    expect(JSON.parse(history.action_history)).toEqual([
      { turn: 1, action: 'open the door', result: 'Processing...' },
    ])
  })

  test('a body with no text is a 422 even for a world that does not exist', async () => {
    const response = await app.request('/worlds/999/action', {
      method: 'POST',
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(422)
  })

  test('suggestions come from _state.json', async () => {
    app.state.services.rooms.saveSuggestions('asdf', ['go north', 'wait'])

    expect(await app.json<Record<string, unknown>>('/worlds/1/action/suggestions')).toEqual({
      suggestions: ['go north', 'wait'],
    })
  })
})

// =============================================================================
// Chat mode
// =============================================================================

describe('slash commands', () => {
  /** Chat mode is a gameplay feature; during onboarding it is refused — with a 200. */
  test('/chat during onboarding is refused in the body, not the status', async () => {
    const response = await app.request('/worlds/1/action', {
      method: 'POST',
      body: JSON.stringify({ text: '/chat' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'error',
      message: 'Chat mode is only available during active gameplay.',
    })
  })

  test('/end outside chat mode says so', async () => {
    const response = await app.request('/worlds/1/action', {
      method: 'POST',
      body: JSON.stringify({ text: '/end' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'not_in_chat_mode',
      message: 'You are not in chat mode.',
    })
  })
})

/**
 * The full chat-mode cycle needs an active world with a location, because the
 * `/chat` command is gated on the phase and the messages are gated on there
 * being a current location.
 */
describe('chat mode', () => {
  let worldId: number
  let roomId: number

  beforeEach(async () => {
    const { worlds, locations } = app.state.services
    worlds.createWorld('tavern', 'admin', 'Hero', 'en')
    const config = worlds.loadWorldConfig('tavern')!
    config.phase = 'active'
    worlds.saveWorldConfig('tavern', config)
    locations.createLocation('tavern', 'bar', 'The Bar', 'Loud.', [0, 0])

    new WorldResetService(app.worldsDir).saveInitialState(
      'tavern',
      WorldResetService.createInitialStateSnapshot({
        startingLocation: 'bar',
        initialStats: {},
        initialInventory: [],
      }),
    )

    const imported = (await app.json('/worlds/import/tavern', { method: 'POST' })) as { id: number }
    worldId = imported.id
    await app.request(`/worlds/${worldId}/enter`, { method: 'POST' })
    await settle()
    app.turns.length = 0

    roomId = rawQuery<{ room_id: number }>(
      app.dbPath,
      `SELECT room_id FROM locations WHERE world_id = ${worldId}`,
    )[0]!.room_id
  })

  test('/chat enters chat mode and marks the resume point', async () => {
    const response = await app.request(`/worlds/${worldId}/action`, {
      method: 'POST',
      body: JSON.stringify({ text: '/chat' }),
    })

    expect(response.status).toBe(200)
    expect((await response.json()) as { status: string }).toMatchObject({
      status: 'chat_mode_started',
    })

    const player = rawQuery<{ is_chat_mode: number; chat_session_id: number; chat_mode_start_message_id: number }>(
      app.dbPath,
      `SELECT is_chat_mode, chat_session_id, chat_mode_start_message_id FROM player_states WHERE world_id = ${worldId}`,
    )[0]!
    expect(player.is_chat_mode).toBe(1)
    expect(player.chat_session_id).toBeGreaterThan(0)
    // The marker is the arrival message written by `/enter`.
    expect(player.chat_mode_start_message_id).toBeGreaterThan(0)
  })

  test('/chat twice is a no-op with its own status', async () => {
    await app.request(`/worlds/${worldId}/action`, {
      method: 'POST',
      body: JSON.stringify({ text: '/chat' }),
    })
    const response = await app.request(`/worlds/${worldId}/action`, {
      method: 'POST',
      body: JSON.stringify({ text: '/chat' }),
    })

    expect(await response.json()).toEqual({
      status: 'already_in_chat_mode',
      message: 'You are already in chat mode. Type /end to return to gameplay.',
    })
  })

  test('a message in chat mode runs the chat tape and is tagged with the session', async () => {
    await app.request(`/worlds/${worldId}/action`, {
      method: 'POST',
      body: JSON.stringify({ text: '/chat' }),
    })
    const sessionId = rawQuery<{ chat_session_id: number }>(
      app.dbPath,
      `SELECT chat_session_id FROM player_states WHERE world_id = ${worldId}`,
    )[0]!.chat_session_id

    const response = await app.request(`/worlds/${worldId}/action`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hello there' }),
    })

    expect(await response.json()).toEqual({
      status: 'processing',
      message: 'Message received, NPCs are responding...',
    })

    const stored = rawQuery<{ content: string; chat_session_id: number }>(
      app.dbPath,
      `SELECT content, chat_session_id FROM messages WHERE room_id = ${roomId} ORDER BY id DESC LIMIT 1`,
    )[0]!
    expect(stored).toEqual({ content: 'hello there', chat_session_id: sessionId })

    // Chat mode does not advance the game.
    expect(
      rawQuery<{ turn_count: number }>(
        app.dbPath,
        `SELECT turn_count FROM player_states WHERE world_id = ${worldId}`,
      )[0]!.turn_count,
    ).toBe(0)

    await settle()
    expect(app.turns).toEqual([
      { kind: 'chat', roomId, worldId, action: 'hello there', chatSessionId: sessionId },
    ])
  })

  test('/end with no interaction exits silently, without a summarizer turn', async () => {
    await app.request(`/worlds/${worldId}/action`, {
      method: 'POST',
      body: JSON.stringify({ text: '/chat' }),
    })

    const response = await app.request(`/worlds/${worldId}/action`, {
      method: 'POST',
      body: JSON.stringify({ text: '/end' }),
    })

    expect(await response.json()).toEqual({
      status: 'chat_mode_ended',
      message: 'Exited chat mode.',
    })
    expect(
      rawQuery<{ is_chat_mode: number }>(
        app.dbPath,
        `SELECT is_chat_mode FROM player_states WHERE world_id = ${worldId}`,
      )[0]!.is_chat_mode,
    ).toBe(0)

    await settle()
    expect(app.turns).toEqual([])
  })
})

// =============================================================================
// Game state
// =============================================================================

describe('game state', () => {
  test('assembles the player state from the row plus player.json', async () => {
    const state = await app.json<Record<string, unknown>>('/worlds/1/state')

    expect(state).toMatchObject({
      id: 1,
      world_id: 1,
      turn_count: 0,
      current_location_id: null,
      current_location_name: null,
      is_chat_mode: false,
      inventory: [],
    })
    // The clock and equipment are filesystem-primary; the columns hold neither.
    expect(state.game_time).toEqual({ hour: 8, minute: 0, day: 1 })
    expect(state.equipment).toEqual({})
  })

  test('stats come back with their definitions, and tolerate a missing player row', async () => {
    expect(await app.json<Record<string, unknown>>('/worlds/1/state/stats')).toEqual({ definitions: [], current: {} })
  })

  test('inventory is resolved from player.json, not the column', async () => {
    expect(await app.json<Record<string, unknown>>('/worlds/1/state/inventory')).toEqual({ items: [], count: 0 })
  })

  test('the item catalogue is empty for a world with no items/', async () => {
    expect(await app.json<Record<string, unknown>>('/worlds/1/items')).toEqual({ items: [], count: 0 })
  })

  test('a missing world is a 404 on the state endpoints too', async () => {
    const response = await app.request('/worlds/999/state')
    expect(response.status).toBe(404)
  })
})

// =============================================================================
// Locations
// =============================================================================

describe('locations', () => {
  let worldId: number
  let locationId: number

  beforeEach(async () => {
    const { worlds, locations } = app.state.services
    worlds.createWorld('map', 'admin', 'Hero', 'en')
    const config = worlds.loadWorldConfig('map')!
    config.phase = 'active'
    worlds.saveWorldConfig('map', config)
    locations.createLocation('map', 'village', 'Village', 'Quiet.', [1, 2])
    locations.createLocation('map', 'cave', 'Cave', 'Dark.', [3, 4])

    new WorldResetService(app.worldsDir).saveInitialState(
      'map',
      WorldResetService.createInitialStateSnapshot({
        startingLocation: 'village',
        initialStats: {},
        initialInventory: [],
      }),
    )

    const imported = (await app.json('/worlds/import/map', { method: 'POST' })) as { id: number }
    worldId = imported.id
    await app.request(`/worlds/${worldId}/enter`, { method: 'POST' })
    await settle()
    app.turns.length = 0

    locationId = rawQuery<{ id: number }>(
      app.dbPath,
      `SELECT id FROM locations WHERE world_id = ${worldId} AND name = 'village'`,
    )[0]!.id
  })

  test('lists only discovered locations by default', async () => {
    const discovered = await app.json<Record<string, unknown>[]>(`/worlds/${worldId}/locations`)

    expect(discovered).toHaveLength(1)
    expect(discovered[0]).toMatchObject({
      id: locationId,
      name: 'village',
      display_name: 'Village',
      is_discovered: true,
      position_x: 1,
      position_y: 2,
    })
  })

  test('discovered_only=false widens the listing', async () => {
    rawExec(app.dbPath, `UPDATE locations SET is_discovered = 0 WHERE world_id = ${worldId}`)

    expect(await app.json<unknown[]>(`/worlds/${worldId}/locations`)).toEqual([])
    expect(
      await app.json<unknown[]>(`/worlds/${worldId}/locations?discovered_only=false`),
    ).toHaveLength(1)
  })

  test('an unparseable boolean query is a 422', async () => {
    const response = await app.request(`/worlds/${worldId}/locations?discovered_only=maybe`)

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      detail: [{ loc: ['query', 'discovered_only'], type: 'bool_parsing' }],
    })
  })

  test('reports the current location', async () => {
    const current = await app.json<Record<string, unknown>>(`/worlds/${worldId}/locations/current`)
    expect(current).toMatchObject({ id: locationId, name: 'village' })
  })

  test('a world with nobody anywhere has no current location', async () => {
    const response = await app.request('/worlds/1/locations/current')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: 'No current location' })
  })

  test('travel moves the player in the database and in _state.json', async () => {
    const response = await app.request(
      `/worlds/${worldId}/locations/${locationId}/travel`,
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'traveled',
      destination: 'Village',
      location_id: locationId,
    })
    expect(app.state.services.rooms.getCurrentRoom('map')).toBe('location:village')
  })

  test('travelling to a location in another world is a 404', async () => {
    const response = await app.request(`/worlds/1/locations/${locationId}/travel`, {
      method: 'POST',
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: 'Location not found' })
  })

  test('a label is the one field the player can set', async () => {
    const response = await app.request(`/worlds/${worldId}/locations/${locationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: 'home' }),
    })

    expect(response.status).toBe(200)
    expect((await response.json()) as { label: string }).toMatchObject({ label: 'home' })
  })

  test('location messages use the poll message shape', async () => {
    const body = await app.json<{ messages: Record<string, unknown>[] }>(
      `/worlds/${worldId}/locations/${locationId}/messages`,
    )

    expect(body.messages).toHaveLength(1)
    const message = body.messages[0]!
    expect(Object.keys(message).sort()).toEqual([
      'agent_id',
      'agent_name',
      'agent_profile_pic',
      'content',
      'game_time_snapshot',
      'id',
      'image_data',
      'image_media_type',
      'role',
      'thinking',
      'timestamp',
    ])
    // `datetime.isoformat()` on a naive column: a `T`, and no zone designator.
    expect(message.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?$/)
  })
})
