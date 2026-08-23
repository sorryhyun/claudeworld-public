/**
 * The filesystem ↔ database bridge.
 *
 * Every test runs against both halves at once — a temp `worlds/` tree and a
 * temp database built from the Drizzle migrations — because that pairing is the
 * only thing this class does. Asserting one side alone would pass for a method
 * that silently stopped writing the other.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgent } from '@/crud/agents'
import { getLocations } from '@/crud/locations'
import { addInventoryItem, getPlayerState, incrementTurn, updateStats } from '@/crud/player-state'
import { getAgentsInRoom } from '@/crud/rooms'
import { createWorld } from '@/crud/worlds'
import { openDb, type Db } from '@/db'
import { applyMigrations, loadMigrations } from '@/db/migrate'
import { locations, worlds } from '@/db/schema'
import { LocationStorage } from '@/services/location-storage'
import { PersistenceManager } from '@/services/persistence-manager'
import { PlayerService } from '@/services/player-service'
import { RoomMappingService } from '@/services/room-mapping'
import { WorldService } from '@/services/world-service'

const migrations = loadMigrations()

const WORLD = 'mythos'
const OWNER = 'admin'

let dir: string
let worldsDir: string
let db: Db
let worldId: number
let pm: PersistenceManager
let worldService: WorldService
let playerService: PlayerService
let locationStorage: LocationStorage
let roomMapping: RoomMappingService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-pm-'))
  worldsDir = join(dir, 'worlds')
  mkdirSync(worldsDir, { recursive: true })

  const raw = new Database(join(dir, 'test.db'), { create: true, strict: true })
  try {
    applyMigrations(raw, migrations)
  } finally {
    raw.close()
  }
  db = openDb({ path: join(dir, 'test.db') })

  // Fresh services per test, so nothing inherits another test's mtime cache.
  worldService = new WorldService(worldsDir)
  playerService = new PlayerService(worldsDir)
  locationStorage = new LocationStorage(worldsDir)
  roomMapping = new RoomMappingService(worldsDir)

  worldService.createWorld(WORLD, OWNER, 'Traveller', 'en')
  worldId = createWorld(db, { name: WORLD }, OWNER).id
  pm = new PersistenceManager(db, worldId, WORLD, worldsDir)
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function readIndex(): Record<string, Record<string, unknown>> {
  const raw = readFileSync(join(worldsDir, WORLD, 'locations', '_index.json'), 'utf-8')
  return (JSON.parse(raw) as { locations: Record<string, Record<string, unknown>> }).locations
}

// ============================================================================
// createLocation
// ============================================================================

describe('createLocation', () => {
  test('writes the filesystem, the database and the room mapping', () => {
    const locationId = pm.createLocation({
      name: 'tavern',
      displayName: 'The Rusty Anchor',
      description: 'Warm, loud, smells of ale.',
      position: [3, 4],
      adjacentHints: ['road'],
      agents: ['Elara'],
    })

    // Filesystem
    const locationDir = join(worldsDir, WORLD, 'locations', 'tavern')
    expect(readFileSync(join(locationDir, 'description.md'), 'utf-8')).toBe(
      '# The Rusty Anchor\n\nWarm, loud, smells of ale.\n',
    )
    expect(existsSync(join(locationDir, 'events.md'))).toBe(true)
    expect(readIndex().tavern).toMatchObject({
      name: 'The Rusty Anchor',
      position: [3, 4],
      is_discovered: true,
      adjacent: ['road'],
    })

    // Database
    const row = db.select().from(locations).where(eq(locations.id, locationId)).get()
    expect(row).toBeDefined()
    expect(row!.name).toBe('tavern')
    expect(row!.displayName).toBe('The Rusty Anchor')
    expect(row!.positionX).toBe(3)
    expect(row!.positionY).toBe(4)
    expect(row!.isDiscovered).toBe(true)
    expect(row!.roomId).not.toBeNull()

    // Room mapping — the link between the two
    const mapping = roomMapping.getRoomMapping(WORLD, 'location:tavern')
    expect(mapping?.dbRoomId).toBe(row!.roomId!)
    expect(mapping?.agents).toEqual(['Elara'])
  })

  test('adjacency hints reach the filesystem but never the database column', () => {
    const locationId = pm.createLocation({
      name: 'tavern',
      displayName: 'Tavern',
      description: '',
      position: [0, 0],
      adjacentHints: ['road', 'docks'],
    })

    expect(readIndex().tavern?.adjacent).toEqual(['road', 'docks'])
    // Names would be unreadable in a column every reader parses as location ids.
    expect(
      db.select().from(locations).where(eq(locations.id, locationId)).get()!.adjacentLocations,
    ).toBeNull()
  })

  test('a starting location becomes the current location and the current room', () => {
    const locationId = pm.createLocation({
      name: 'tavern',
      displayName: 'Tavern',
      description: '',
      position: [0, 0],
      isStarting: true,
    })

    expect(getPlayerState(db, worldId)?.currentLocation?.id).toBe(locationId)
    expect(
      db.select().from(locations).where(eq(locations.id, locationId)).get()!.isCurrent,
    ).toBe(true)
    expect(roomMapping.getCurrentRoom(WORLD)).toBe('location:tavern')
  })

  test('a non-starting location leaves the current room alone', () => {
    pm.createLocation({
      name: 'tavern',
      displayName: 'Tavern',
      description: '',
      position: [0, 0],
    })

    expect(roomMapping.getCurrentRoom(WORLD)).toBeNull()
    expect(getPlayerState(db, worldId)?.currentLocation).toBeNull()
  })
})

// ============================================================================
// syncPlayerStateFromFilesystem
// ============================================================================

describe('syncPlayerStateFromFilesystem', () => {
  /** Write a `player.json` describing a character mid-adventure. */
  function writeFsPlayerState(overrides: Record<string, unknown> = {}): void {
    const state = playerService.loadPlayerState(WORLD)!
    playerService.savePlayerState(WORLD, {
      ...state,
      stats: { hp: 12, sanity: 4 },
      inventory: [{ item_id: 'iron_sword', quantity: 2 }],
      ...overrides,
    })
  }

  test('copies stats into the database', () => {
    writeFsPlayerState()

    pm.syncPlayerStateFromFilesystem()

    expect(JSON.parse(getPlayerState(db, worldId)!.stats!)).toEqual({ hp: 12, sanity: 4 })
  })

  test('copies inventory across in the reference shape, names and all', () => {
    writeFsPlayerState()

    pm.syncPlayerStateFromFilesystem()

    const inventory = JSON.parse(getPlayerState(db, worldId)!.inventory!) as Record<
      string,
      unknown
    >[]
    expect(inventory).toHaveLength(1)
    // The parity landmine: `player.json` holds a reference, so the name and
    // description the database ends up with are empty. Python does the same.
    expect(inventory[0]).toEqual({
      item_id: 'iron_sword',
      name: '',
      description: '',
      quantity: 2,
      properties: {},
    })
  })

  test('materialises a location that only exists on disk', () => {
    locationStorage.createLocation(WORLD, 'tavern', 'The Tavern', 'Warm.', [2, 5], [])
    writeFsPlayerState({ currentLocation: 'tavern' })

    pm.syncPlayerStateFromFilesystem()

    const created = getLocations(db, worldId)
    expect(created).toHaveLength(1)
    expect(created[0]!.name).toBe('tavern')
    expect(created[0]!.positionX).toBe(2)
    expect(created[0]!.positionY).toBe(5)
    expect(getPlayerState(db, worldId)?.currentLocation?.name).toBe('tavern')
  })

  test('carries the onboarding room mapping and its cast onto the new room', () => {
    locationStorage.createLocation(WORLD, 'tavern', 'The Tavern', 'Warm.', [0, 0], [])
    // Onboarding wrote a mapping with characters but no real room id yet.
    roomMapping.setRoomMapping(WORLD, 'location:tavern', 0, ['Elara'])
    const elara = createAgent(db, { name: 'Elara', systemPrompt: 'x', worldName: WORLD })
    writeFsPlayerState({ currentLocation: 'tavern' })

    pm.syncPlayerStateFromFilesystem()

    const roomId = getLocations(db, worldId)[0]!.roomId!
    expect(roomMapping.getRoomMapping(WORLD, 'location:tavern')).toEqual({
      dbRoomId: roomId,
      agents: ['Elara'],
      createdAt: expect.any(String),
    })
    expect(getAgentsInRoom(db, roomId).map((a) => a.id)).toContain(elara.id)
  })

  test('reuses a location that already exists in the database', () => {
    pm.createLocation({
      name: 'tavern',
      displayName: 'Tavern',
      description: '',
      position: [0, 0],
    })
    writeFsPlayerState({ currentLocation: 'tavern' })

    pm.syncPlayerStateFromFilesystem()

    expect(getLocations(db, worldId)).toHaveLength(1)
  })

  test('a current_location with no filesystem directory is left unset', () => {
    writeFsPlayerState({ currentLocation: 'nowhere' })

    pm.syncPlayerStateFromFilesystem()

    expect(getLocations(db, worldId)).toHaveLength(0)
    expect(getPlayerState(db, worldId)?.currentLocation).toBeNull()
  })

  test('a world with no player.json is a no-op, not a crash', () => {
    rmSync(join(worldsDir, WORLD, 'player.json'))

    expect(() => pm.syncPlayerStateFromFilesystem()).not.toThrow()
    expect(JSON.parse(getPlayerState(db, worldId)!.stats!)).toEqual({})
  })

  test('empty sections do not overwrite what the database already has', () => {
    updateStats(db, worldId, { hp: 7 })
    // `player.json` is the fresh-world one: no stats, no inventory.

    pm.syncPlayerStateFromFilesystem()

    expect(JSON.parse(getPlayerState(db, worldId)!.stats!)).toEqual({ hp: 7 })
  })
})

// ============================================================================
// saveStatDefinitions / updateWorldPhase / syncStats
// ============================================================================

describe('world-level writes', () => {
  test('saveStatDefinitions writes stats.json and the world column', () => {
    const definitions = {
      stats: [{ name: 'hp', display: 'Health', min: 0, max: 20, default: 20 }],
      derived: [],
    }

    pm.saveStatDefinitions(definitions)

    expect(playerService.loadStatDefinitions(WORLD)).toEqual(definitions)
    const column = db.select().from(worlds).where(eq(worlds.id, worldId)).get()!.statDefinitions
    expect(JSON.parse(column!)).toEqual(definitions)
  })

  test('updateWorldPhase moves both sides', () => {
    pm.updateWorldPhase('active')

    expect(worldService.loadWorldConfig(WORLD)?.phase).toBe('active')
    expect(db.select().from(worlds).where(eq(worlds.id, worldId)).get()!.phase).toBe('active')
  })

  test('updateWorldPhase still updates the row when world.json is unreadable', () => {
    rmSync(join(worldsDir, WORLD, 'world.json'))

    pm.updateWorldPhase('ended')

    expect(db.select().from(worlds).where(eq(worlds.id, worldId)).get()!.phase).toBe('ended')
  })

  test('syncStats replaces the database stat block', () => {
    updateStats(db, worldId, { hp: 3 })

    pm.syncStats({ hp: 20, mana: 5 })

    expect(JSON.parse(getPlayerState(db, worldId)!.stats!)).toEqual({ hp: 20, mana: 5 })
  })
})

// ============================================================================
// exportStateToFilesystem
// ============================================================================

describe('exportStateToFilesystem', () => {
  test('writes turn count, stats, inventory and location back to player.json', () => {
    const locationId = pm.createLocation({
      name: 'tavern',
      displayName: 'Tavern',
      description: '',
      position: [0, 0],
      isStarting: true,
    })
    expect(locationId).toBeGreaterThan(0)

    incrementTurn(db, worldId)
    incrementTurn(db, worldId)
    updateStats(db, worldId, { hp: 9 })
    addInventoryItem(db, worldId, { id: 'lantern', name: 'Brass Lantern', quantity: 1 })

    pm.exportStateToFilesystem()

    const state = playerService.loadPlayerState(WORLD)!
    expect(state.turnCount).toBe(2)
    expect(state.stats).toEqual({ hp: 9 })
    expect(state.currentLocation).toBe('tavern')
    // `savePlayerState` rewrites the inventory into reference format on its way
    // out, so what lands on disk is an id and a count.
    expect(state.inventory).toHaveLength(1)
    expect(state.inventory[0]).toMatchObject({ item_id: 'lantern', quantity: 1 })
  })

  test('exports a discovery change onto the location index', () => {
    pm.createLocation({
      name: 'tavern',
      displayName: 'Tavern',
      description: '',
      position: [0, 0],
    })
    db.update(locations).set({ isDiscovered: false }).where(eq(locations.name, 'tavern')).run()

    pm.exportStateToFilesystem()

    expect(readIndex().tavern?.is_discovered).toBe(false)
  })

  test('a world with no player.json still exports, starting from a blank state', () => {
    rmSync(join(worldsDir, WORLD, 'player.json'))
    updateStats(db, worldId, { hp: 4 })

    pm.exportStateToFilesystem()

    const state = playerService.loadPlayerState(WORLD)!
    expect(state.stats).toEqual({ hp: 4 })
    // The documented hole: the clock is reset rather than preserved, because
    // the database has no column for it.
    expect(state.gameTime).toEqual({ hour: 8, minute: 0, day: 1 })
  })

  test('a corrupt stats blob aborts the export instead of blanking player.json', () => {
    writeFileSync(
      join(worldsDir, WORLD, 'player.json'),
      JSON.stringify({ current_location: null, stats: { hp: 5 }, turn_count: 3, inventory: [] }),
      'utf-8',
    )
    db.$client.query("UPDATE player_states SET stats = 'not json'").run()

    expect(() => pm.exportStateToFilesystem()).toThrow()
    // Untouched: the good file survives the failed export.
    expect(new PlayerService(worldsDir).loadPlayerState(WORLD)?.stats).toEqual({ hp: 5 })
  })
})
