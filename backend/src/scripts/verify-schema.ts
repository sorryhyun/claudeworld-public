/**
 * Parity check: does the Drizzle mirror actually read a Python-written database?
 *
 * Run against a copy of a real `claudeworld.db`. It reads every table through
 * Drizzle and compares the columns Drizzle believes exist against the ones
 * SQLite reports, which is the cheapest way to catch a transcription slip in
 * src/db/schema.ts before any of it is load-bearing.
 */
import { Database } from 'bun:sqlite'
import { openDb, schema } from '../db'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: bun src/scripts/verify-schema.ts <path-to-db>')
  process.exit(2)
}

const EXPECTED: Record<string, keyof typeof schema> = {
  agents: 'agents',
  rooms: 'rooms',
  worlds: 'worlds',
  locations: 'locations',
  messages: 'messages',
  room_agents: 'roomAgents',
  room_agent_sessions: 'roomAgentSessions',
  player_states: 'playerStates',
  alembic_version: 'alembicVersion',
}

const raw = new Database(dbPath, { readonly: true })
let failures = 0

for (const [table, exportName] of Object.entries(EXPECTED)) {
  const actual = new Set(
    raw
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name),
  )
  // Drizzle keeps the SQL name on each column object; that is what has to match
  // the live DDL, not the camelCase property the TS code uses.
  const table_ = schema[exportName] as unknown as Record<string, unknown>
  const declared = new Set(
    Object.values(table_)
      .filter((c): c is { name: string } => typeof c === 'object' && c !== null && 'name' in c)
      .map((c) => c.name),
  )

  const missing = [...actual].filter((c) => !declared.has(c))
  const extra = [...declared].filter((c) => !actual.has(c))
  if (missing.length || extra.length) {
    failures++
    console.error(`✗ ${table}`)
    if (missing.length) console.error(`    in DB but not in schema.ts: ${missing.join(', ')}`)
    if (extra.length) console.error(`    in schema.ts but not in DB: ${extra.join(', ')}`)
  } else {
    console.log(`✓ ${table} (${actual.size} columns)`)
  }
}
raw.close()

// Reading rows exercises the custom column codecs, which a PRAGMA diff cannot.
const db = openDb({ path: dbPath, readonly: true })
const worlds = await db.select().from(schema.worlds)
const messages = await db.select().from(schema.messages).limit(3)
const agents = await db.select().from(schema.agents)

console.log(`\nRead ${worlds.length} world(s), ${agents.length} agent(s), ${messages.length} message(s).`)
for (const w of worlds) {
  console.log(
    `  world ${w.id} "${w.name}" phase=${w.phase} lang=${w.language} createdAt=${w.createdAt?.toISOString()}`,
  )
  if (!(w.createdAt instanceof Date) || Number.isNaN(w.createdAt.getTime())) {
    console.error('  ✗ createdAt did not decode to a valid Date')
    failures++
  }
}
for (const m of messages) {
  console.log(`  message ${m.id} role=${m.role} ts=${m.timestamp?.toISOString()} agent=${m.agentId}`)
}
for (const a of agents.slice(0, 3)) {
  console.log(
    `  agent ${a.id} "${a.name}" group=${a.group} transparent=${a.transparent} (${typeof a.transparent})`,
  )
  if (a.transparent !== null && typeof a.transparent !== 'boolean') {
    console.error('  ✗ boolean column did not decode to a boolean')
    failures++
  }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
