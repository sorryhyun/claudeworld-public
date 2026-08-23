/**
 * The initial-state snapshot (`worlds/<name>/_initial.json`).
 *
 * Small surface, but two properties matter enough to pin down: an absent
 * snapshot must stay distinguishable from an empty one (the reset route raises
 * on the first, resets happily on the second), and `initial_game_time` must be
 * omitted rather than written null when the clock is falsy.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorldResetService } from '@/services/world-reset-service'
import type { InitialStateSnapshot } from '@/services/world-reset-service'

const WORLD = 'testworld'

let worldsDir: string

function initialFile(): string {
  return join(worldsDir, WORLD, '_initial.json')
}

beforeEach(() => {
  worldsDir = mkdtempSync(join(tmpdir(), 'cw-reset-'))
  mkdirSync(join(worldsDir, WORLD), { recursive: true })
})

afterEach(() => {
  rmSync(worldsDir, { recursive: true, force: true })
})

// ============================================================================
// createInitialStateSnapshot
// ============================================================================

describe('createInitialStateSnapshot', () => {
  const base = {
    startingLocation: 'old_mill',
    initialStats: { hp: 20, sanity: 5 },
    initialInventory: [{ item_id: 'torch', quantity: 1 }],
  }

  test('captures location, stats, inventory and a timestamp', () => {
    const snapshot = WorldResetService.createInitialStateSnapshot({
      ...base,
      initialGameTime: { hour: 8, minute: 0, day: 1 },
    })

    expect(snapshot.starting_location).toBe('old_mill')
    expect(snapshot.initial_stats).toEqual({ hp: 20, sanity: 5 })
    expect(snapshot.initial_inventory).toEqual([{ item_id: 'torch', quantity: 1 }])
    expect(snapshot.initial_game_time).toEqual({ hour: 8, minute: 0, day: 1 })
  })

  test('captured_at is UTC isoformat with microsecond padding and a Z', () => {
    // Python writes `utcnow().isoformat() + "Z"`; JS has millisecond resolution,
    // so the last three digits are padding. The suffix must not be doubled.
    const capturedAt = WorldResetService.createInitialStateSnapshot(base).captured_at
    expect(capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    expect(capturedAt.endsWith('000Z')).toBe(true)
  })

  test('a falsy game time omits the key entirely', () => {
    // Python's `if initial_game_time:` is false for None *and* for `{}`. A
    // present-but-null key would wind a reset world's clock to zero.
    for (const gameTime of [null, undefined]) {
      const snapshot = WorldResetService.createInitialStateSnapshot({
        ...base,
        initialGameTime: gameTime,
      })
      expect('initial_game_time' in snapshot).toBe(false)
    }

    const fromEmpty = WorldResetService.createInitialStateSnapshot({
      ...base,
      // A clock read from a world that never had one: empty, not absent.
      initialGameTime: {} as InitialStateSnapshot['initial_game_time'],
    })
    expect('initial_game_time' in fromEmpty).toBe(false)
  })

  test('an empty snapshot is still a snapshot', () => {
    const snapshot = WorldResetService.createInitialStateSnapshot({
      startingLocation: 'start',
      initialStats: {},
      initialInventory: [],
    })

    expect(snapshot.initial_stats).toEqual({})
    expect(snapshot.initial_inventory).toEqual([])
  })
})

// ============================================================================
// Persistence
// ============================================================================

describe('save / load / has', () => {
  test('round-trips through _initial.json', () => {
    const service = new WorldResetService(worldsDir)
    const snapshot = WorldResetService.createInitialStateSnapshot({
      startingLocation: '오래된 방앗간',
      initialStats: { hp: 20 },
      initialInventory: [{ item_id: 'torch', quantity: 1 }],
      initialGameTime: { hour: 8, minute: 0, day: 1 },
    })

    expect(service.saveInitialState(WORLD, snapshot)).toBe(true)
    expect(service.hasInitialState(WORLD)).toBe(true)
    expect(service.loadInitialState(WORLD)).toEqual(snapshot)
  })

  test('the file is indented and leaves non-ASCII unescaped', () => {
    // `json.dump(..., ensure_ascii=False, indent=2)` — a Korean location name
    // stays readable in the file rather than becoming \uXXXX escapes.
    new WorldResetService(worldsDir).saveInitialState(WORLD, {
      starting_location: '오래된 방앗간',
      initial_stats: {},
      initial_inventory: [],
      captured_at: '2026-08-21T00:00:00.000000Z',
    })

    const raw = readFileSync(initialFile(), 'utf-8')
    expect(raw).toContain('"starting_location": "오래된 방앗간"')
    expect(raw.split('\n')[1]?.startsWith('  "')).toBe(true)
  })

  test('getInitialStatePath names the file whether or not it exists', () => {
    const service = new WorldResetService(worldsDir)
    expect(service.getInitialStatePath(WORLD)).toBe(initialFile())
    expect(existsSync(service.getInitialStatePath(WORLD))).toBe(false)
  })

  test('an absent snapshot is distinguishable from an empty one', () => {
    const service = new WorldResetService(worldsDir)

    expect(service.hasInitialState(WORLD)).toBe(false)
    expect(service.loadInitialState(WORLD)).toBeNull()

    service.saveInitialState(WORLD, {
      starting_location: 'start',
      initial_stats: {},
      initial_inventory: [],
      captured_at: '2026-08-21T00:00:00.000000Z',
    })

    expect(service.hasInitialState(WORLD)).toBe(true)
    expect(service.loadInitialState(WORLD)?.initial_inventory).toEqual([])
  })

  test('a corrupt file reads as no snapshot rather than throwing', () => {
    writeFileSync(initialFile(), '{ not json', 'utf-8')

    const service = new WorldResetService(worldsDir)
    // `has` still says yes — the file is there. Only the load fails, which is
    // exactly Python's split between existence and readability.
    expect(service.hasInitialState(WORLD)).toBe(true)
    expect(service.loadInitialState(WORLD)).toBeNull()
  })

  test('valid JSON of the wrong shape is treated as corrupt', () => {
    writeFileSync(initialFile(), '[1, 2, 3]', 'utf-8')

    expect(new WorldResetService(worldsDir).loadInitialState(WORLD)).toBeNull()
  })

  test('saving into a world that does not exist reports failure', () => {
    // No directory to write into. Python's `except IOError` returns False; the
    // caller logs and carries on rather than failing the onboarding turn.
    expect(
      new WorldResetService(worldsDir).saveInitialState('no-such-world', {
        starting_location: 'start',
        initial_stats: {},
        initial_inventory: [],
        captured_at: '2026-08-21T00:00:00.000000Z',
      }),
    ).toBe(false)
  })
})
