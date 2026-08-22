/**
 * Item templates (`worlds/<name>/items/*.json`) and the player-state save path
 * that materialises them.
 *
 * Every test builds its own throwaway worlds root. Nothing here may touch the
 * repository's `worlds/`, which is checked-in fixture data — and unlike the
 * read-only suites, everything in this file writes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ItemService } from '../services/item-service'
import { PlayerService } from '../services/player-service'
import type { PlayerState } from '../services/player-service'

const WORLD = 'testworld'

let worldsDir: string

/** The world directory a service will resolve `WORLD` to. */
function worldPath(): string {
  return join(worldsDir, WORLD)
}

function itemsPath(): string {
  return join(worldPath(), 'items')
}

/** Read one template file verbatim, to assert on formatting rather than values. */
function readTemplateFile(fileName: string): string {
  return readFileSync(join(itemsPath(), fileName), 'utf-8')
}

/** Drop a file into `items/` by hand, bypassing the writer under test. */
function writeTemplateFile(fileName: string, content: string): void {
  mkdirSync(itemsPath(), { recursive: true })
  writeFileSync(join(itemsPath(), fileName), content, 'utf-8')
}

/** Force a distinct mtime — two writes can otherwise land in the same ms. */
function touchFuture(filePath: string): void {
  const future = new Date(Date.now() + 5_000)
  utimesSync(filePath, future, future)
}

beforeEach(() => {
  worldsDir = mkdtempSync(join(tmpdir(), 'cw-items-'))
  mkdirSync(worldPath(), { recursive: true })
})

afterEach(() => {
  rmSync(worldsDir, { recursive: true, force: true })
})

// ============================================================================
// Writing templates
// ============================================================================

describe('saveItemTemplate', () => {
  test('round-trips a template through items/<id>.json', () => {
    const service = new ItemService(worldsDir)

    expect(
      service.saveItemTemplate(WORLD, {
        itemId: 'brass_lantern',
        name: '놋쇠 등불',
        description: 'A dented lantern.',
        properties: { light: 3 },
      }),
    ).toBe(true)

    expect(service.loadItemTemplate(WORLD, 'brass_lantern')).toEqual({
      id: 'brass_lantern',
      name: '놋쇠 등불',
      description: 'A dented lantern.',
      default_properties: { light: 3 },
    })
  })

  test('a multi-line description round-trips, and keys reach disk sorted', () => {
    // Assert on the bytes, not on the round-tripped value: `dumpJson` sorts at
    // every depth, so the build order in `saveItemTemplate` never reaches disk.
    new ItemService(worldsDir).saveItemTemplate(WORLD, {
      itemId: 'field_journal',
      name: 'Field Journal',
      description: 'Page one is water damaged.\nPage two lists three names.',
    })

    const raw = readTemplateFile('field_journal.json')
    expect(raw).toContain('"description": "Page one is water damaged.\\nPage two lists three names."')

    expect(raw.split('\n')[1]).toBe('  "default_properties": {},')

    expect(new ItemService(worldsDir).loadItemTemplate(WORLD, 'field_journal')?.description).toBe(
      'Page one is water damaged.\nPage two lists three names.',
    )
  })

  test('the filename sanitiser drops spaces, unlike the world-name one', () => {
    // `world-service.ts` keeps the space (`마법의 숲/`); this one does not, so an
    // id and its filename genuinely diverge and only the in-file `id` can be
    // trusted as a key.
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, { itemId: 'Old Lantern', name: 'Old Lantern' })

    expect(readdirSync(itemsPath())).toEqual(['OldLantern.json'])
    expect(service.loadItemTemplate(WORLD, 'Old Lantern')?.name).toBe('Old Lantern')
    expect(service.loadItemTemplate(WORLD, 'OldLantern')).toBeNull()
  })

  test('non-ASCII ids survive the sanitiser; separators do not', () => {
    // Dots are in the keep-set and stay, but with every `/` stripped they are
    // inert: the result is one flat filename inside `items/`, not a traversal.
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, { itemId: '../../etc/열쇠', name: 'Key' })

    expect(readdirSync(itemsPath())).toEqual(['....etc열쇠.json'])
  })

  test('falsy optional fields are omitted, default_properties never is', () => {
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, {
      itemId: 'plain',
      name: 'Plain Thing',
      description: null,
      category: '',
      tags: [],
      stacking: {},
      properties: null,
    })

    expect(service.loadItemTemplate(WORLD, 'plain')).toEqual({
      id: 'plain',
      name: 'Plain Thing',
      description: '',
      default_properties: {},
    })
  })

  test('optional classification and component blocks are kept when present', () => {
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, {
      itemId: 'sword',
      name: 'Sword',
      category: 'tool',
      tags: ['metal', 'sharp'],
      rarity: 'rare',
      icon: '🗡️',
      stacking: { max: 1 },
      equippable: { slot: 'main_hand', passive_effects: { attack: 3 } },
      usable: { affordances: [] },
      properties: { damage: 5 },
    })

    const template = service.loadItemTemplate(WORLD, 'sword')
    expect(template?.category).toBe('tool')
    expect(template?.tags).toEqual(['metal', 'sharp'])
    expect(template?.rarity).toBe('rare')
    expect(template?.equippable).toEqual({ slot: 'main_hand', passive_effects: { attack: 3 } })
    expect(template?.default_properties).toEqual({ damage: 5 })

    // A list keeps its authored order; only object keys are sorted.
    expect(readTemplateFile('sword.json')).toContain('"tags": [\n    "metal",\n    "sharp"\n  ]')
  })

  test('an existing template is not overwritten unless asked', () => {
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, { itemId: 'lantern', name: 'First' })

    expect(service.saveItemTemplate(WORLD, { itemId: 'lantern', name: 'Second' })).toBe(false)
    expect(service.loadItemTemplate(WORLD, 'lantern')?.name).toBe('First')

    expect(service.saveItemTemplate(WORLD, { itemId: 'lantern', name: 'Second', overwrite: true })).toBe(
      true,
    )
    expect(service.loadItemTemplate(WORLD, 'lantern')?.name).toBe('Second')
  })

  test('a world with no directory yet gets one rather than failing the save', () => {
    // Python's `mkdir(exist_ok=True)` would raise here; the port creates parents.
    rmSync(worldPath(), { recursive: true, force: true })

    expect(new ItemService(worldsDir).saveItemTemplate(WORLD, { itemId: 'x', name: 'X' })).toBe(true)
  })
})

// ============================================================================
// Reading templates
// ============================================================================

describe('loadAllItemTemplates', () => {
  test('keys by the id inside the file, not by the filename', () => {
    writeTemplateFile('whatever.json', '{"id": "真の名前", "name": "True Name", "default_properties": {}}')

    const templates = new ItemService(worldsDir).loadAllItemTemplates(WORLD)
    expect(Object.keys(templates)).toEqual(['真の名前'])
    expect(templates['真の名前']?.name).toBe('True Name')
  })

  test('a malformed file is skipped, not fatal', () => {
    writeTemplateFile('good.json', '{"id": "good", "name": "Good"}')
    writeTemplateFile('broken.json', '{"id": [unclosed')
    writeTemplateFile('no_id.json', '{"name": "Nameless"}')
    writeTemplateFile('a_list.json', '[{"id": "nope"}]')

    expect(Object.keys(new ItemService(worldsDir).loadAllItemTemplates(WORLD))).toEqual(['good'])
  })

  test('only *.json is read', () => {
    writeTemplateFile('good.json', '{"id": "good", "name": "Good"}')
    writeTemplateFile('other.yml', '{"id": "other", "name": "Other"}')
    writeTemplateFile('notes.md', '{"id": "notes"}')

    expect(Object.keys(new ItemService(worldsDir).loadAllItemTemplates(WORLD))).toEqual(['good'])
  })

  test('a world with no items/ directory has no templates', () => {
    const service = new ItemService(worldsDir)
    expect(service.loadAllItemTemplates(WORLD)).toEqual({})
    expect(service.getAllItemsInWorld(WORLD)).toEqual([])
    expect(service.loadItemTemplate(WORLD, 'anything')).toBeNull()
    expect(service.loadAllItemTemplates('no-such-world')).toEqual({})
  })

  test('an id colliding with an Object prototype key is not resolved to a function', () => {
    // Item ids come from model output, so `templates["toString"]` reaching the
    // prototype is a real hazard, not a hypothetical one.
    writeTemplateFile('constructor.json', '{"id": "constructor", "name": "Ctor"}')

    const service = new ItemService(worldsDir)
    expect(service.loadItemTemplate(WORLD, 'constructor')?.name).toBe('Ctor')
    expect(service.loadItemTemplate(WORLD, 'toString')).toBeNull()
  })

  test('getAllItemsInWorld returns the definitions themselves', () => {
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, { itemId: 'a', name: 'A' })
    service.saveItemTemplate(WORLD, { itemId: 'b', name: 'B' })

    expect(service.getAllItemsInWorld(WORLD).map((item) => item.id).sort()).toEqual(['a', 'b'])
  })
})

describe('template cache invalidation', () => {
  test('a template added by another process is picked up', () => {
    const service = new ItemService(worldsDir)
    expect(service.loadAllItemTemplates(WORLD)).toEqual({})

    writeTemplateFile('late.json', '{"id": "late", "name": "Late"}')
    touchFuture(itemsPath())

    expect(Object.keys(service.loadAllItemTemplates(WORLD))).toEqual(['late'])
  })

  test('an edit in place is picked up even though the directory is untouched', () => {
    const service = new ItemService(worldsDir)
    writeTemplateFile('lamp.json', '{"id": "lamp", "name": "Lamp"}')
    expect(service.loadItemTemplate(WORLD, 'lamp')?.name).toBe('Lamp')

    writeTemplateFile('lamp.json', '{"id": "lamp", "name": "Rewritten Lamp"}')
    touchFuture(join(itemsPath(), 'lamp.json'))

    expect(service.loadItemTemplate(WORLD, 'lamp')?.name).toBe('Rewritten Lamp')
  })

  test('this service writing a template invalidates its own cache', () => {
    const service = new ItemService(worldsDir)
    service.loadAllItemTemplates(WORLD)

    service.saveItemTemplate(WORLD, { itemId: 'fresh', name: 'Fresh' })

    expect(service.loadItemTemplate(WORLD, 'fresh')?.name).toBe('Fresh')
  })
})

// ============================================================================
// resolveInventory
// ============================================================================

describe('resolveInventory', () => {
  function seedSword(): ItemService {
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, {
      itemId: 'sword',
      name: 'Iron Sword',
      description: 'Nicked along one edge.',
      properties: { damage: 5, weight: 3 },
    })
    return service
  }

  test('template defaults are merged under the instance properties', () => {
    const resolved = seedSword().resolveInventory(WORLD, [
      { item_id: 'sword', quantity: 2, instance_properties: { damage: 7 } },
    ])

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.item_id).toBe('sword')
    expect(resolved[0]?.name).toBe('Iron Sword')
    expect(resolved[0]?.description).toBe('Nicked along one edge.')
    expect(resolved[0]?.quantity).toBe(2)
    // `weight` back-filled from the template, `damage` overridden per instance.
    expect(resolved[0]?.properties).toEqual({
      damage: { value: 7, higher_is_better: true },
      weight: { value: 3, higher_is_better: false },
    })
  })

  test('normalizeProps: false leaves the merged properties bare', () => {
    const resolved = seedSword().resolveInventory(
      WORLD,
      [{ item_id: 'sword', quantity: 1, instance_properties: { damage: 7 } }],
      false,
    )

    expect(resolved[0]?.properties).toEqual({ damage: 7, weight: 3 })
  })

  test('an entry with no template falls back to the legacy embedded form', () => {
    const resolved = new ItemService(worldsDir).resolveInventory(WORLD, [
      { item_id: 'ghost', name: 'Ghost Item', description: 'Only in the save file.', quantity: 1 },
    ])

    expect(resolved[0]?.name).toBe('Ghost Item')
    expect(resolved[0]?.description).toBe('Only in the save file.')
    expect(resolved[0]?.properties).toEqual({})
  })

  test('empty properties are left alone rather than normalized to {}', () => {
    // Python's `if item_dict.get("properties")` is false for `{}`.
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, { itemId: 'rock', name: 'Rock' })

    expect(service.resolveInventory(WORLD, [{ item_id: 'rock', quantity: 1 }])[0]?.properties).toEqual({})
  })
})

// ============================================================================
// toReferenceFormat
// ============================================================================

describe('toReferenceFormat', () => {
  test('materialises a template for an item that has none', () => {
    // The side effect is the point: this is how an item invented mid-turn gets
    // a durable definition.
    const service = new ItemService(worldsDir)

    const refs = service.toReferenceFormat(WORLD, [
      {
        item_id: 'conjured_key',
        name: 'Conjured Key',
        description: 'It hums.',
        quantity: 1,
        properties: { charges: 3 },
      },
    ])

    expect(refs).toEqual([{ item_id: 'conjured_key', quantity: 1, instance_properties: { charges: 3 } }])
    expect(service.loadItemTemplate(WORLD, 'conjured_key')).toEqual({
      id: 'conjured_key',
      name: 'Conjured Key',
      description: 'It hums.',
      default_properties: { charges: 3 },
    })
  })

  test('an existing template is left exactly as its author wrote it', () => {
    const service = new ItemService(worldsDir)
    service.saveItemTemplate(WORLD, { itemId: 'lantern', name: 'Authored Lantern' })

    service.toReferenceFormat(WORLD, [{ item_id: 'lantern', name: 'Model Guess', quantity: 1 }])

    expect(service.loadItemTemplate(WORLD, 'lantern')?.name).toBe('Authored Lantern')
  })

  test('name and description are stripped from the reference itself', () => {
    // Duplicating them into player.json would shadow an edited template.
    const refs = new ItemService(worldsDir).toReferenceFormat(WORLD, [
      { item_id: 'rope', name: 'Rope', description: 'Fifty feet.', quantity: 4 },
    ])

    expect(refs).toEqual([{ item_id: 'rope', quantity: 4 }])
  })
})

// ============================================================================
// PlayerService integration
// ============================================================================

describe('savePlayerState via ItemService', () => {
  function readPlayerFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(worldPath(), 'player.json'), 'utf-8')) as Record<string, unknown>
  }

  function baseState(): PlayerState {
    return {
      currentLocation: 'old_mill',
      turnCount: 1,
      stats: { hp: 10 },
      inventory: [],
      effects: [],
      recentActions: [],
      gameTime: { hour: 8, minute: 0, day: 1 },
      equipment: {},
      flags: {},
    }
  }

  test('the inventory is written in reference format and its templates created', () => {
    const service = new PlayerService(worldsDir)
    const state = baseState()
    state.inventory = [
      { item_id: 'torch', name: 'Torch', description: 'Burning.', quantity: 3, properties: { light: 2 } },
    ]

    service.savePlayerState(WORLD, state)

    expect(readPlayerFile().inventory).toEqual([
      { item_id: 'torch', quantity: 3, instance_properties: { light: 2 } },
    ])
    expect(new ItemService(worldsDir).loadItemTemplate(WORLD, 'torch')).toEqual({
      id: 'torch',
      name: 'Torch',
      description: 'Burning.',
      default_properties: { light: 2 },
    })
  })

  test('recent_actions is truncated to the last 10 entries', () => {
    const service = new PlayerService(worldsDir)
    const state = baseState()
    state.recentActions = Array.from({ length: 14 }, (_, i) => ({ action: `act-${i}` }))

    service.savePlayerState(WORLD, state)

    const saved = readPlayerFile().recent_actions as Record<string, unknown>[]
    expect(saved).toHaveLength(10)
    expect(saved[0]).toEqual({ action: 'act-4' })
    expect(saved[9]).toEqual({ action: 'act-13' })
  })

  test('getResolvedInventory expands what the save file only references', () => {
    const service = new PlayerService(worldsDir)
    const state = baseState()
    state.inventory = [
      { item_id: 'torch', name: 'Torch', description: 'Burning.', quantity: 3, properties: { light: 2 } },
    ]
    service.savePlayerState(WORLD, state)

    const resolved = service.getResolvedInventory(WORLD)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.name).toBe('Torch')
    expect(resolved[0]?.description).toBe('Burning.')
    expect(resolved[0]?.properties).toEqual({ light: { value: 2, higher_is_better: true } })
  })

  test('getResolvedInventory is empty for an empty or missing world', () => {
    const service = new PlayerService(worldsDir)
    expect(service.getResolvedInventory(WORLD)).toEqual([])

    service.savePlayerState(WORLD, baseState())
    expect(service.getResolvedInventory(WORLD)).toEqual([])
  })
})

describe('stat definitions', () => {
  test('saveStatDefinitions round-trips and invalidates the cached read', () => {
    const service = new PlayerService(worldsDir)
    expect(service.loadStatDefinitions(WORLD)).toEqual({ stats: [], derived: [] })

    service.saveStatDefinitions(WORLD, {
      stats: [{ name: 'hp', min: 0, max: 20, default: 20 }],
      derived: [],
    })

    expect(service.loadStatDefinitions(WORLD).stats).toEqual([{ name: 'hp', min: 0, max: 20, default: 20 }])
  })

  test('updateStats clamps against the definitions and persists', () => {
    const service = new PlayerService(worldsDir)
    service.saveStatDefinitions(WORLD, { stats: [{ name: 'hp', min: 0, max: 20 }], derived: [] })
    service.savePlayerState(WORLD, {
      currentLocation: null,
      turnCount: 0,
      stats: { hp: 18 },
      inventory: [],
      effects: [],
      recentActions: [],
      gameTime: { hour: 8, minute: 0, day: 1 },
      equipment: {},
      flags: {},
    })

    expect(service.updateStats(WORLD, { hp: 5 })).toEqual({ hp: 20 })
    expect(service.loadPlayerState(WORLD)?.stats).toEqual({ hp: 20 })

    // A stat with no definition is unbounded, and one absent from the file
    // starts at zero.
    expect(service.updateStats(WORLD, { luck: -3 })).toEqual({ hp: 20, luck: -3 })
  })

  test('updateStats on a world with no player.json yields no stats', () => {
    expect(new PlayerService(worldsDir).updateStats(WORLD, { hp: 1 })).toEqual({})
  })
})
