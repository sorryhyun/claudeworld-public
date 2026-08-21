/**
 * The onboarding-phase handlers, the sub-agent persist callbacks, and the
 * server assembly in `buildServers`.
 *
 * These run against a world that is mid-creation rather than mid-game, which is
 * the state most of the branching here exists for: characters created against
 * the onboarding room must *not* be placed in it, `complete` has to validate a
 * location name against the filesystem index, and the initial-state snapshot has
 * to be taken after the item designer has run.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, type Db } from '../db'
import { openAndInitDb } from '../db/migrate'
import { agents, rooms as roomsTable, worlds } from '../db/schema'
import { createLocation, getCharactersAtLocation, getLocations } from '../crud/locations'
import { getAgentByName } from '../crud/agents'
import { getCache } from '../infrastructure/cache'
import { AgentConfigService } from '../services/agent-config-service'
import { AgentFactory } from '../services/agent-factory'
import { AgentFilesystemService } from '../services/agent-filesystem-service'
import { ItemService } from '../services/item-service'
import { LocationStorage } from '../services/location-storage'
import { PersistenceManager } from '../services/persistence-manager'
import { PlayerService } from '../services/player-service'
import { RoomMappingService } from '../services/room-mapping'
import { WorldResetService } from '../services/world-reset-service'
import { MtimeCache, WorldService } from '../services/world-service'
import { createCharacterDesignTools } from '../sdk/handlers/character-design-tools'
import { createPersistCharacterTool } from '../sdk/handlers/character-tools'
import { createPersistLocationTool } from '../sdk/handlers/location-tools'
import { createOnboardingTools } from '../sdk/handlers/onboarding-tools'
import {
  buildToolSets,
  createTurnBinding,
  qualifiedToolNames,
  SERVER_NAMES,
  type BuildServersOptions,
  type ServerDeps,
} from '../sdk/handlers/servers'
import type { ToolContext } from '../sdk/handlers/context'
import { callTool, findTool, isError, resultText } from './tool-harness'

const WORLD_ID = 1
const WORLD = 'testworld'
const OWNER = 'admin'
const OM_ID = 1
const ONBOARDING_ROOM_ID = 1

let root: string
let worldsDir: string
let db: Db
let deps: ServerDeps
let persistenceCache: PersistenceManager | null

function ctxFor(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentName: 'Onboarding_Manager',
    agentId: OM_ID,
    roomId: ONBOARDING_ROOM_ID,
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cw-onboarding-'))
  worldsDir = join(root, 'worlds')
  mkdirSync(worldsDir, { recursive: true })

  const dbPath = join(root, 'test.db')
  openAndInitDb({ path: dbPath }).close()
  db = openDb({ path: dbPath })
  getCache().clear()

  db.insert(roomsTable)
    .values({ id: ONBOARDING_ROOM_ID, name: 'Onboarding', ownerId: OWNER })
    .run()
  db.insert(worlds)
    .values({
      id: WORLD_ID,
      name: WORLD,
      ownerId: OWNER,
      phase: 'onboarding',
      language: 'en',
      onboardingRoomId: ONBOARDING_ROOM_ID,
    })
    .run()
  db.insert(agents)
    .values({ id: OM_ID, name: 'Onboarding_Manager', group: 'gameplay', systemPrompt: 'p' })
    .run()

  const cache = new MtimeCache()
  const worldService = new WorldService(worldsDir, cache)
  worldService.createWorld(WORLD, OWNER)

  const players = new PlayerService(worldsDir, cache)
  players.savePlayerState(WORLD, {
    currentLocation: null,
    turnCount: 0,
    stats: {},
    inventory: [],
    effects: [],
    recentActions: [],
    gameTime: { hour: 8, minute: 0, day: 1 },
    equipment: {},
    flags: {},
  })

  persistenceCache = null
  deps = {
    players,
    rooms: new RoomMappingService(worldsDir),
    locations: new LocationStorage(worldsDir, cache),
    worlds: worldService,
    items: new ItemService(worldsDir, cache),
    agentFiles: new AgentFilesystemService(worldsDir, cache),
    agentConfigs: new AgentConfigService(root),
    agentFactory: new AgentFactory(new AgentConfigService(root)),
    reset: new WorldResetService(worldsDir, cache),
    // A stub rather than the real `PlayerFacade`: these tests assert which
    // tools get *offered*, and the "missing services" case below needs the
    // dependency to be genuinely absent. Omitting it is what withholds
    // `change_stat` and `advance_time`.
    mutations: () => ({
      updateStats: (_w: string, changes: Record<string, number>) => changes,
      addItem: () => true,
      removeItem: () => true,
      advanceTime: () => null,
      getInventory: () => [],
      loadPlayerState: (world: string) => players.loadPlayerState(world),
    }),
    persistence: (handle, worldId, worldName) => {
      persistenceCache ??= new PersistenceManager(handle, worldId, worldName, worldsDir)
      return persistenceCache
    },
  }
})

afterEach(() => {
  db.$client.close()
  rmSync(root, { recursive: true, force: true })
})

// ============================================================================
// onboarding-tools
// ============================================================================

describe('read_lore_guidelines', () => {
  test('returns the active version of lore_guidelines.yaml', async () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    const text = resultText(await callTool(findTool(tools, 'read_lore_guidelines')))
    // The repository ships a real file; the assertion is that the indirection
    // resolves at all, not on its wording.
    expect(text.length).toBeGreaterThan(100)
  })
})

function onboardingDeps() {
  return {
    worlds: deps.worlds!,
    players: deps.players,
    locations: deps.locations,
    reset: deps.reset!,
    agentFiles: deps.agentFiles,
  }
}

describe('draft_world', () => {
  test('records genre and theme and writes a placeholder lore file', async () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    const text = resultText(
      await callTool(findTool(tools, 'draft_world'), {
        genre: 'dark fantasy',
        theme: 'survival and redemption',
        lore_summary: 'A'.repeat(60),
      }),
    )

    expect(text).toContain('Genre: dark fantasy, Theme: survival and redemption')
    const config = deps.worlds!.loadWorldConfig(WORLD)!
    expect(config.genre).toBe('dark fantasy')
    expect(config.theme).toBe('survival and redemption')
    expect(deps.worlds!.loadLore(WORLD)).toStartWith('# World Lore\n\n')
  })

  test('rejects a lore summary under the 50-character floor', () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    expect(
      callTool(findTool(tools, 'draft_world'), {
        genre: 'g',
        theme: 't',
        lore_summary: 'too short',
      }),
    ).rejects.toThrow()
  })
})

describe('persist_world', () => {
  const statSystem = {
    stats: [
      { name: 'hp', display: 'HP', default: 100 },
      { name: 'morale', display: 'Morale', default: 50 },
    ],
  }

  test('writes stat definitions, seeds the player, and replaces the draft lore', async () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    deps.worlds!.saveLore(WORLD, '# World Lore\n\nA draft.')

    const text = resultText(
      await callTool(findTool(tools, 'persist_world'), {
        lore: 'L'.repeat(150),
        stat_system: statSystem,
      }),
    )

    expect(text).toBe('World persisted successfully. Stats: 2, Lore: 150 characters')
    expect(deps.players.loadStatDefinitions(WORLD).stats).toHaveLength(2)
    expect(deps.players.loadPlayerState(WORLD)!.stats).toEqual({ hp: 100, morale: 50 })
    expect(deps.worlds!.loadLore(WORLD)).not.toContain('A draft.')
  })

  test('initial_stats layer over the declared defaults rather than replacing them', async () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    await callTool(findTool(tools, 'persist_world'), {
      lore: 'L'.repeat(150),
      stat_system: statSystem,
      initial_stats: { hp: 40 },
    })
    expect(deps.players.loadPlayerState(WORLD)!.stats).toEqual({ hp: 40, morale: 50 })
  })

  test('preserves an existing World Notes section across the rewrite', async () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    deps.worlds!.saveLore(WORLD, '# World Lore\n\nA draft.\n\n---\n## World Notes\nKeep me.')

    await callTool(findTool(tools, 'persist_world'), {
      lore: 'L'.repeat(150),
      stat_system: statSystem,
    })

    const lore = deps.worlds!.loadLore(WORLD)
    expect(lore).toContain('Keep me.')
    expect(lore).not.toContain('A draft.')
  })

  test('un-escapes literal \\n in world notes', async () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    await callTool(findTool(tools, 'persist_world'), {
      lore: 'L'.repeat(150),
      stat_system: statSystem,
      world_notes: 'one\\ntwo',
    })
    expect(deps.worlds!.loadLore(WORLD)).toContain('one\ntwo')
  })

  test('rejects lore under the 100-character floor', () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    expect(
      callTool(findTool(tools, 'persist_world'), { lore: 'short', stat_system: statSystem }),
    ).rejects.toThrow()
  })
})

describe('complete', () => {
  function seedLocation(name = 'town_square'): void {
    deps.locations.createLocation(WORLD, name, 'Town Square', 'Cobbles.', [0, 0])
    createLocation(db, WORLD_ID, { name, displayName: 'Town Square' })
  }

  test('sets the pending phase, the clock and the initial-state snapshot', async () => {
    seedLocation()
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())

    const text = resultText(
      await callTool(findTool(tools, 'complete'), {
        player_name: '손님',
        starting_location: 'town_square',
        starting_hour: 14,
      }),
    )

    expect(text).toContain('Player: 손님')
    expect(text).toContain('Starting time: 14:00')

    const config = deps.worlds!.loadWorldConfig(WORLD)!
    expect(config.userName).toBe('손님')
    // *Pending*, not applied: the turn in flight must not see the world change.
    expect(config.pendingPhase).toBe('active')
    expect(config.phase).toBe('onboarding')

    const state = deps.players.loadPlayerState(WORLD)!
    expect(state.currentLocation).toBe('town_square')
    expect(state.gameTime).toEqual({ hour: 14, minute: 0, day: 1 })

    const snapshot = deps.reset!.loadInitialState(WORLD)!
    expect(snapshot.starting_location).toBe('town_square')
    expect(snapshot.initial_game_time).toEqual({ hour: 14, minute: 0, day: 1 })
  })

  test('refuses a location the filesystem index does not know', async () => {
    seedLocation()
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())

    const result = await callTool(findTool(tools, 'complete'), {
      player_name: 'P',
      // The display name, which is exactly the plausible-looking mistake the
      // folder-name check exists to catch.
      starting_location: 'Town Square',
    })

    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain('Available locations: town_square')
    expect(deps.worlds!.loadWorldConfig(WORLD)!.pendingPhase).toBeNull()
  })

  test('places the NPCs onboarding created at the starting location', async () => {
    seedLocation()
    deps.agentFiles!.createAgent(WORLD, 'Marn', 'Marn is a miller.', 'Terse.')
    db.insert(agents)
      .values({ id: 5, name: 'Marn', worldName: WORLD, systemPrompt: 'p' })
      .run()

    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    await callTool(findTool(tools, 'complete'), {
      player_name: 'P',
      starting_location: 'town_square',
    })

    const location = getLocations(db, WORLD_ID)[0]!
    expect(getCharactersAtLocation(db, location.id).map((a) => a.name)).toContain('Marn')
  })

  test('rejects a starting hour outside 0-23 at the schema', () => {
    const tools = createOnboardingTools(ctxFor(), onboardingDeps())
    expect(
      callTool(findTool(tools, 'complete'), {
        player_name: 'P',
        starting_location: 'x',
        starting_hour: 24,
      }),
    ).rejects.toThrow()
  })
})

// ============================================================================
// subagent persist callbacks
// ============================================================================

describe('persist_character_design', () => {
  function tools() {
    return createPersistCharacterTool(ctxFor({ agentName: 'Character_Designer' }), {
      agentFiles: deps.agentFiles!,
      players: deps.players,
      rooms: deps.rooms,
      locations: deps.locations,
      agentFactory: deps.agentFactory,
    })
  }

  const args = {
    name: 'Old Marn',
    role: 'miller',
    appearance: 'Stooped, flour-dusted.',
    personality: 'Suspicious of strangers.',
    secret: 'He owes the reeve money.',
  }

  test('writes the two agent files and a database row', async () => {
    const text = resultText(await callTool(findTool(tools(), 'persist_character_design'), args))

    expect(text).toContain('- Name: Old Marn')
    expect(text).toContain('- Location: current location')

    const folder = join(worldPath(), 'agents', 'Old_Marn')
    // The nutshell stays a single sentence: it is injected into *every* other
    // character's context, so appearance belongs in characteristics only.
    expect(readFileSync(join(folder, 'in_a_nutshell.md'), 'utf-8')).toBe(
      'Old Marn is a miller.',
    )
    const characteristics = readFileSync(join(folder, 'characteristics.md'), 'utf-8')
    expect(characteristics).toContain('## Appearance\nStooped, flour-dusted.')
    expect(characteristics).toContain('## Hidden Detail\nHe owes the reeve money.')

    expect(getAgentByName(db, 'Old_Marn')).not.toBeNull()
  })

  test('does not put the character in the onboarding room', async () => {
    await callTool(findTool(tools(), 'persist_character_design'), args)
    // The onboarding room is an interview, not a place; `complete` seats them
    // at the starting location instead.
    const agent = getAgentByName(db, 'Old_Marn')!
    const memberships = db.select().from(agents).where(undefined).all()
    expect(memberships.some((a) => a.id === agent.id)).toBe(true)
    expect(
      db
        .select()
        .from(roomsTable)
        .all()
        .map((r) => r.id),
    ).toEqual([ONBOARDING_ROOM_ID])
  })

  test('places the character at a named location when one is given', async () => {
    deps.locations.createLocation(WORLD, 'old_mill', 'Old Mill', 'Creaking.', [1, 0])
    const location = createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })

    const text = resultText(
      await callTool(findTool(tools(), 'persist_character_design'), {
        ...args,
        which_location: 'old_mill',
      }),
    )

    expect(text).toContain('- Location: Old Mill')
    expect(deps.rooms.getRoomMapping(WORLD, 'location:old_mill')?.agents).toEqual(['Old_Marn'])
    expect(getCharactersAtLocation(db, location.id).map((a) => a.name)).toContain('Old_Marn')
  })

  test('is not offered without an agent factory to write the row', () => {
    expect(
      createPersistCharacterTool(ctxFor(), {
        agentFiles: deps.agentFiles!,
        players: deps.players,
        rooms: deps.rooms,
        locations: deps.locations,
      }),
    ).toEqual([])
  })
})

describe('persist_location_design', () => {
  function tools() {
    return createPersistLocationTool(ctxFor({ agentName: 'Location_Designer' }), {
      players: deps.players,
      rooms: deps.rooms,
      locations: deps.locations,
      worlds: deps.worlds!,
      persistence: deps.persistence,
    })
  }

  test('creates the location on both sides and links declared neighbours', async () => {
    deps.locations.createLocation(WORLD, 'town_square', 'Town Square', 'Cobbles.', [0, 0])
    const square = createLocation(db, WORLD_ID, { name: 'town_square' })

    const text = resultText(
      await callTool(findTool(tools(), 'persist_location_design'), {
        name: 'old_mill',
        display_name: 'Old Mill',
        description: 'A creaking wheel over dark water.',
        position_x: 1,
        position_y: 2,
        adjacent_to: 'town_square',
      }),
    )

    expect(text).toContain('- Position: (1, 2)')
    expect(text).toContain('- Is Starting: False')
    expect(existsSync(join(worldPath(), 'locations', 'old_mill'))).toBe(true)

    const created = getLocations(db, WORLD_ID).find((l) => l.name === 'old_mill')!
    // Bidirectional: a one-way link would make the map asymmetric.
    expect(JSON.parse(created.adjacentLocations ?? '[]')).toContain(square.id)
    const back = getLocations(db, WORLD_ID).find((l) => l.name === 'town_square')!
    expect(JSON.parse(back.adjacentLocations ?? '[]')).toContain(created.id)
  })

  test('refuses to overwrite an existing name', async () => {
    createLocation(db, WORLD_ID, { name: 'old_mill', displayName: 'Old Mill' })
    const result = await callTool(findTool(tools(), 'persist_location_design'), {
      name: 'old_mill',
      display_name: 'A Different Mill',
      description: 'x',
    })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toBe("Location 'old_mill' already exists. Cannot overwrite.")
  })

  test('matches an existing display name too', async () => {
    createLocation(db, WORLD_ID, { name: 'mill_01', displayName: 'Old Mill' })
    const result = await callTool(findTool(tools(), 'persist_location_design'), {
      name: 'Old Mill',
      display_name: 'Old Mill',
      description: 'x',
    })
    expect(isError(result)).toBe(true)
  })

  test('is not offered without a persistence factory', () => {
    expect(
      createPersistLocationTool(ctxFor(), {
        players: deps.players,
        rooms: deps.rooms,
        locations: deps.locations,
        worlds: deps.worlds!,
      }),
    ).toEqual([])
  })
})

// ============================================================================
// character-design-tools
// ============================================================================

describe('create_comprehensive_character', () => {
  function tools() {
    return createCharacterDesignTools(ctxFor({ agentName: 'detailed_character_designer' }), {
      agentFiles: deps.agentFiles!,
      agentFactory: deps.agentFactory!,
      players: deps.players,
      rooms: deps.rooms,
      worlds: deps.worlds!,
    })
  }

  const args = {
    name: 'Old Marn',
    role: 'miller',
    appearance: 'A'.repeat(60),
    personality: 'P'.repeat(120),
    backstory: 'B'.repeat(250),
  }

  test('writes a backstory section and reports the field lengths', async () => {
    const text = resultText(
      await callTool(findTool(tools(), 'create_comprehensive_character'), args),
    )

    expect(text).toContain('- Appearance: 60 chars')
    expect(text).toContain('- Backstory: 250 chars')
    expect(text).toContain('- Secret: None')
    expect(
      readFileSync(join(worldPath(), 'agents', 'Old_Marn', 'characteristics.md'), 'utf-8'),
    ).toContain('## Backstory')
  })

  test('prompts for the memory implant when initial memories were declared', async () => {
    const text = resultText(
      await callTool(findTool(tools(), 'create_comprehensive_character'), {
        ...args,
        initial_memories: [{ subtitle: 'the_fire', content: 'C'.repeat(20) }],
      }),
    )
    expect(text).toContain('Call `implant_consolidated_memory` next to add 1 initial memories.')
  })

  test('enforces the length floors that separate it from persist_character_design', () => {
    expect(
      callTool(findTool(tools(), 'create_comprehensive_character'), {
        ...args,
        backstory: 'too short',
      }),
    ).rejects.toThrow()
  })
})

describe('implant_consolidated_memory', () => {
  function tools() {
    return createCharacterDesignTools(ctxFor({ agentName: 'detailed_character_designer' }), {
      agentFiles: deps.agentFiles!,
      agentFactory: deps.agentFactory!,
      players: deps.players,
      rooms: deps.rooms,
      worlds: deps.worlds!,
    })
  }

  function memoryFile(): string {
    return readFileSync(
      join(worldPath(), 'agents', 'Old_Marn', 'consolidated_memory.md'),
      'utf-8',
    )
  }

  beforeEach(() => {
    deps.agentFiles!.createAgent(WORLD, 'Old_Marn', 'Old Marn is a miller.', 'Terse.')
  })

  test('writes `## [subtitle]` headings, which is what recall keys off', async () => {
    const text = resultText(
      await callTool(findTool(tools(), 'implant_consolidated_memory'), {
        character_name: 'Old Marn',
        memories: [
          { subtitle: 'the_fire', content: 'The granary burned.' },
          { subtitle: 'the_pact', content: 'They shook hands at dusk.' },
        ],
      }),
    )

    expect(text).toContain('**Memories added:** 2')
    expect(text).toContain('1. [the_fire]')
    expect(memoryFile()).toBe(
      '## [the_fire]\nThe granary burned.\n\n## [the_pact]\nThey shook hands at dusk.',
    )
  })

  test('append keeps what is already there and counts the total', async () => {
    const built = tools()
    await callTool(findTool(built, 'implant_consolidated_memory'), {
      character_name: 'Old_Marn',
      memories: [{ subtitle: 'the_fire', content: 'The granary burned.' }],
    })
    const text = resultText(
      await callTool(findTool(built, 'implant_consolidated_memory'), {
        character_name: 'Old_Marn',
        memories: [{ subtitle: 'the_pact', content: 'They shook hands.' }],
      }),
    )

    expect(text).toContain('**Total memories in file:** 2')
    expect(memoryFile()).toContain('the_fire')
    expect(memoryFile()).toContain('the_pact')
  })

  test('overwrite replaces everything', async () => {
    const built = tools()
    await callTool(findTool(built, 'implant_consolidated_memory'), {
      character_name: 'Old_Marn',
      memories: [{ subtitle: 'the_fire', content: 'The granary burned.' }],
    })
    await callTool(findTool(built, 'implant_consolidated_memory'), {
      character_name: 'Old_Marn',
      memories: [{ subtitle: 'the_pact', content: 'They shook hands.' }],
      mode: 'overwrite',
    })

    expect(memoryFile()).not.toContain('the_fire')
  })

  test('refuses a character that has no folder yet', async () => {
    const result = await callTool(findTool(tools(), 'implant_consolidated_memory'), {
      character_name: 'Ghost',
      memories: [{ subtitle: 's', content: 'C'.repeat(20) }],
    })
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain('Create the character first')
  })

  test('rejects an unknown mode at the schema', () => {
    expect(
      callTool(findTool(tools(), 'implant_consolidated_memory'), {
        character_name: 'Old_Marn',
        memories: [{ subtitle: 's', content: 'C'.repeat(20) }],
        mode: 'merge',
      }),
    ).rejects.toThrow()
  })
})

// ============================================================================
// buildServers
// ============================================================================

describe('buildServers', () => {
  /**
   * The shape `buildServers` used to return, reassembled from the two halves it
   * was split into. Kept so these assertions still describe what an agent is
   * *offered*, which is the contract the split was designed not to change --
   * `turn.ts` and `sdk/mcp/endpoint.ts` derive from the same two calls.
   */
  function buildServers(ctx: ToolContext, serverDeps: ServerDeps, options: BuildServersOptions) {
    const sets = buildToolSets(createTurnBinding(ctx, serverDeps, options), serverDeps)
    return { mcpServers: sets, toolNames: qualifiedToolNames(sets) }
  }

  function servers(role: BuildServersOptions['role'], ctx = ctxFor()) {
    return buildServers(ctx, deps, { role, configDir: join(root, 'agents', 'Marn') })
  }

  test('gives every role the guidelines server', () => {
    for (const role of ['action_manager', 'character', 'onboarding', 'subagent'] as const) {
      expect(Object.keys(servers(role).mcpServers)).toContain(SERVER_NAMES.guidelines)
    }
  })

  test('action_manager gets the gameplay and subagent servers, not the action one', () => {
    const built = servers('action_manager')
    expect(Object.keys(built.mcpServers).sort()).toEqual(
      [SERVER_NAMES.actionManager, SERVER_NAMES.guidelines, SERVER_NAMES.subagents].sort(),
    )
    // An agent that narrates the scene has no recent_events.md of its own.
    expect(built.toolNames).not.toContain('mcp__action__memorize')

    for (const name of [
      'mcp__action_manager__narration',
      'mcp__action_manager__suggest_options',
      'mcp__action_manager__travel',
      'mcp__action_manager__change_stat',
      'mcp__action_manager__advance_time',
      'mcp__action_manager__inject_memory',
      'mcp__action_manager__remove_character',
      'mcp__action_manager__delete_character',
      'mcp__action_manager__move_character',
      'mcp__action_manager__list_inventory',
      'mcp__action_manager__list_world_item',
      'mcp__action_manager__list_locations',
      'mcp__action_manager__list_characters',
      'mcp__action_manager__roll_the_dice',
      'mcp__subagents__persist_item',
      'mcp__subagents__persist_character_design',
      'mcp__subagents__persist_location_design',
    ]) {
      expect(built.toolNames).toContain(name)
    }
  })

  test('the tools Python declares but never implements are not offered', () => {
    const built = servers('action_manager')
    for (const name of ['equip_item', 'unequip_item', 'use_item', 'list_equipment', 'set_flag']) {
      expect(built.toolNames).not.toContain(`mcp__action_manager__${name}`)
    }
  })

  test('character gets the action server only', () => {
    const ctx = ctxFor({
      agentName: 'Marn',
      configFile: `worlds/${WORLD}/agents/Marn`,
      longTermMemoryIndex: { the_fire: 'The granary burned.' },
    })
    const built = servers('character', ctx)
    expect(Object.keys(built.mcpServers).sort()).toEqual(
      [SERVER_NAMES.action, SERVER_NAMES.guidelines].sort(),
    )
    expect(built.toolNames).toContain('mcp__action__skip')
    expect(built.toolNames).toContain('mcp__action__recall')
  })

  test('a character with no memories is not offered recall', () => {
    const built = servers('character', ctxFor({ agentName: 'Marn' }))
    expect(built.toolNames).not.toContain('mcp__action__recall')
  })

  test('a character with no config directory is refused outright', () => {
    expect(() => buildServers(ctxFor({ agentName: 'Marn' }), deps, { role: 'character' })).toThrow(
      'no config directory',
    )
  })

  test('onboarding gets the onboarding and subagent servers', () => {
    const built = servers('onboarding')
    expect(Object.keys(built.mcpServers).sort()).toEqual(
      [SERVER_NAMES.guidelines, SERVER_NAMES.onboarding, SERVER_NAMES.subagents].sort(),
    )
    for (const name of [
      'mcp__onboarding__draft_world',
      'mcp__onboarding__persist_world',
      'mcp__onboarding__complete',
      'mcp__onboarding__read_lore_guidelines',
    ]) {
      expect(built.toolNames).toContain(name)
    }
  })

  test('subagent gets only the persist callbacks', () => {
    const built = servers('subagent')
    expect(Object.keys(built.mcpServers).sort()).toEqual(
      [SERVER_NAMES.guidelines, SERVER_NAMES.subagents].sort(),
    )
    expect(built.toolNames).toContain('mcp__subagents__persist_item')
    expect(built.toolNames).not.toContain('mcp__action_manager__narration')
  })

  test('character_design gets the two deep-creation tools', () => {
    const built = servers('character_design')
    expect(built.toolNames).toContain(
      'mcp__character_design__create_comprehensive_character',
    )
    expect(built.toolNames).toContain('mcp__character_design__implant_consolidated_memory')
  })

  test('tools whose services are missing are simply not offered', () => {
    const bare = buildServers(ctxFor(), { players: deps.players, rooms: deps.rooms, locations: deps.locations }, {
      role: 'action_manager',
    })
    // No world service, no item service, no agent filesystem.
    expect(bare.toolNames).not.toContain('mcp__action_manager__travel')
    expect(bare.toolNames).not.toContain('mcp__action_manager__change_stat')
    expect(bare.toolNames).not.toContain('mcp__action_manager__remove_character')
    // What survives is what Phase 0's slice already covered.
    expect(bare.toolNames).toContain('mcp__action_manager__narration')
  })

  test("a group's disabled_tools are dropped from the allow-list", () => {
    // `agents/group_gameplay/group_config.yaml` disables memorize, recall and
    // skip for every agent in the group.
    const ctx = ctxFor({
      agentName: 'Marn',
      groupName: 'group_gameplay',
      configFile: `worlds/${WORLD}/agents/Marn`,
      longTermMemoryIndex: { the_fire: 'x' },
    })
    const built = servers('character', ctx)
    expect(built.toolNames).not.toContain('mcp__action__skip')
    expect(built.toolNames).not.toContain('mcp__action__memorize')
    expect(built.toolNames).not.toContain('mcp__action__recall')
  })
})
