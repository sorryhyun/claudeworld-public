/**
 * The player-state write paths — `crud/player-state.ts`.
 *
 * Read paths and `incrementTurn` / `addActionToHistory` are covered by
 * `crud.test.ts`, which runs against a verbatim dump of SQLAlchemy-written DDL.
 * This suite is about the mutations, and two properties matter more than "the
 * SQL runs":
 *
 * 1. **What lands in the four JSON columns is a cross-backend contract.**
 *    `player_states.{stats,inventory}` are read by the Python backend from the
 *    same file, so several tests below assert on the raw column text rather than
 *    on the decoded return value.
 * 2. **A missing player state is never an error.** Every mutation has a
 *    "world has no row" branch returning an empty value, because the tool
 *    handlers that call these treat a stat update as advisory and must not fail
 *    a turn over one.
 *
 * The schema is built from the committed Drizzle baseline; `migrate.test.ts` is
 * what holds that equal to Python's DDL.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addInventoryItem,
  enterChatMode,
  exitChatMode,
  getPlayerState,
  initializePlayerStats,
  removeInventoryItem,
  setCurrentLocation,
  updateStats,
} from '../crud/player-state'
import { openDb, type Db } from '../db'
import { openAndInitDb } from '../db/migrate'
import { locations, playerStates, worlds } from '../db/schema'
import type { InventoryEntry, StatDefinitions } from '../domain/player-rules'

const WORLD_ID = 1
/** A world row with no `player_states` row, for the empty-return branches. */
const EMPTY_WORLD_ID = 2
const VILLAGE_ID = 1
const FOREST_ID = 2

/** Health is bounded, gold is not — the two clamping branches in one fixture. */
const STAT_DEFINITIONS: StatDefinitions = {
  stats: [
    { name: 'health', min: 0, max: 100, default: 100 },
    { name: 'gold', default: 25 },
  ],
}

let dir: string
let dbPath: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-player-'))
  dbPath = join(dir, 'test.db')

  const created = openAndInitDb({ path: dbPath })
  created.close()

  db = openDb({ path: dbPath })
  seed()
})

afterEach(() => {
  setSystemTime()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function seed(): void {
  db.insert(worlds)
    .values([
      { id: WORLD_ID, name: 'testworld', ownerId: 'admin', phase: 'active', language: 'en' },
      { id: EMPTY_WORLD_ID, name: 'stateless', ownerId: 'admin', phase: 'active', language: 'en' },
    ])
    .run()

  // The village starts current and discovered; the forest starts neither, so
  // `setCurrentLocation` has both flags to flip.
  db.insert(locations)
    .values([
      { id: VILLAGE_ID, worldId: WORLD_ID, name: 'Village', isCurrent: true, isDiscovered: true },
      { id: FOREST_ID, worldId: WORLD_ID, name: 'Forest', isCurrent: false, isDiscovered: false },
    ])
    .run()

  db.insert(playerStates)
    .values({
      worldId: WORLD_ID,
      currentLocationId: VILLAGE_ID,
      turnCount: 0,
      stats: '{}',
      inventory: '[]',
      effects: '[]',
      actionHistory: '[]',
    })
    .run()
}

/** Read a column through raw SQL, bypassing the Drizzle decoders. */
function rawValue<T>(sql: string): T {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const row = raw.query<Record<string, T>, []>(sql).get()
    if (!row) throw new Error(`no row for: ${sql}`)
    return Object.values(row)[0] as T
  } finally {
    raw.close()
  }
}

const rawStats = (): string => rawValue<string>(`SELECT stats FROM player_states WHERE world_id = 1`)
const rawInventory = (): string =>
  rawValue<string>(`SELECT inventory FROM player_states WHERE world_id = 1`)

describe('setCurrentLocation', () => {
  test('moves the flag and resolves the new location on the way out', () => {
    const state = setCurrentLocation(db, WORLD_ID, FOREST_ID)!

    expect(state.currentLocationId).toBe(FOREST_ID)
    expect(state.currentLocation?.name).toBe('Forest')

    expect(rawValue<number>(`SELECT is_current FROM locations WHERE id = ${VILLAGE_ID}`)).toBe(0)
    expect(rawValue<number>(`SELECT is_current FROM locations WHERE id = ${FOREST_ID}`)).toBe(1)
  })

  test('visiting a location discovers it', () => {
    // Until this call the forest is undiscovered and invisible in the player's
    // location list; an agent's `travel` tool is what usually gets it there.
    expect(rawValue<number>(`SELECT is_discovered FROM locations WHERE id = ${FOREST_ID}`)).toBe(0)

    setCurrentLocation(db, WORLD_ID, FOREST_ID)

    expect(rawValue<number>(`SELECT is_discovered FROM locations WHERE id = ${FOREST_ID}`)).toBe(1)
  })

  test('works from a null current location without touching anything else', () => {
    db.update(playerStates)
      .set({ currentLocationId: null })
      .where(eq(playerStates.worldId, WORLD_ID))
      .run()

    const state = setCurrentLocation(db, WORLD_ID, FOREST_ID)!

    expect(state.currentLocationId).toBe(FOREST_ID)
    // Nothing cleared the village's flag, because nothing pointed at it.
    expect(rawValue<number>(`SELECT is_current FROM locations WHERE id = ${VILLAGE_ID}`)).toBe(1)
  })

  test('moving to the location already current is a no-op that keeps the flag', () => {
    // The clear-then-set order matters: clearing after setting would leave the
    // player standing in a location marked not-current.
    const state = setCurrentLocation(db, WORLD_ID, VILLAGE_ID)!

    expect(state.currentLocationId).toBe(VILLAGE_ID)
    expect(rawValue<number>(`SELECT is_current FROM locations WHERE id = ${VILLAGE_ID}`)).toBe(1)
  })

  test('rejects a location that does not exist, leaving the old one current', () => {
    // `PRAGMA foreign_keys=ON` is set on both backends' connections, so Python's
    // "assign the id and let the commit fail" lands in the same place.
    expect(() => setCurrentLocation(db, WORLD_ID, 9999)).toThrow()

    expect(getPlayerState(db, WORLD_ID)?.currentLocationId).toBe(VILLAGE_ID)
    expect(rawValue<number>(`SELECT is_current FROM locations WHERE id = ${VILLAGE_ID}`)).toBe(1)
  })

  test('null for a world with no player state', () => {
    expect(setCurrentLocation(db, EMPTY_WORLD_ID, FOREST_ID)).toBeNull()
  })
})

describe('updateStats', () => {
  test('a change to an absent stat starts from zero', () => {
    expect(updateStats(db, WORLD_ID, { gold: 30 })).toEqual({ gold: 30 })
    expect(rawStats()).toBe('{"gold":30}')
  })

  test('clamps to the declared bounds when definitions are given', () => {
    initializePlayerStats(db, WORLD_ID, STAT_DEFINITIONS)

    expect(updateStats(db, WORLD_ID, { health: 50 }, STAT_DEFINITIONS).health).toBe(100)
    expect(updateStats(db, WORLD_ID, { health: -500 }, STAT_DEFINITIONS).health).toBe(0)
    // `gold` declares neither bound, so it is unbounded in both directions.
    expect(updateStats(db, WORLD_ID, { gold: -100 }, STAT_DEFINITIONS).gold).toBe(-75)
  })

  test('without definitions nothing is clamped', () => {
    initializePlayerStats(db, WORLD_ID, STAT_DEFINITIONS)

    // This is the path an ad-hoc stat invented by an agent mid-turn takes.
    expect(updateStats(db, WORLD_ID, { health: 900 }).health).toBe(1000)
  })

  test('leaves untouched stats alone, including non-numeric ones', () => {
    // A string in the blob is malformed, but Python's `current_stats.copy()`
    // preserves it, so filtering it out here would be data loss the other
    // backend never performs.
    db.update(playerStates)
      .set({ stats: '{"health":40,"title":"squire"}' })
      .where(eq(playerStates.worldId, WORLD_ID))
      .run()

    updateStats(db, WORLD_ID, { health: 5 })

    expect(JSON.parse(rawStats())).toEqual({ health: 45, title: 'squire' })
  })

  test('an unreadable blob resets to empty rather than throwing', () => {
    // `PlayerStateSerializer.parseStats` swallows the decode error, which is
    // bad behaviour faithfully reproduced: rows in the wild were written
    // against it, and throwing would make a cosmetically broken world
    // unopenable.
    db.update(playerStates)
      .set({ stats: 'not json' })
      .where(eq(playerStates.worldId, WORLD_ID))
      .run()

    expect(updateStats(db, WORLD_ID, { gold: 1 })).toEqual({ gold: 1 })
  })

  test('empty object for a world with no player state', () => {
    expect(updateStats(db, EMPTY_WORLD_ID, { gold: 5 })).toEqual({})
  })
})

describe('initializePlayerStats', () => {
  test('every declared stat gets its default', () => {
    expect(initializePlayerStats(db, WORLD_ID, STAT_DEFINITIONS)).toEqual({
      health: 100,
      gold: 25,
    })
    expect(JSON.parse(rawStats())).toEqual({ health: 100, gold: 25 })
  })

  test('overrides layer on top and are not clamped', () => {
    // Character creation is trusted: an override may exceed the declared max
    // and may introduce a stat the definitions never mention.
    const stats = initializePlayerStats(db, WORLD_ID, STAT_DEFINITIONS, {
      health: 500,
      luck: 7,
    })

    expect(stats).toEqual({ health: 500, gold: 25, luck: 7 })
  })

  test('replaces the blob rather than merging into it', () => {
    updateStats(db, WORLD_ID, { reputation: 12 })

    // Unlike updateStats, this wipes what was there — which is why only
    // character creation may call it.
    expect(initializePlayerStats(db, WORLD_ID, STAT_DEFINITIONS)).toEqual({
      health: 100,
      gold: 25,
    })
  })

  test('a stat definition with no default lands on zero', () => {
    expect(initializePlayerStats(db, WORLD_ID, { stats: [{ name: 'sanity' }] })).toEqual({
      sanity: 0,
    })
  })

  test('empty object for a world with no player state', () => {
    expect(initializePlayerStats(db, EMPTY_WORLD_ID, STAT_DEFINITIONS)).toEqual({})
  })
})

describe('addInventoryItem', () => {
  test('stores the embedded shape, with all five keys', () => {
    const inventory = addInventoryItem(db, WORLD_ID, { id: 'torch', name: 'Torch' })

    // The DB column has always held the whole item; `player.yaml` is the file
    // that stores a bare reference. Writing the reference shape here would make
    // an existing database read back as a list of ids with no names.
    expect(inventory).toEqual([
      { item_id: 'torch', name: 'Torch', description: null, quantity: 1, properties: {} },
    ])
    expect(JSON.parse(rawInventory())).toEqual(inventory)
  })

  test('a second copy stacks onto the existing entry', () => {
    addInventoryItem(db, WORLD_ID, { id: 'potion', name: 'Potion', quantity: 2 })
    const inventory = addInventoryItem(db, WORLD_ID, { id: 'potion', name: 'Potion', quantity: 3 })

    // Everything stacks — there is no per-item `stackable` flag, so two swords
    // behave exactly like two potions.
    expect(inventory).toHaveLength(1)
    expect(inventory[0]!.quantity).toBe(5)
  })

  test('a different id gets its own entry', () => {
    addInventoryItem(db, WORLD_ID, { id: 'torch', name: 'Torch' })
    const inventory = addInventoryItem(db, WORLD_ID, { id: 'rope', name: 'Rope' })

    expect(inventory.map((i) => i.item_id)).toEqual(['torch', 'rope'])
  })

  test('carries description and properties through', () => {
    const inventory = addInventoryItem(db, WORLD_ID, {
      id: 'blade',
      name: 'Blade',
      description: 'chipped',
      properties: { durability: 40 },
    })

    expect(inventory[0]).toMatchObject({
      description: 'chipped',
      properties: { durability: 40 },
    })
  })

  test('empty list for a world with no player state', () => {
    expect(addInventoryItem(db, EMPTY_WORLD_ID, { id: 'torch', name: 'Torch' })).toEqual([])
  })
})

describe('removeInventoryItem', () => {
  function stock(id: string, quantity: number): void {
    addInventoryItem(db, WORLD_ID, { id, name: id, quantity })
  }

  test('decrements and reports what is left', () => {
    stock('potion', 5)

    expect(removeInventoryItem(db, WORLD_ID, 'potion', 2)).toEqual({
      success: true,
      remaining: 3,
    })
    expect(JSON.parse(rawInventory())[0].quantity).toBe(3)
  })

  test('defaults to removing one', () => {
    stock('potion', 2)
    expect(removeInventoryItem(db, WORLD_ID, 'potion')).toEqual({ success: true, remaining: 1 })
  })

  test('the entry disappears when the last one goes', () => {
    stock('torch', 1)

    expect(removeInventoryItem(db, WORLD_ID, 'torch')).toEqual({ success: true, remaining: 0 })
    // Not a zero-quantity entry — the row is dropped, or the inventory panel
    // would list items the player does not have.
    expect(JSON.parse(rawInventory())).toEqual([])
  })

  test('a shortfall fails outright and writes nothing', () => {
    stock('potion', 2)

    // Removing what there is would let a caller charging a cost think the whole
    // payment was made. `remaining` reports the quantity actually held so the
    // handler can say how short the player was.
    expect(removeInventoryItem(db, WORLD_ID, 'potion', 5)).toEqual({
      success: false,
      remaining: 2,
    })
    expect(JSON.parse(rawInventory())[0].quantity).toBe(2)
  })

  test('an item the player does not hold reports zero remaining', () => {
    stock('torch', 1)
    expect(removeInventoryItem(db, WORLD_ID, 'lantern')).toEqual({ success: false, remaining: 0 })
  })

  test('leaves the other entries untouched', () => {
    stock('torch', 1)
    stock('rope', 1)

    removeInventoryItem(db, WORLD_ID, 'torch')

    expect(
      (JSON.parse(rawInventory()) as InventoryEntry[]).map((i) => i.item_id),
    ).toEqual(['rope'])
  })

  test('a world with no player state is indistinguishable from a missing item', () => {
    expect(removeInventoryItem(db, EMPTY_WORLD_ID, 'torch')).toEqual({
      success: false,
      remaining: 0,
    })
  })
})

describe('chat mode', () => {
  test('entering stamps all three columns and returns the session id', () => {
    setSystemTime(new Date('2026-08-21T10:00:00.000Z'))
    const expected = Date.now() % (2 ** 31 - 1)

    const sessionId = enterChatMode(db, WORLD_ID, 42)

    expect(sessionId).toBe(expected)
    const state = getPlayerState(db, WORLD_ID)!
    expect(state.isChatMode).toBe(true)
    expect(state.chatModeStartMessageId).toBe(42)
    expect(state.chatSessionId).toBe(expected)
  })

  test('the session id fits in a signed 32-bit integer', () => {
    // The column is a plain INTEGER shared with Python, which folds the
    // millisecond clock into that range on purpose.
    const sessionId = enterChatMode(db, WORLD_ID, 1)!
    expect(sessionId).toBeGreaterThanOrEqual(0)
    expect(sessionId).toBeLessThan(2 ** 31 - 1)
  })

  test('a second entry is refused and leaves the running session alone', () => {
    setSystemTime(new Date('2026-08-21T10:00:00.000Z'))
    const first = enterChatMode(db, WORLD_ID, 42)

    setSystemTime(new Date('2026-08-21T10:05:00.000Z'))
    // Returning a fresh id here would mint one the already-written messages of
    // the running session do not carry.
    expect(enterChatMode(db, WORLD_ID, 99)).toBeNull()

    const state = getPlayerState(db, WORLD_ID)!
    expect(state.chatSessionId).toBe(first)
    expect(state.chatModeStartMessageId).toBe(42)
  })

  test('exiting reports the session that ended', () => {
    const sessionId = enterChatMode(db, WORLD_ID, 42)

    expect(exitChatMode(db, WORLD_ID)).toEqual({ startMessageId: 42, chatSessionId: sessionId })
  })

  test('exiting clears the session id but keeps the start message', () => {
    enterChatMode(db, WORLD_ID, 42)
    exitChatMode(db, WORLD_ID)

    const state = getPlayerState(db, WORLD_ID)!
    expect(state.isChatMode).toBe(false)
    // Cleared: a lingering value would tag the next gameplay message as part of
    // the finished session.
    expect(state.chatSessionId).toBeNull()
    // Kept: the frontend resumes the gameplay transcript from here.
    expect(state.chatModeStartMessageId).toBe(42)
  })

  test('exiting when not in chat mode is null, not an empty result', () => {
    expect(exitChatMode(db, WORLD_ID)).toBeNull()

    enterChatMode(db, WORLD_ID, 42)
    exitChatMode(db, WORLD_ID)
    expect(exitChatMode(db, WORLD_ID)).toBeNull()
  })

  test('re-entering after an exit mints a new id and moves the start message', () => {
    setSystemTime(new Date('2026-08-21T10:00:00.000Z'))
    const first = enterChatMode(db, WORLD_ID, 42)
    exitChatMode(db, WORLD_ID)

    setSystemTime(new Date('2026-08-21T10:05:00.000Z'))
    const second = enterChatMode(db, WORLD_ID, 77)

    expect(second).not.toBe(first)
    expect(getPlayerState(db, WORLD_ID)?.chatModeStartMessageId).toBe(77)
  })

  test('both halves are null for a world with no player state', () => {
    expect(enterChatMode(db, EMPTY_WORLD_ID, 1)).toBeNull()
    expect(exitChatMode(db, EMPTY_WORLD_ID)).toBeNull()
  })
})
