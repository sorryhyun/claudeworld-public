/**
 * The Action Manager's tool handlers — `src/sdk/handlers/`.
 *
 * Every test builds a throwaway `worlds/` root and a throwaway SQLite file.
 * Nothing here may touch the repository's `worlds/` or `agents/`, and the
 * assertions are against the filesystem and the database rather than the return
 * value wherever a tool has a side effect — a tool that reports success and
 * writes nothing is the failure mode these handlers are prone to.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import { openDb, type Db } from '@/db'
import { openAndInitDb } from '@/db/migrate'
import { agents, messages, playerStates, worlds } from '@/db/schema'
import {
  addCharacterToLocation,
  createLocation,
  getCharactersAtLocation,
  getLocationByName,
} from '@/crud/locations'
import { createRoom } from '@/crud/rooms'
import { getCache } from '@/infrastructure/cache'
import { AgentConfigService } from '@/services/agent-config-service'
import { AgentFilesystemService } from '@/services/agent-filesystem-service'
import { ItemService } from '@/services/item-service'
import { LocationStorage } from '@/services/location-storage'
import { PlayerService } from '@/services/player-service'
import { RoomMappingService } from '@/services/room-mapping'
import { MtimeCache, WorldService } from '@/services/world-service'
import { createCharacterTools } from '@/sdk/handlers/character-tools'
import { createGuidelinesTools } from '@/sdk/handlers/guidelines-tools'
import { createHistoryTools } from '@/sdk/handlers/history-tools'
import { createItemTools } from '@/sdk/handlers/item-tools'
import { createLocationTools } from '@/sdk/handlers/location-tools'
import { createNarrativeTools } from '@/sdk/handlers/narrative-tools'
import { createMechanicsTools } from '@/sdk/handlers/mechanics-tools'
import { createWorldTools } from '@/sdk/handlers/world-tools'
import type { NpcReaction, ToolContext } from '@/sdk/handlers/context'
import type { PlayerMutationsPort, TurnStatusPort } from '@/sdk/handlers/ports'
import { callTool, findTool, isError, resultText } from './tool-harness'

const WORLD_ID = 1
const WORLD = 'testworld'
const OWNER = 'admin'
const AM_ID = 1
const MARN_ID = 2

let root: string
let worldsDir: string
let db: Db
let services: {
  players: PlayerService
  rooms: RoomMappingService
  locations: LocationStorage
  worlds: WorldService
  items: ItemService
  agentFiles: AgentFilesystemService
  agentConfigs: AgentConfigService
}

/** Records every mutation instead of performing it — the facade is not ported. */
class FakeMutations implements PlayerMutationsPort {
  stats: Record<string, number>[] = []
  added: Record<string, unknown>[] = []
  removed: { itemId: string; quantity?: number }[] = []
  advanced: number[] = []
  time = { hour: 8, minute: 0, day: 1 }

  constructor(private readonly players: PlayerService) {}

  updateStats(_world: string, changes: Record<string, number>) {
    this.stats.push(changes)
    return changes
  }
  addItem(_world: string, item: Record<string, unknown>) {
    this.added.push(item)
    return true
  }
  removeItem(_world: string, itemId: string, quantity?: number) {
    this.removed.push({ itemId, quantity })
    return true
  }
  advanceTime(_world: string, minutes: number) {
    this.advanced.push(minutes)
    if (minutes <= 0) return null
    const total = this.time.hour * 60 + this.time.minute + minutes
    const newTime = {
      hour: Math.floor((total % 1440) / 60),
      minute: total % 60,
      day: this.time.day + Math.floor(total / 1440),
    }
    return { oldTime: { ...this.time }, newTime }
  }
  getInventory(world: string) {
    return this.players.getResolvedInventory(world)
  }
  loadPlayerState(world: string) {
    return this.players.loadPlayerState(world)
  }
}

function ctxFor(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentName: 'Action_Manager',
    agentId: AM_ID,
    roomId: 1,
    worldName: WORLD,
    worldId: WORLD_ID,
    longTermMemoryIndex: {},
    getDb: () => db,
    ...overrides,
  }
}

function worldPath(): string {
  return join(worldsDir, WORLD)
}

/** Write a world agent folder directly, bypassing the service under test. */
function writeAgentFolder(name: string, nutshell = `${name} is here.`): void {
  const dir = join(worldPath(), 'agents', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'in_a_nutshell.md'), nutshell, 'utf-8')
  writeFileSync(join(dir, 'characteristics.md'), 'Terse.', 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cw-tools-'))
  worldsDir = join(root, 'worlds')
  mkdirSync(worldsDir, { recursive: true })

  const dbPath = join(root, 'test.db')
  openAndInitDb({ path: dbPath }).close()
  db = openDb({ path: dbPath })
  getCache().clear()

  db.insert(worlds)
    .values({ id: WORLD_ID, name: WORLD, ownerId: OWNER, phase: 'active', language: 'en' })
    .run()
  db.insert(agents)
    .values([
      { id: AM_ID, name: 'Action_Manager', group: 'gameplay', systemPrompt: 'p' },
      {
        id: MARN_ID,
        name: 'Marn',
        group: null,
        worldName: WORLD,
        systemPrompt: 'p',
        configFile: `worlds/${WORLD}/agents/Marn`,
      },
    ])
    .run()

  const cache = new MtimeCache()
  const worldService = new WorldService(worldsDir, cache)
  worldService.createWorld(WORLD, OWNER)

  const players = new PlayerService(worldsDir, cache)
  players.savePlayerState(WORLD, {
    currentLocation: 'town_square',
    turnCount: 3,
    stats: { hp: 10 },
    inventory: [],
    effects: [],
    recentActions: [],
    gameTime: { hour: 8, minute: 0, day: 1 },
    equipment: {},
    flags: {},
  })

  services = {
    players,
    rooms: new RoomMappingService(worldsDir),
    locations: new LocationStorage(worldsDir, cache),
    worlds: worldService,
    items: new ItemService(worldsDir, cache),
    agentFiles: new AgentFilesystemService(worldsDir, cache),
    agentConfigs: new AgentConfigService(root),
  }
})

afterEach(() => {
  db.$client.close()
  rmSync(root, { recursive: true, force: true })
})

// ============================================================================
// character-tools
// ============================================================================

describe('remove_character', () => {
  function tools() {
    return createCharacterTools(ctxFor(), {
      agentFiles: services.agentFiles,
      players: services.players,
      rooms: services.rooms,
      locations: services.locations,
    })
  }

  test('takes the character out of the room mapping and the location row', async () => {
    writeAgentFolder('Old_Marn')
    const location = createLocation(db, WORLD_ID, { name: 'town_square' })
    db.update(agents).set({ name: 'Old_Marn' }).where(eq(agents.id, MARN_ID)).run()
    addCharacterToLocation(db, MARN_ID, location.id)
    services.rooms.setRoomMapping(WORLD, 'location:town_square', location.roomId!, ['Old_Marn'])

    // The display name, spelled with a space where the folder has an underscore
    // — the spelling the model reaches for, and the one the variant match exists
    // to accept.
    const result = await callTool(findTool(tools(), 'remove_character'), {
      character_name: 'Old Marn',
    })

    expect(resultText(result)).toContain('**Character Removed from Location:**')
    expect(resultText(result)).toContain('- Name: Old Marn')
    expect(services.rooms.getRoomMapping(WORLD, 'location:town_square')?.agents).toEqual([])
    expect(getCharactersAtLocation(db, location.id)).toEqual([])
  })

  test('reports the roster when the name does not resolve', async () => {
    writeAgentFolder('Old_Marn')
    const result = await callTool(findTool(tools(), 'remove_character'), {
      character_name: 'Nobody',
    })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain("Character 'Nobody' not found.")
    expect(resultText(result)).toContain('Available characters: Old_Marn')
  })

  test('says "none" when the world has no characters at all', async () => {
    const result = await callTool(findTool(tools(), 'remove_character'), {
      character_name: 'Nobody',
    })
    expect(resultText(result)).toContain('Available characters: none')
  })

  test('is a no-op, reported as success, when the character is elsewhere', async () => {
    writeAgentFolder('Old_Marn')
    const result = await callTool(findTool(tools(), 'remove_character'), {
      character_name: 'Old_Marn',
    })
    expect(isError(result)).toBe(false)
    expect(resultText(result)).toBe(
      "Character 'Old Marn' was not at the current location (town_square).",
    )
  })
})

describe('delete_character', () => {
  function tools() {
    return createCharacterTools(ctxFor(), {
      agentFiles: services.agentFiles,
      players: services.players,
      rooms: services.rooms,
      locations: services.locations,
    })
  }

  test('archives the folder rather than deleting it', async () => {
    writeAgentFolder('Old_Marn')
    const result = await callTool(findTool(tools(), 'delete_character'), {
      character_name: 'Old Marn',
      reason: 'magic',
      narrative: 'A door closes.',
    })

    expect(resultText(result)).toContain('- Reason: magic')
    expect(resultText(result)).toContain('- Narrative: A door closes.')
    expect(existsSync(join(worldPath(), 'agents', 'Old_Marn'))).toBe(false)
    expect(readdirSync(join(worldPath(), 'agents', '_archived'))[0]).toStartWith('Old_Marn_')
  })

  test('falls back to "death" for an unrecognised reason', async () => {
    writeAgentFolder('Old_Marn')
    const result = await callTool(findTool(tools(), 'delete_character'), {
      character_name: 'Old_Marn',
      // The tool's own description advertises this reason; Python's map is keyed
      // on `disappearance` and silently renders it as death.
      reason: '실종',
    })
    expect(resultText(result)).toContain('- Reason: death')
  })

  test('reports a missing character as success, not error', async () => {
    const result = await callTool(findTool(tools(), 'delete_character'), {
      character_name: 'Ghost',
    })
    expect(isError(result)).toBe(false)
    expect(resultText(result)).toBe("Character 'Ghost' not found or already deleted.")
  })
})

describe('move_character', () => {
  function tools() {
    return createCharacterTools(ctxFor(), {
      agentFiles: services.agentFiles,
      players: services.players,
      rooms: services.rooms,
      locations: services.locations,
    })
  }

  function seedTwoLocations(): void {
    services.locations.createLocation(WORLD, 'town_square', 'Town Square', 'Cobbles.', [0, 0])
    services.locations.createLocation(WORLD, 'old_mill', 'Old Mill', 'A creaking wheel.', [1, 0])
    const square = createLocation(db, WORLD_ID, { name: 'town_square', displayName: 'Town Square' })
    const mill = createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })
    services.rooms.setRoomMapping(WORLD, 'location:town_square', square.roomId!, ['Marn'])
    services.rooms.setRoomMapping(WORLD, 'location:old_mill', mill.roomId!, [])
  }

  test('pulls the character out of every other location before adding them', async () => {
    writeAgentFolder('Marn')
    seedTwoLocations()

    const result = await callTool(findTool(tools(), 'move_character'), {
      character_name: 'Marn',
      destination: 'old_mill',
      narrative: 'He trudges off.',
    })

    expect(resultText(result)).toContain('- Destination: old_mill')
    expect(resultText(result)).toContain('- Narrative: He trudges off.')
    expect(services.rooms.getRoomMapping(WORLD, 'location:town_square')?.agents).toEqual([])
    expect(services.rooms.getRoomMapping(WORLD, 'location:old_mill')?.agents).toEqual(['Marn'])
    expect(getLocationByName(db, WORLD_ID, 'old_mill')).not.toBeNull()
  })

  test('lists the known locations when the destination does not exist', async () => {
    writeAgentFolder('Marn')
    seedTwoLocations()

    const result = await callTool(findTool(tools(), 'move_character'), {
      character_name: 'Marn',
      destination: 'the moon',
    })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain("Location 'the moon' not found.")
    expect(resultText(result)).toContain('old_mill')
  })

  test('refuses a character with no folder on disk', async () => {
    seedTwoLocations()
    const result = await callTool(findTool(tools(), 'move_character'), {
      character_name: 'Marn',
      destination: 'old_mill',
    })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain('not found in filesystem')
  })
})

// ============================================================================
// mechanics-tools
// ============================================================================

describe('inject_memory', () => {
  function tools(mutations?: PlayerMutationsPort) {
    return createMechanicsTools(ctxFor(), {
      players: services.players,
      items: services.items,
      agentConfigs: services.agentConfigs,
      mutations,
    })
  }

  test('appends to the target character\'s recent_events.md with the in-world clock', async () => {
    // `AgentConfigService` resolves `config_file` against the *project* root, so
    // the folder has to sit under it, not merely under `worlds/`.
    mkdirSync(join(root, 'worlds', WORLD, 'agents', 'Marn'), { recursive: true })

    const result = await callTool(findTool(tools(), 'inject_memory'), {
      character_name: 'Marn',
      memory_entry: 'Saw a figure in the mist',
    })

    expect(resultText(result)).toContain('**Memory Injected:**')
    const written = readFileSync(
      join(worldPath(), 'agents', 'Marn', 'recent_events.md'),
      'utf-8',
    )
    // Leading newline, so entries are blank-line separated.
    expect(written).toBe('\n- [Day 1, 08:00] Saw a figure in the mist\n')
  })

  test('refuses an unknown character and points at list_characters', async () => {
    const result = await callTool(findTool(tools(), 'inject_memory'), {
      character_name: 'Ghost',
      memory_entry: 'x',
    })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain('Use list_characters')
  })

  test('refuses a character with no config file', async () => {
    db.insert(agents)
      .values({ id: 9, name: 'Rootless', worldName: WORLD, systemPrompt: 'p', configFile: null })
      .run()

    const result = await callTool(findTool(tools(), 'inject_memory'), {
      character_name: 'Rootless',
      memory_entry: 'x',
    })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain('does not have a config file')
  })
})

describe('list_inventory', () => {
  function tools() {
    return createMechanicsTools(ctxFor(), {
      players: services.players,
      items: services.items,
      agentConfigs: services.agentConfigs,
    })
  }

  test('reports an empty inventory in one line', async () => {
    expect(resultText(await callTool(findTool(tools(), 'list_inventory')))).toBe(
      '**Inventory:** Empty',
    )
  })

  test('shows the count, quantities and truncated descriptions', async () => {
    services.items.saveItemTemplate(WORLD, {
      itemId: 'lantern',
      name: 'Old Lantern',
      description: 'D'.repeat(120),
    })
    services.items.saveItemTemplate(WORLD, { itemId: 'rope', name: 'Rope' })

    const state = services.players.loadPlayerState(WORLD)!
    state.inventory = [
      { item_id: 'lantern', quantity: 1 },
      { item_id: 'rope', quantity: 3 },
    ]
    services.players.savePlayerState(WORLD, state)

    const text = resultText(await callTool(findTool(tools(), 'list_inventory')))
    expect(text).toStartWith('**Inventory (2 items):**')
    expect(text).toContain('- **Old Lantern**: ' + 'D'.repeat(80) + '...')
    expect(text).toContain('- **Rope** x3')
  })
})

describe('list_world_item', () => {
  function tools() {
    return createMechanicsTools(ctxFor(), {
      players: services.players,
      items: services.items,
      agentConfigs: services.agentConfigs,
    })
  }

  test('reports an empty items/ directory', async () => {
    expect(resultText(await callTool(findTool(tools(), 'list_world_item')))).toContain(
      'No items defined',
    )
  })

  test('lists ids, descriptions and default properties', async () => {
    services.items.saveItemTemplate(WORLD, {
      itemId: 'lantern',
      name: 'Old Lantern',
      description: 'It flickers.',
      properties: { light: 3 },
    })

    const text = resultText(await callTool(findTool(tools(), 'list_world_item')))
    expect(text).toStartWith('**World Items (1):**')
    expect(text).toContain('- **Old Lantern** (`lantern`)')
    expect(text).toContain('Properties: light: 3')
  })

  test('filters case-insensitively and reports the filter in the header', async () => {
    services.items.saveItemTemplate(WORLD, { itemId: 'lantern', name: 'Old Lantern' })
    services.items.saveItemTemplate(WORLD, { itemId: 'rope', name: 'Rope' })

    const hit = resultText(
      await callTool(findTool(tools(), 'list_world_item'), { keyword: 'LANT' }),
    )
    expect(hit).toStartWith("**World Items (1 matching 'lant'):**")

    const miss = resultText(
      await callTool(findTool(tools(), 'list_world_item'), { keyword: 'sword' }),
    )
    expect(miss).toBe("**World Items:** No items found matching 'sword'.")
  })
})

describe('change_stat', () => {
  let mutations: FakeMutations

  function tools() {
    mutations = new FakeMutations(services.players)
    return createMechanicsTools(ctxFor(), {
      players: services.players,
      items: services.items,
      agentConfigs: services.agentConfigs,
      mutations,
    })
  }

  test('applies stat deltas and signs them in the report', async () => {
    const text = resultText(
      await callTool(findTool(tools(), 'change_stat'), {
        summary: 'The fall hurt.',
        stat_changes: [
          { stat_name: 'hp', delta: -4 },
          { stat_name: 'morale', delta: 2 },
        ],
      }),
    )

    expect(mutations.stats).toEqual([{ hp: -4, morale: 2 }])
    expect(text).toContain('**Changes Applied:**\nThe fall hurt.')
    expect(text).toContain('- hp: -4')
    expect(text).toContain('- morale: +2')
  })

  test('skips an item with no template and warns about it', async () => {
    const text = resultText(
      await callTool(findTool(tools(), 'change_stat'), {
        summary: 'Loot.',
        inventory_changes: [{ action: 'add', item_id: 'excalibur', name: 'Excalibur' }],
      }),
    )

    expect(mutations.added).toEqual([])
    expect(text).toContain('⚠️ SKIPPED: Excalibur (item not in items/ directory)')
    expect(text).toContain('Use Task with item_designer')
  })

  test('adds an item that does have a template', async () => {
    services.items.saveItemTemplate(WORLD, { itemId: 'rope', name: 'Rope' })

    const text = resultText(
      await callTool(findTool(tools(), 'change_stat'), {
        summary: 'Loot.',
        inventory_changes: [{ action: 'add', item_id: 'rope', name: 'Rope', quantity: 2 }],
      }),
    )

    expect(mutations.added).toEqual([
      { itemId: 'rope', name: 'Rope', quantity: 2, description: null, properties: {} },
    ])
    expect(text).toContain('- Add: Rope x2')
  })

  test('removes an item without requiring a template', async () => {
    await callTool(findTool(tools(), 'change_stat'), {
      summary: 'Dropped it.',
      inventory_changes: [{ action: 'remove', item_id: 'ghost_item', quantity: 1 }],
    })
    expect(mutations.removed).toEqual([{ itemId: 'ghost_item', quantity: 1 }])
  })
})

describe('advance_time', () => {
  let mutations: FakeMutations

  function tools() {
    mutations = new FakeMutations(services.players)
    return createMechanicsTools(ctxFor(), {
      players: services.players,
      items: services.items,
      agentConfigs: services.agentConfigs,
      mutations,
    })
  }

  test('reports the new clock, zero-padded, with the day', async () => {
    const text = resultText(
      await callTool(findTool(tools(), 'advance_time'), { minutes: 65, reason: 'Walking' }),
    )
    expect(mutations.advanced).toEqual([65])
    expect(text).toContain('**Time Advanced:** +65 minutes')
    expect(text).toContain('- New time: 09:05 (Day 1)')
  })

  test('reports success without a clock when there is no player state', async () => {
    const built = tools()
    mutations.advanceTime = () => null
    const text = resultText(
      await callTool(findTool(built, 'advance_time'), { minutes: 5, reason: 'Waiting' }),
    )
    expect(text).toBe('**Time Advanced:** +5 minutes\n- Reason: Waiting')
  })

  test('rejects a non-positive delta at the schema, before the handler runs', () => {
    const built = tools()
    expect(callTool(findTool(built, 'advance_time'), { minutes: 0, reason: 'x' })).rejects.toThrow()
  })
})

// ============================================================================
// location-tools
// ============================================================================

describe('travel', () => {
  const status: TurnStatusPort & { calls: string[] } = {
    calls: [],
    setSubAgentActive(_room, name, text) {
      this.calls.push(`active:${name}:${text}`)
    },
    setSubAgentInactive() {
      this.calls.push('inactive')
    },
    triggerNpcMemoryRound: async () => 2,
    preConnectLocation() {
      this.calls.push('preconnect')
    },
  }

  function tools() {
    status.calls = []
    return createLocationTools(ctxFor(), {
      players: services.players,
      rooms: services.rooms,
      locations: services.locations,
      worlds: services.worlds,
      status,
    })
  }

  function seed(): void {
    services.locations.createLocation(WORLD, 'town_square', 'Town Square', 'Cobbles.', [0, 0])
    services.locations.createLocation(WORLD, 'old_mill', 'Old Mill', 'A creaking wheel.', [1, 0])
    createLocation(db, WORLD_ID, { name: 'town_square', displayName: 'Town Square' })
    createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })
  }

  const validArgs = {
    destination: 'old_mill',
    narration: 'The mill looms.',
    action_1: 'Enter',
    action_2: 'Circle around',
    chat_summary: 'The square emptied out.',
    user_action: 'Go to the mill',
  }

  test('performs the whole scene change in one call', async () => {
    seed()
    const roomBefore = getLocationByName(db, WORLD_ID, 'old_mill')!.roomId
    const text = resultText(await callTool(findTool(tools(), 'travel'), validArgs))

    expect(text).toStartWith('**Traveled to:** old_mill')
    expect(text).toContain('Narrative message created and displayed to player.')

    // A *new* room, so the arrival does not inherit the last visit's history.
    // `createNewRoomForLocation` repoints the location row at it, so the check
    // is against the room id captured before the call.
    const roomId = services.rooms.getRoomId(WORLD, 'location:old_mill')!
    expect(roomId).not.toBe(roomBefore)
    expect(getLocationByName(db, WORLD_ID, 'old_mill')!.roomId).toBe(roomId)

    // The narration lands in the new room, not the departure room.
    const written = db.select().from(messages).all()
    expect(written).toHaveLength(1)
    expect(written[0]!.roomId).toBe(roomId)
    expect(written[0]!.content).toBe('The mill looms.')

    expect(services.players.loadPlayerState(WORLD)!.currentLocation).toBe('old_mill')
    expect(services.rooms.loadSuggestions(WORLD)).toEqual(['Enter', 'Circle around'])
    expect(services.rooms.loadAndClearArrivalContext(WORLD)?.triggeringAction).toBe(
      'Go to the mill',
    )

    // The history entry is numbered from the *database* turn count.
    expect(services.worlds.loadHistory(WORLD)).toContain('The square emptied out.')
    expect(services.worlds.loadHistory(WORLD)).toContain('Town Square')
  })

  test('lights the departure room indicator and always clears it', async () => {
    seed()
    await callTool(findTool(tools(), 'travel'), validArgs)
    expect(status.calls[0]).toBe('active:Travel:Traveling to old_mill...')
    expect(status.calls.at(-1)).toBe('inactive')
  })

  test('clears the indicator even when the destination does not exist', async () => {
    seed()
    const result = await callTool(findTool(tools(), 'travel'), {
      ...validArgs,
      destination: 'atlantis',
    })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain('Use Task tool with location_designer')
    expect(resultText(result)).toContain('Available locations: town_square, old_mill')
    expect(status.calls.at(-1)).toBe('inactive')
    // Nothing was written: no narration, no suggestions, no move.
    expect(db.select().from(messages).all()).toHaveLength(0)
    expect(services.players.loadPlayerState(WORLD)!.currentLocation).toBe('town_square')
  })

  test('brings named companions along and reports them', async () => {
    seed()
    const square = getLocationByName(db, WORLD_ID, 'town_square')!
    addCharacterToLocation(db, MARN_ID, square.id)

    const text = resultText(
      await callTool(findTool(tools(), 'travel'), {
        ...validArgs,
        bring_characters: '["Marn", "Ghost"]',
      }),
    )
    // The one that resolves is listed; the one that does not is skipped silently.
    expect(text).toContain('- Companions: Marn')
    expect(text).not.toContain('Ghost')
  })
})

// ============================================================================
// item-tools
// ============================================================================

describe('narration', () => {
  /**
   * The Action Manager is a hidden agent, so `turn.ts` persists nothing for it
   * and never fires its `onMessageSaved`. That makes this tool the only place a
   * gameplay turn produces a `new_message` — without the callback the line the
   * player waited a whole turn for appears whenever the next poll lands.
   */
  let roomId: number

  beforeEach(() => {
    roomId = createRoom(db, { name: 'Location: Town Square' }, OWNER, WORLD_ID).id
  })

  function tools(onNarrationSaved?: (roomId: number, message: { id: number }) => void) {
    return createNarrativeTools(ctxFor({ roomId }), {
      players: services.players,
      rooms: services.rooms,
      onNarrationSaved: onNarrationSaved as never,
    })
  }

  test('announces the saved row so it can be pushed to the room', async () => {
    const saved: { roomId: number; id: number }[] = []
    await callTool(findTool(tools((roomId, message) => {
      saved.push({ roomId, id: message.id })
    }), 'narration'), { narrative: 'The mill looms.' })

    const written = db.select().from(messages).all()
    expect(written).toHaveLength(1)
    expect(saved).toEqual([{ roomId, id: written[0]!.id }])
  })

  test('the announced row carries the agent the frontend labels the bubble with', async () => {
    let agentName: string | null | undefined
    await callTool(findTool(tools((_roomId, message) => {
      agentName = (message as unknown as { agent: { name: string } | null }).agent?.name
    }), 'narration'), { narrative: 'The mill looms.' })

    expect(agentName).toBe('Action_Manager')
  })

  test('persists the line even with nobody listening', async () => {
    await callTool(findTool(tools(), 'narration'), { narrative: 'The mill looms.' })
    expect(db.select().from(messages).all()[0]!.content).toBe('The mill looms.')
  })
})

describe('await_reactions', () => {
  /**
   * The NPCs run beside the Action Manager rather than before it, so this tool
   * is how their lines reach the only agent that can speak them to the player.
   */
  let roomId: number

  beforeEach(() => {
    roomId = createRoom(db, { name: 'Location: Town Square' }, OWNER, WORLD_ID).id
  })

  function toolsWith(overrides: Partial<ToolContext>) {
    return createNarrativeTools(ctxFor({ roomId, ...overrides }), {
      players: services.players,
      rooms: services.rooms,
    })
  }

  test('waits for the NPCs still speaking and returns every line verbatim', async () => {
    let release: ((value: NpcReaction[]) => void) | null = null
    const collected: NpcReaction[] = []
    const pending = new Promise<NpcReaction[]>((resolve) => {
      release = resolve
    })

    const call = callTool(
      findTool(
        toolsWith({
          npcReactions: collected,
          awaitNpcReactions: async () => {
            const settled = await pending
            collected.splice(0, collected.length, ...settled)
            return collected
          },
        }),
        'await_reactions',
      ),
      {},
    )

    release!([
      { agentId: 1, agentName: 'Elara', content: '"Where did you hear that name?"' },
      { agentId: 2, agentName: 'Marcus', content: 'He sets down the crate and says nothing.' },
    ])

    const text = resultText(await call)
    expect(text).toContain("2 character(s) reacted to the player's action")
    expect(text).toContain('### Elara')
    expect(text).toContain('"Where did you hear that name?"')
    expect(text).toContain('### Marcus')
    expect(text).toContain('He sets down the crate and says nothing.')
  })

  test('the awaited reactions land where `narration` reads them from', async () => {
    // The `thinking` column is the only durable record of a reaction, and it is
    // written from the same array this tool fills.
    const collected: NpcReaction[] = []
    const built = toolsWith({
      npcReactions: collected,
      awaitNpcReactions: () => {
        collected.push({ agentId: 1, agentName: 'Elara', content: 'She laughs.' })
        return Promise.resolve(collected)
      },
    })

    await callTool(findTool(built, 'await_reactions'), {})
    await callTool(findTool(built, 'narration'), { narrative: 'The mill looms.' })

    expect(db.select().from(messages).all()[0]!.thinking).toContain('=== Elara ===')
  })

  test('an empty location says so rather than returning nothing', async () => {
    const text = resultText(await callTool(findTool(toolsWith({}), 'await_reactions'), {}))
    expect(text).toContain('No one else is at this location')
  })
})

describe('persist_item', () => {
  function tools(mutations?: PlayerMutationsPort) {
    return createItemTools(ctxFor(), {
      items: services.items,
      players: services.players,
      mutations,
    })
  }

  test('writes a template per item and reports properties inline', async () => {
    const text = resultText(
      await callTool(findTool(tools(), 'persist_item'), {
        items: [
          {
            item_id: 'lantern',
            name: 'Old Lantern',
            description: 'It flickers.',
            properties: { light: 3 },
          },
          { item_id: 'rope', name: 'Rope', description: 'Coarse hemp.' },
        ],
      }),
    )

    expect(text).toStartWith('**Created 2 item(s):**')
    expect(text).toContain('- `lantern`: Old Lantern (light=3)')
    expect(text).toContain('Action Manager can add these items to inventory via change_stat.')
    expect(services.items.loadItemTemplate(WORLD, 'lantern')?.name).toBe('Old Lantern')
    expect(services.items.loadItemTemplate(WORLD, 'rope')?.name).toBe('Rope')
  })

  test('skips an id that already exists instead of overwriting it', async () => {
    services.items.saveItemTemplate(WORLD, { itemId: 'rope', name: 'Author-written rope' })

    const text = resultText(
      await callTool(findTool(tools(), 'persist_item'), {
        items: [{ item_id: 'rope', name: 'Model rope', description: 'x' }],
      }),
    )

    expect(text).toContain('**Skipped 1 (already exist):** rope')
    expect(services.items.loadItemTemplate(WORLD, 'rope')?.name).toBe('Author-written rope')
  })

  test('adds to inventory through the facade when one is available', async () => {
    const mutations = new FakeMutations(services.players)
    const text = resultText(
      await callTool(findTool(tools(mutations), 'persist_item'), {
        items: [{ item_id: 'rope', name: 'Rope', description: 'x', quantity: 2 }],
        add_to_inventory: true,
      }),
    )
    expect(mutations.added).toHaveLength(1)
    expect(text).toContain('**Added to inventory:** 2x Rope')
  })

  test('falls back to a filesystem-only append with no facade', async () => {
    await callTool(findTool(tools(), 'persist_item'), {
      items: [{ item_id: 'rope', name: 'Rope', description: 'x', quantity: 2 }],
      add_to_inventory: true,
    })
    expect(services.players.loadPlayerState(WORLD)!.inventory).toEqual([
      { item_id: 'rope', quantity: 2 },
    ])
  })

  test('warns when nothing was created but inventory was requested', async () => {
    services.items.saveItemTemplate(WORLD, { itemId: 'rope', name: 'Rope' })
    const text = resultText(
      await callTool(findTool(tools(), 'persist_item'), {
        items: [{ item_id: 'rope', name: 'Rope', description: 'x' }],
        add_to_inventory: true,
      }),
    )
    expect(text).toContain('⚠️ No items added to inventory (all items already existed)')
  })

  test('rejects an empty batch at the schema', () => {
    expect(callTool(findTool(tools(), 'persist_item'), { items: [] })).rejects.toThrow()
  })
})

// ============================================================================
// history-tools
// ============================================================================

describe('recall_history', () => {
  function writeConsolidated(body: string): void {
    writeFileSync(join(worldPath(), 'consolidated_history.md'), body, 'utf-8')
  }

  test('is not offered at all when the world has no consolidated history', () => {
    expect(createHistoryTools(ctxFor(), { worlds: services.worlds })).toEqual([])
  })

  test('returns the matching section verbatim', async () => {
    writeConsolidated('## [the_fire]\nThe granary burned.\n\n## [the_pact]\nThey shook hands.')
    const tools = createHistoryTools(ctxFor(), { worlds: services.worlds })

    const text = resultText(await callTool(findTool(tools, 'recall_history'), {
      subtitle: 'the_fire',
    }))
    expect(text).toContain('The granary burned.')
    expect(text).not.toContain('They shook hands.')
  })

  test('lists the available subtitles on a miss, as an error', async () => {
    writeConsolidated('## [the_fire]\nThe granary burned.')
    const tools = createHistoryTools(ctxFor(), { worlds: services.worlds })

    const result = await callTool(findTool(tools, 'recall_history'), { subtitle: 'the_flood' })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toBe(
      "History entry 'the_flood' not found. Available entries: 'the_fire'",
    )
  })

  test('lists the subtitles in the description', () => {
    writeConsolidated('## [the_fire]\nx\n\n## [the_pact]\ny')
    const tools = createHistoryTools(ctxFor(), { worlds: services.worlds })
    expect(findTool(tools, 'recall_history').description).toContain("'the_fire', 'the_pact'")
  })
})

// ============================================================================
// world-tools — list_characters, whose default scope is the whole world
// ============================================================================

describe('list_characters', () => {
  function tools() {
    return createWorldTools(ctxFor(), {
      locations: services.locations,
      agentFiles: services.agentFiles,
      rooms: services.rooms,
    })
  }

  /** Place `name` at `location`, creating both the agent row and the location. */
  function placeCharacter(name: string, location: string, nutshell: string): number {
    const existing = getLocationByName(db, WORLD_ID, location)
    const row = existing ?? createLocation(db, WORLD_ID, { name: location })
    const agent = db
      .insert(agents)
      .values({ name, group: null, worldName: WORLD, systemPrompt: 'p', inANutshell: nutshell })
      .returning({ id: agents.id })
      .get()
    addCharacterToLocation(db, agent.id, row.id)
    return row.id
  }

  function standAt(locationId: number): void {
    db.insert(playerStates).values({ id: 1, worldId: WORLD_ID, currentLocationId: locationId }).run()
  }

  test('lists every character in the world, grouped by location', async () => {
    const square = placeCharacter('Brannt', 'town_square', 'A blacksmith.')
    placeCharacter('Ilva', 'north_road', 'A courier.')
    standAt(square)

    const text = resultText(await callTool(findTool(tools(), 'list_characters'), {}))

    // The point of the change: someone a whole location away is still visible,
    // so the Action Manager reuses Ilva instead of inventing a second courier.
    expect(text).toContain('**Brannt**: A blacksmith.')
    expect(text).toContain('**Ilva**: A courier.')
    expect(text).toContain('### town_square (current location)')
    expect(text).toContain('### north_road')
    expect(text).not.toContain('### north_road (current location)')
  })

  test('still names the current location when nobody is standing in it', async () => {
    placeCharacter('Ilva', 'north_road', 'A courier.')
    const square = createLocation(db, WORLD_ID, { name: 'town_square' })
    standAt(square.id)

    const text = resultText(await callTool(findTool(tools(), 'list_characters'), {}))
    expect(text).toContain('### town_square (current location)\n- nobody')
    expect(text).toContain('**Ilva**: A courier.')
  })

  test('narrows to one location when asked', async () => {
    const square = placeCharacter('Brannt', 'town_square', 'A blacksmith.')
    placeCharacter('Ilva', 'north_road', 'A courier.')
    standAt(square)

    const text = resultText(
      await callTool(findTool(tools(), 'list_characters'), { location: 'north_road' }),
    )
    expect(text).toBe('- **Ilva**: A courier.')
  })

  test('says so for a location that holds nobody', async () => {
    createLocation(db, WORLD_ID, { name: 'north_road' })
    const text = resultText(
      await callTool(findTool(tools(), 'list_characters'), { location: 'north_road' }),
    )
    expect(text).toBe('Nobody is at "north_road".')
  })

  test('rejects a location that does not exist', async () => {
    const text = resultText(
      await callTool(findTool(tools(), 'list_characters'), { location: 'the_moon' }),
    )
    expect(text).toBe('No location named "the_moon" exists in this world.')
  })

  test('lists a character that has a folder but no location row', async () => {
    const square = placeCharacter('Brannt', 'town_square', 'A blacksmith.')
    standAt(square)
    // What `persist_character_design` leaves behind during onboarding: a folder
    // and nothing else. Before this it was invisible, and got designed again.
    writeAgentFolder('Vess', 'A ferryman.')

    const text = resultText(await callTool(findTool(tools(), 'list_characters'), {}))
    expect(text).toContain('### Not at any location\n- **Vess**: A ferryman.')
    expect(text).toContain('`move_character`')
  })

  test('groups an unrowed character by its seat in the room mapping', async () => {
    const square = placeCharacter('Brannt', 'town_square', 'A blacksmith.')
    standAt(square)
    writeAgentFolder('Vess', 'A ferryman.')
    const road = createLocation(db, WORLD_ID, { name: 'north_road' })
    services.rooms.setRoomMapping(WORLD, 'location:north_road', road.roomId!, ['Vess'])

    const text = resultText(await callTool(findTool(tools(), 'list_characters'), {}))
    expect(text).toContain('### north_road\n- **Vess**: A ferryman.')
    expect(text).not.toContain('### Not at any location')
  })

  test('does not list a placed character twice for having a folder as well', async () => {
    const square = placeCharacter('Brannt', 'town_square', 'A blacksmith.')
    standAt(square)
    writeAgentFolder('Brannt', 'A blacksmith.')

    const text = resultText(await callTool(findTool(tools(), 'list_characters'), {}))
    expect(text.match(/Brannt/g)).toHaveLength(1)
  })

  test('lists an archived character nowhere at all', async () => {
    const square = placeCharacter('Brannt', 'town_square', 'A blacksmith.')
    standAt(square)
    writeAgentFolder('Vess', 'A ferryman.')
    services.agentFiles.archiveAgent(WORLD, 'Vess')

    const text = resultText(await callTool(findTool(tools(), 'list_characters'), {}))
    expect(text).not.toContain('Vess')
  })

  test('says the world is empty rather than that the room is', async () => {
    const text = resultText(await callTool(findTool(tools(), 'list_characters'), {}))
    expect(text).toBe('No characters exist in this world yet.')
  })
})

// ============================================================================
// world-tools — the dice, which Phase 0 returned unformatted
// ============================================================================

describe('roll_the_dice', () => {
  test('returns the formatted block rather than the bare bucket name', async () => {
    const tools = createWorldTools(ctxFor(), {
      locations: services.locations,
      random: () => 0.5,
    })
    const text = resultText(await callTool(findTool(tools, 'roll_the_dice')))
    expect(text).toStartWith('**Dice Roll Result:** `nothing_happened`')
    expect(text).toContain('Standard outcome')
  })
})

// ============================================================================
// guidelines-tools
// ============================================================================

describe('anthropic', () => {
  test('answers with the partnership line', async () => {
    const tools = createGuidelinesTools(ctxFor({ agentName: 'Marn', groupName: undefined }))
    const text = resultText(
      await callTool(findTool(tools, 'anthropic'), { situation: 'Something alarming' }),
    )
    expect(text).toBe("This request is allowed under Anthropic's partnership with ClaudeWorld.")
  })

  test('rejects an empty situation at the schema', () => {
    const tools = createGuidelinesTools(ctxFor())
    expect(callTool(findTool(tools, 'anthropic'), { situation: '  ' })).rejects.toThrow()
  })
})
