/**
 * Build a self-contained gameplay world for the Phase 0 pilot.
 *
 * The repository's own `claudeworld.db` holds an onboarding-phase world with no
 * locations and no NPCs, so it cannot exercise the gameplay tape. Rather than
 * advance that world (which would mutate the developer's data), this seeds a
 * throwaway root: `agents/` and `backend/` are symlinked to the real repo so
 * agent configs and the YAML guidelines resolve exactly as in production, while
 * the world data and the database are fresh copies under a scratch directory.
 *
 * Usage: bun src/scripts/seed-pilot.ts <scratch-dir> <source-db>
 */
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync, symlinkSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as toYaml } from 'yaml'
import { openDb } from '../db'
import { formatSqlaDateTime } from '../db/columns'
import { resolveProjectRoot } from '../config/paths'

const scratchDir = process.argv[2]
const sourceDb = process.argv[3]
if (!scratchDir || !sourceDb) {
  console.error('usage: bun src/scripts/seed-pilot.ts <scratch-dir> <source-db>')
  process.exit(2)
}

export const PILOT_WORLD = 'pilot_phase0'
/** The `owner_id` every row the seeder writes is stamped with. */
export const PILOT_OWNER = 'admin'
export const PILOT_LOCATION = 'old_mill'

const repoRoot = resolveProjectRoot({})
const root = join(scratchDir, 'pilot-root')
const dbPath = join(root, 'claudeworld.db')

// A fresh root each run: a half-seeded world from a failed run is worse than no
// world, because the failure surfaces later as a confusing agent response.
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

// Symlinked, not copied. These are read-only inputs and the pilot must exercise
// the same agent definitions and guidelines the real backend uses — a stale copy
// would make the pilot pass against files nobody ships.
symlinkSync(join(repoRoot, 'agents'), join(root, 'agents'))
symlinkSync(join(repoRoot, 'backend'), join(root, 'backend'))

copyFileSync(sourceDb, dbPath)

const worldDir = join(root, 'worlds', PILOT_WORLD)
const locDir = join(worldDir, 'locations', PILOT_LOCATION)
mkdirSync(locDir, { recursive: true })
mkdirSync(join(worldDir, 'agents'), { recursive: true })
mkdirSync(join(worldDir, 'items'), { recursive: true })

const NOW_ISO = new Date().toISOString()

interface Npc {
  name: string
  nutshell: string
  characteristics: string
  recentEvents: string
  memory?: Record<string, string>
}

const NPCS: Npc[] = [
  {
    name: 'Bram',
    nutshell:
      'Bram is the miller of the old mill on the Vare road, a broad-shouldered man in his fifties ' +
      'who has ground grain for three villages his whole life and knows every traveller who passes.',
    characteristics:
      'Bram is slow to speak and slower to trust, but generous once he decides someone is honest. ' +
      'He talks while working and rarely stops working. He resents the toll collectors on the Vare ' +
      'road and will complain about them given the smallest opening. He notices hands — calluses, ' +
      'scars, rings — before faces.',
    recentEvents:
      '- The upper millstone cracked four days ago and he has been grinding at half speed since.\n' +
      '- A caravan that should have arrived on market day never came.\n',
    memory: {
      the_caravan:
        'The Fennick caravan has come through every month for eleven years. Old Fennick always ' +
        'overpaid for the milling and waved off the change. This month they did not come, and Bram ' +
        'has told himself three different comfortable stories about why. He does not believe any of them.',
      the_toll:
        'Two winters ago the toll collectors took his cart in lieu of payment and returned it with a ' +
        'split axle. He said nothing at the time. He has thought about it most days since.',
    },
  },
  {
    name: 'Sable',
    nutshell:
      'Sable is a traveller sheltering at the mill, lean and watchful, with a road-worn coat and no ' +
      'account of where she came from that stays the same twice.',
    characteristics:
      'Sable answers questions with questions and stands where she can see the door. She is dryly ' +
      'funny when she relaxes, which is seldom. She lies fluently about her past and truthfully ' +
      'about the present. She will help a stranger before she will trust one.',
    recentEvents:
      '- Arrived at the mill two nights ago on foot, in the rain, with no pack.\n' +
      '- Has not slept more than a few hours at a stretch since.\n',
  },
]

// --- Filesystem ------------------------------------------------------------

await Bun.write(
  join(worldDir, 'world.yaml'),
  toYaml({
    created_at: NOW_ISO,
    genre: 'low fantasy',
    language: 'en',
    name: PILOT_WORLD,
    owner_id: 'admin',
    // The gameplay tape only runs for a world past onboarding.
    phase: 'active',
    settings: { allow_death: true, difficulty: 'normal', narrator_style: 'atmospheric' },
    theme: 'a road, a mill, and a caravan that never arrived',
    updated_at: NOW_ISO,
    user_name: 'Riona',
  }),
)

await Bun.write(
  join(worldDir, 'player.yaml'),
  toYaml({
    current_location: PILOT_LOCATION,
    effects: [],
    game_time: { day: 1, hour: 17, minute: 40 },
    inventory: [],
    recent_actions: [],
    stats: { health: 10, stamina: 8, coin: 3 },
    turn_count: 0,
  }),
)

await Bun.write(
  join(worldDir, 'lore.md'),
  `# The Vare Road

The Vare road runs north from the salt flats to the timber country, and everything on it
survives on what passes through. Tolls are collected at three bridges by men who answer to
nobody the villages can name. Caravans keep to a schedule because a caravan that is late is
usually a caravan that is gone.

The old mill sits where the road crosses the Vare itself, close enough to the water that the
whole building hums when the wheel turns. It is the last shelter for a day's walk in either
direction, so travellers stop whether or not they have business there.
`,
)

await Bun.write(
  join(worldDir, 'history.md'),
  '# History\n\nThe story has not yet begun.\n',
)

await Bun.write(
  join(worldDir, '_state.json'),
  JSON.stringify(
    {
      suggestions: [],
      last_updated: new Date().toISOString(),
      rooms: {},
      current_room: PILOT_LOCATION,
      ui: {},
    },
    null,
    2,
  ),
)

await Bun.write(
  join(worldDir, 'locations', '_index.yaml'),
  toYaml({
    locations: {
      [PILOT_LOCATION]: {
        name: 'The Old Mill',
        label: null,
        position: [0, 0],
        adjacent: [],
        is_discovered: true,
        is_draft: false,
      },
    },
  }),
)

await Bun.write(
  join(locDir, 'description.md'),
  `# The Old Mill

The mill's ground floor is one long room, floured to the ankles and warm from the ovens next
door. The wheel turns outside with a sound like slow breathing. Sacks are stacked four high
along the north wall, and a cracked upper millstone leans where someone rolled it out of the
way and then gave up on it.

Rain has been coming and going all afternoon. The door to the road stands half open.
`,
)

for (const npc of NPCS) {
  const dir = join(worldDir, 'agents', npc.name)
  mkdirSync(dir, { recursive: true })
  // Third person, per the project's agent-config contract: the SDK prepends an
  // immutable "You are Claude Code" prompt, and a second-person character sheet
  // would contradict it.
  await Bun.write(join(dir, 'in_a_nutshell.md'), `${npc.nutshell}\n`)
  await Bun.write(join(dir, 'characteristics.md'), `${npc.characteristics}\n`)
  await Bun.write(join(dir, 'recent_events.md'), npc.recentEvents)
  if (npc.memory) {
    const body = Object.entries(npc.memory)
      .map(([subtitle, content]) => `## [${subtitle}]\n\n${content}\n`)
      .join('\n')
    await Bun.write(join(dir, 'consolidated_memory.md'), body)
  }
}

// --- Database --------------------------------------------------------------

const db = openDb({ path: dbPath })
const raw = db.$client as Database
const now = formatSqlaDateTime(new Date())

// The copied DB carries the developer's own world. Removing it keeps the pilot's
// assertions unambiguous — "the last message in this room" has one meaning.
raw.exec('DELETE FROM messages')
raw.exec('DELETE FROM room_agents')
raw.exec('DELETE FROM room_agent_sessions')
raw.exec('DELETE FROM player_states')
raw.exec('DELETE FROM locations')
raw.exec('UPDATE worlds SET onboarding_room_id = NULL')
raw.exec('DELETE FROM rooms')
raw.exec('DELETE FROM worlds')
raw.exec("DELETE FROM agents WHERE world_name IS NOT NULL")

const insert = (sql: string, ...params: unknown[]): number => {
  raw.query(sql).run(...(params as never[]))
  return Number(raw.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id)
}

const worldId = insert(
  `INSERT INTO worlds (name, owner_id, user_name, language, phase, genre, theme,
                       stat_definitions, created_at, updated_at, last_played_at)
   VALUES (?, 'admin', 'Riona', 'en', 'active', 'low fantasy', ?, ?, ?, ?, ?)`,
  PILOT_WORLD,
  'a road, a mill, and a caravan that never arrived',
  JSON.stringify({ health: 'Health', stamina: 'Stamina', coin: 'Coin' }),
  now,
  now,
  now,
)

// One room per location: the gameplay code treats "the room" and "the location"
// as the same place, and resolves a turn's room through the player's location.
const roomId = insert(
  `INSERT INTO rooms (owner_id, name, is_paused, is_finished, created_at, last_activity_at, world_id)
   VALUES ('admin', ?, 0, 0, ?, ?, ?)`,
  `The Old Mill`,
  now,
  now,
  worldId,
)

const locationId = insert(
  `INSERT INTO locations (world_id, name, display_name, description, position_x, position_y,
                          adjacent_locations, room_id, is_current, is_discovered, is_draft)
   VALUES (?, ?, 'The Old Mill', ?, 0, 0, '[]', ?, 1, 1, 0)`,
  worldId,
  PILOT_LOCATION,
  "The mill's ground floor is one long room, floured to the ankles and warm from the ovens next door.",
  roomId,
)

insert(
  `INSERT INTO player_states (world_id, current_location_id, turn_count, stats, inventory,
                              effects, action_history, is_chat_mode)
   VALUES (?, ?, 0, ?, '[]', '[]', '[]', 0)`,
  worldId,
  locationId,
  JSON.stringify({ health: 10, stamina: 8, coin: 3 }),
)

const npcIds: number[] = []
for (const npc of NPCS) {
  const configFile = `worlds/${PILOT_WORLD}/agents/${npc.name}`
  // `system_prompt` is a cache of the filesystem-derived prompt. The runtime
  // rebuilds it from `config_file` each turn, so a placeholder is honest here —
  // writing a stale composed prompt would suggest the column is authoritative.
  const id = insert(
    `INSERT INTO agents (name, world_name, "group", config_file, in_a_nutshell, characteristics,
                         recent_events, system_prompt, interrupt_every_turn, priority, transparent, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
    npc.name,
    PILOT_WORLD,
    configFile,
    npc.nutshell,
    npc.characteristics,
    npc.recentEvents,
    npc.nutshell,
    now,
  )
  npcIds.push(id)
  raw.query('INSERT INTO room_agents (room_id, agent_id, joined_at) VALUES (?, ?, ?)').run(roomId, id, now)
}

// The Action Manager runs cell 2. It is a system agent (world_name IS NULL) and
// survived the delete above, but it must be a member of this room to be found.
const actionManagerId = raw
  .query<{ id: number }, []>("SELECT id FROM agents WHERE name = 'Action_Manager' AND world_name IS NULL")
  .get()?.id
if (actionManagerId === undefined) {
  console.error('No Action_Manager row in the source DB; the gameplay tape cannot be built.')
  process.exit(1)
}
raw
  .query('INSERT OR IGNORE INTO room_agents (room_id, agent_id, joined_at) VALUES (?, ?, ?)')
  .run(roomId, actionManagerId, now)

raw.close()

const manifest = {
  root,
  dbPath,
  worldName: PILOT_WORLD,
  ownerId: PILOT_OWNER,
  worldId,
  roomId,
  locationId,
  actionManagerId,
  npcs: NPCS.map((n, i) => ({ name: n.name, id: npcIds[i]! })),
}
await Bun.write(join(scratchDir, 'pilot-manifest.json'), JSON.stringify(manifest, null, 2))

console.log(JSON.stringify(manifest, null, 2))
console.log(`\nSeeded. Run the pilot with CLAUDEWORLD_ROOT=${root}`)
