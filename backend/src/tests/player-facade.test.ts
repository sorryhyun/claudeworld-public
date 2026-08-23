/**
 * The player facade — `services/player-facade.ts`.
 *
 * The facade's whole job is that two stores move together, so nearly every test
 * below asserts on *both* sides: what `worlds/<world>/player.json` now holds,
 * and what the `player_states` row now holds. Asserting one alone would pass
 * for a facade that had quietly stopped writing the other, which is the exact
 * regression the class exists to prevent.
 *
 * Two more properties get their own suites:
 *
 * 1. **The filesystem is authoritative and the row is a mirror.** The
 *    write-through overwrites the columns with what is on disk rather than
 *    replaying the delta, so a row that had drifted is repaired — even by an
 *    operation with nothing to store there, like advancing the clock.
 * 2. **A database failure is not a mutation failure.** Python's `_sync_to_db`
 *    swallows everything; a closed database, or a world with no row yet, still
 *    writes `player.json` and still reports success.
 *
 * Worlds are throwaway copies of the checked-in fixture at
 * `src/tests/fixtures/worlds/asdf` — the same rule `world-services.test.ts`
 * follows, since these suites write.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addInventoryItem } from '@/crud/player-state'
import { openDb, type Db } from '@/db'
import { openAndInitDb } from '@/db/migrate'
import { playerStates, worlds } from '@/db/schema'
import type { InventoryEntry } from '@/domain/player-rules'
import { setLogSink } from '@/infrastructure/logging/logger'
import { ItemService } from '@/services/item-service'
import { PlayerFacade } from '@/services/player-facade'
import { PlayerService } from '@/services/player-service'

const FIXTURE_WORLDS = join(import.meta.dir, 'fixtures', 'worlds')
const WORLD = 'asdf'
const WORLD_ID = 1
/** A world row with no `player_states` row — the "sync must not insert" case. */
const EMPTY_WORLD_ID = 2

let worldsDir: string
let dbDir: string
let db: Db
let dbClosed = false

beforeEach(() => {
  worldsDir = mkdtempSync(join(tmpdir(), 'cw-facade-worlds-'))
  cpSync(join(FIXTURE_WORLDS, WORLD), join(worldsDir, WORLD), { recursive: true })

  dbDir = mkdtempSync(join(tmpdir(), 'cw-facade-db-'))
  const created = openAndInitDb({ path: join(dbDir, 'test.db') })
  created.close()

  db = openDb({ path: join(dbDir, 'test.db') })
  dbClosed = false
  seed()
})

afterEach(() => {
  if (!dbClosed) db.$client.close()
  rmSync(worldsDir, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

function seed(): void {
  db.insert(worlds)
    .values([
      { id: WORLD_ID, name: WORLD, ownerId: 'admin', phase: 'active', language: 'ko' },
      { id: EMPTY_WORLD_ID, name: 'stateless', ownerId: 'admin', phase: 'active', language: 'en' },
    ])
    .run()

  db.insert(playerStates)
    .values({
      worldId: WORLD_ID,
      turnCount: 0,
      stats: '{}',
      inventory: '[]',
      effects: '[]',
      actionHistory: '[]',
    })
    .run()
}

// ============================================================================
// Fixture helpers
// ============================================================================

/**
 * Build the facade under test.
 *
 * Constructed per test rather than per suite so each one gets a private mtime
 * cache: the setup helpers below write `player.json` directly, and a cache
 * carried over from a previous test could still be holding the fixture's parse.
 */
function makeFacade(worldId: number | null = WORLD_ID): PlayerFacade {
  return new PlayerFacade(new PlayerService(worldsDir), db, worldId)
}

function playerFile(world = WORLD): string {
  return join(worldsDir, world, 'player.json')
}

/** Merge fields into the world's `player.json`, before the facade reads it. */
function writePlayerYaml(fields: Record<string, unknown>): void {
  const current = JSON.parse(readFileSync(playerFile(), 'utf-8')) as Record<string, unknown>
  writeFileSync(playerFile(), JSON.stringify({ ...current, ...fields }), 'utf-8')
}

function writeStatsYaml(stats: Record<string, unknown>[]): void {
  writeFileSync(
    join(worldsDir, WORLD, 'stats.json'),
    JSON.stringify({ stats, derived: [] }),
    'utf-8',
  )
}

function fileState(): Record<string, unknown> {
  return JSON.parse(readFileSync(playerFile(), 'utf-8')) as Record<string, unknown>
}

function fileStats(): Record<string, number> {
  return fileState().stats as Record<string, number>
}

function fileInventory(): InventoryEntry[] {
  return fileState().inventory as InventoryEntry[]
}

/** The raw column text, which is what the Python backend reads back. */
function rawColumns(worldId = WORLD_ID): { stats: string | null; inventory: string | null } {
  const row = db
    .select({ stats: playerStates.stats, inventory: playerStates.inventory })
    .from(playerStates)
    .where(eq(playerStates.worldId, worldId))
    .get()
  if (!row) throw new Error(`no player_states row for world ${worldId}`)
  return row
}

function rowStats(): Record<string, number> {
  return JSON.parse(rawColumns().stats ?? 'null') as Record<string, number>
}

function rowInventory(): InventoryEntry[] {
  return JSON.parse(rawColumns().inventory ?? 'null') as InventoryEntry[]
}

// ============================================================================
// Stats
// ============================================================================

describe('updateStats', () => {
  test('applies the deltas to the save file and mirrors them onto the row', () => {
    writePlayerYaml({ stats: { health: 50 } })

    const result = makeFacade().updateStats(WORLD, { health: -10, gold: 5 })

    // A stat absent from the file starts at 0, so `gold` is introduced by the
    // change itself — the same rule character progression relies on.
    expect(result).toEqual({ health: 40, gold: 5 })
    expect(fileStats()).toEqual({ health: 40, gold: 5 })
    expect(rowStats()).toEqual({ health: 40, gold: 5 })
  })

  test('clamps to stats.json on both sides', () => {
    writeStatsYaml([{ name: 'health', min: 0, max: 100, default: 100 }])
    writePlayerYaml({ stats: { health: 90 } })

    const facade = makeFacade()
    expect(facade.updateStats(WORLD, { health: 50 })).toEqual({ health: 100 })
    expect(facade.updateStats(WORLD, { health: -999 })).toEqual({ health: 0 })

    expect(fileStats()).toEqual({ health: 0 })
    expect(rowStats()).toEqual({ health: 0 })
  })

  test('a stat with no definition is unbounded', () => {
    writeStatsYaml([{ name: 'health', min: 0, max: 100 }])

    expect(makeFacade().updateStats(WORLD, { gold: 9999 })).toEqual({ gold: 9999 })
  })

  test('a world with no player.json reports null instead of raising', () => {
    expect(makeFacade().updateStats('no-such-world', { health: -10 })).toBeNull()
    // Nothing was mirrored either: the row still holds the seeded value.
    expect(rawColumns().stats).toBe('{}')
  })

  test('a nameless stat definition throws before anything is written', () => {
    // `buildStatMap` raises rather than skipping the entry, because a stat that
    // cannot be addressed by name can never be clamped. Python's `stat["name"]`
    // raises KeyError in the same place, and the tool handler turns it into a
    // tool error — but only *after* the facade has left both stores untouched.
    writeStatsYaml([{ min: 0, max: 100 }])
    writePlayerYaml({ stats: { health: 50 } })

    expect(() => makeFacade().updateStats(WORLD, { health: -10 })).toThrow()

    expect(fileStats()).toEqual({ health: 50 })
    expect(rawColumns().stats).toBe('{}')
  })
})

// ============================================================================
// Inventory
// ============================================================================

describe('addItem', () => {
  test('writes a reference to the file and the full item to the row', () => {
    const added = makeFacade().addItem(WORLD, {
      itemId: 'sword',
      name: '낡은 검',
      description: 'A chipped blade.',
      properties: { damage: 3 },
    })

    expect(added).toBe(true)

    // The save file must not shadow the template with a stale copy of its name
    // and description, so only the reference fields land there.
    expect(fileInventory()).toEqual([
      { item_id: 'sword', quantity: 1, instance_properties: { damage: 3 } },
    ])

    // The column has always held the whole item; a reader of an existing
    // database would find nothing but an id otherwise.
    expect(rowInventory()).toEqual([
      {
        item_id: 'sword',
        name: '낡은 검',
        description: 'A chipped blade.',
        quantity: 1,
        properties: { damage: 3 },
      },
    ])
  })

  test('saving the reference materialises the item template', () => {
    // `savePlayerState` -> `ItemService.toReferenceFormat` is what gives an item
    // the Action Manager invented mid-turn a durable definition; without it the
    // reference just written would dangle.
    makeFacade().addItem(WORLD, { itemId: 'sword', name: '낡은 검', description: 'A chipped blade.' })

    const template = new ItemService(worldsDir).loadItemTemplate(WORLD, 'sword')
    expect(template?.name).toBe('낡은 검')
    expect(template?.description).toBe('A chipped blade.')
  })

  test('a second add of the same id stacks instead of duplicating', () => {
    const facade = makeFacade()
    facade.addItem(WORLD, { itemId: 'potion', name: 'Potion', quantity: 2 })
    facade.addItem(WORLD, { itemId: 'potion', name: 'Potion', quantity: 3 })

    expect(fileInventory()).toEqual([{ item_id: 'potion', quantity: 5 }])
    expect(rowInventory()).toHaveLength(1)
    expect(rowInventory()[0]?.quantity).toBe(5)
  })

  test('empty properties are omitted from the file rather than written as {}', () => {
    makeFacade().addItem(WORLD, { itemId: 'rope', name: 'Rope', properties: {} })

    expect(fileInventory()).toEqual([{ item_id: 'rope', quantity: 1 }])
  })

  test('a world with no player.json reports false', () => {
    expect(makeFacade().addItem('no-such-world', { itemId: 'sword', name: 'Sword' })).toBe(false)
    expect(rawColumns().inventory).toBe('[]')
  })
})

describe('removeItem', () => {
  beforeEach(() => {
    const facade = makeFacade()
    facade.addItem(WORLD, { itemId: 'potion', name: 'Potion', quantity: 3 })
  })

  test('decrements the stack on both sides', () => {
    expect(makeFacade().removeItem(WORLD, 'potion', 2)).toBe(true)

    expect(fileInventory()).toEqual([{ item_id: 'potion', quantity: 1 }])
    expect(rowInventory()[0]?.quantity).toBe(1)
  })

  test('drops the entry when the stack empties', () => {
    expect(makeFacade().removeItem(WORLD, 'potion', 3)).toBe(true)

    expect(fileInventory()).toEqual([])
    expect(rawColumns().inventory).toBe('[]')
  })

  test('defaults to removing one', () => {
    expect(makeFacade().removeItem(WORLD, 'potion')).toBe(true)
    expect(fileInventory()).toEqual([{ item_id: 'potion', quantity: 2 }])
  })

  test('a shortfall removes nothing at all', () => {
    // A partial removal would leave the caller believing the whole cost was
    // paid, so the removal is refused outright and neither store moves. The row
    // is drifted first so "unchanged" means the sync never ran, rather than the
    // sync having written back the same values.
    addInventoryItem(db, WORLD_ID, { id: 'torch', name: 'Torch', quantity: 1 })
    const before = rawColumns().inventory

    expect(makeFacade().removeItem(WORLD, 'potion', 4)).toBe(false)

    expect(fileInventory()).toEqual([{ item_id: 'potion', quantity: 3 }])
    expect(rawColumns().inventory).toBe(before)
  })

  test('an item the player does not hold reports false', () => {
    expect(makeFacade().removeItem(WORLD, 'sword')).toBe(false)
    expect(fileInventory()).toEqual([{ item_id: 'potion', quantity: 3 }])
  })

  test('a world with no player.json reports false', () => {
    expect(makeFacade().removeItem('no-such-world', 'potion')).toBe(false)
  })
})

// ============================================================================
// Clock
// ============================================================================

describe('advanceTime', () => {
  test('rolls the day over at 24:00', () => {
    writePlayerYaml({ game_time: { hour: 23, minute: 30, day: 1 } })

    const result = makeFacade().advanceTime(WORLD, 45)

    expect(result?.oldTime).toEqual({ hour: 23, minute: 30, day: 1 })
    expect(result?.newTime).toEqual({ hour: 0, minute: 15, day: 2 })
    expect(fileState().game_time).toEqual({ hour: 0, minute: 15, day: 2 })
  })

  test('several days at once', () => {
    writePlayerYaml({ game_time: { hour: 8, minute: 0, day: 1 } })

    expect(makeFacade().advanceTime(WORLD, 3 * 1440 + 90)?.newTime).toEqual({
      hour: 9,
      minute: 30,
      day: 4,
    })
  })

  test('a non-positive advance is refused without touching the file', () => {
    const before = readFileSync(playerFile(), 'utf-8')
    const facade = makeFacade()

    expect(facade.advanceTime(WORLD, 0)).toBeNull()
    expect(facade.advanceTime(WORLD, -30)).toBeNull()
    expect(readFileSync(playerFile(), 'utf-8')).toBe(before)
  })

  test('a world with no player.json reports null', () => {
    expect(makeFacade().advanceTime('no-such-world', 30)).toBeNull()
  })

  test('the write-through repairs a drifted row even though the clock has no column', () => {
    // `player_states` stores stats, inventory, effects and action history —
    // there is nowhere to put `game_time`. Python syncs anyway, which means
    // advancing the clock rewrites the *other* two columns from disk. Here the
    // row was mutated behind the facade's back through `crud/player-state.ts`;
    // after the clock moves, the row says what the file says.
    makeFacade().addItem(WORLD, { itemId: 'potion', name: 'Potion', quantity: 2 })
    addInventoryItem(db, WORLD_ID, { id: 'torch', name: 'Torch', quantity: 1 })
    expect(rowInventory()).toHaveLength(2)

    makeFacade().advanceTime(WORLD, 30)

    expect(rowInventory().map((entry) => entry.item_id)).toEqual(['potion'])
  })
})

// ============================================================================
// Write-through failure paths
// ============================================================================

describe('the database side is allowed to fail', () => {
  test('a world with no player_states row is written to disk and not inserted', () => {
    // Onboarding runs before character creation has made the row. Python's
    // `if db_state:` skips the sync rather than creating one, and an insert
    // here would race the creation path.
    const facade = new PlayerFacade(new PlayerService(worldsDir), db, EMPTY_WORLD_ID)

    expect(facade.updateStats(WORLD, { health: 10 })).toEqual({ health: 10 })
    expect(fileStats()).toEqual({ health: 10 })

    const rows = db.select().from(playerStates).where(eq(playerStates.worldId, EMPTY_WORLD_ID)).all()
    expect(rows).toHaveLength(0)
  })

  test('a closed database degrades the mirror, not the mutation', () => {
    db.$client.close()
    dbClosed = true

    const facade = makeFacade()

    // Every path issues the sync, so every path has to survive it failing.
    expect(facade.updateStats(WORLD, { health: -10 })).toEqual({ health: -10 })
    expect(facade.addItem(WORLD, { itemId: 'sword', name: 'Sword' })).toBe(true)
    expect(facade.removeItem(WORLD, 'sword')).toBe(true)
    expect(facade.advanceTime(WORLD, 30)?.newTime.hour).toBe(8)

    expect(fileStats()).toEqual({ health: -10 })
    expect(fileInventory()).toEqual([])
    expect(fileState().game_time).toEqual({ hour: 8, minute: 30, day: 1 })
  })

  test('a failed sync is logged rather than swallowed silently', () => {
    // Swallowing is deliberate; swallowing *quietly* would make a row that has
    // stopped tracking disk indistinguishable from one that never drifted.
    db.$client.close()
    dbClosed = true

    const lines: string[] = []
    const restore = setLogSink((line) => lines.push(line))
    try {
      makeFacade().updateStats(WORLD, { health: -10 })
    } finally {
      restore()
    }

    expect(lines.some((line) => line.includes('Failed to sync player state to DB'))).toBe(true)
  })

  test('filesystem-only mode needs no database at all', () => {
    // Python's `PlayerFacade(world_name)` — what a sub-agent gets when it runs
    // before the world has a room to sync against.
    const facade = new PlayerFacade(new PlayerService(worldsDir))

    expect(facade.updateStats(WORLD, { health: 25 })).toEqual({ health: 25 })
    expect(fileStats()).toEqual({ health: 25 })
    // The row is untouched, not merely unchanged-looking.
    expect(rawColumns().stats).toBe('{}')
  })

  test('a null world id disables the mirror the way Python\'s truthiness check does', () => {
    const facade = makeFacade(null)

    expect(facade.addItem(WORLD, { itemId: 'sword', name: 'Sword' })).toBe(true)
    expect(rawColumns().inventory).toBe('[]')
  })
})

// ============================================================================
// Reads
// ============================================================================

describe('reads', () => {
  test('getInventory resolves references against the item templates', () => {
    makeFacade().addItem(WORLD, {
      itemId: 'sword',
      name: '낡은 검',
      description: 'A chipped blade.',
      properties: { damage: 3 },
    })

    const resolved = makeFacade().getInventory(WORLD)

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.name).toBe('낡은 검')
    expect(resolved[0]?.description).toBe('A chipped blade.')
    expect(resolved[0]?.quantity).toBe(1)
  })

  test('getInventory is empty for a world with no save file', () => {
    expect(makeFacade().getInventory('no-such-world')).toEqual([])
  })

  test('loadPlayerState passes the save file through', () => {
    writePlayerYaml({ turn_count: 7, current_location: 'village' })

    const state = makeFacade().loadPlayerState(WORLD)

    expect(state?.turnCount).toBe(7)
    expect(state?.currentLocation).toBe('village')
    expect(makeFacade().loadPlayerState('no-such-world')).toBeNull()
  })
})
