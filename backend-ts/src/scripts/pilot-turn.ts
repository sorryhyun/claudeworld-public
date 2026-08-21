/**
 * Phase 0 exit criteria.
 *
 * Drives one complete gameplay turn — NPC reactions, then the Action Manager
 * interpreting the action and narrating — against a seeded SQLite database, with
 * no HTTP server anywhere. Passing means the SDK layer, the tool layer, the tape
 * and the persistence layer all work together.
 *
 * Prerequisite: bun src/scripts/seed-pilot.ts <scratch> <source-db>
 * Usage:        bun src/scripts/pilot-turn.ts <scratch>/pilot-manifest.json
 */
import { desc, eq } from 'drizzle-orm'
import { getWorldByName } from '../crud/worlds'
import { createMessage } from '../crud/messages'
import { addActionToHistory, incrementTurn } from '../crud/player-state'
import { openDb, schema } from '../db'
import { createTurnTelemetry } from '../infrastructure/logging/turn-telemetry'
import { runGameplayTurn } from '../orchestration/turn'
import { SessionPool } from '../sdk/client/session-pool'
import { LocationStorage } from '../services/location-storage'
import { PlayerService } from '../services/player-service'
import { RoomMappingService } from '../services/room-mapping'
import { MtimeCache, WorldService } from '../services/world-service'
import type { TurnEvent } from '../sdk/agent/turn-runner'

interface Manifest {
  root: string
  dbPath: string
  worldName: string
  /** Absent in manifests written before the owner was published; see below. */
  ownerId?: string
  roomId: number
  npcs: Array<{ name: string; id: number }>
}

const manifestPath = process.argv[2]
if (!manifestPath) {
  console.error('usage: bun src/scripts/pilot-turn.ts <pilot-manifest.json>')
  process.exit(2)
}
const manifest = (await Bun.file(manifestPath).json()) as Manifest

// Set before anything resolves paths: the pilot must read the seeded world, not
// the developer's own.
process.env.CLAUDEWORLD_ROOT = manifest.root

const PLAYER_ACTION =
  'I shake the rain off my coat and ask whether anyone here has seen the Fennick caravan.'

const db = openDb({ path: manifest.dbPath })
// `ownerId` is required now that `getWorldByName` no longer scans across owners.
// The fallback keeps manifests seeded before that change usable — `seed-pilot`
// has always stamped every row `admin` (seed-pilot.ts:112).
const world = getWorldByName(db, manifest.worldName, manifest.ownerId ?? 'admin')
if (!world) {
  console.error(`World "${manifest.worldName}" is missing from ${manifest.dbPath}`)
  process.exit(1)
}

const worldsDir = `${manifest.root}/worlds`
const cache = new MtimeCache()
const services = {
  worlds: new WorldService(worldsDir, cache),
  players: new PlayerService(worldsDir, cache),
  locations: new LocationStorage(worldsDir, cache),
  rooms: new RoomMappingService(worldsDir),
}

// The player's action is persisted before any agent runs. NPCs are not handed it
// directly — they read it back out of the room, which is what makes their view
// of the scene the same as any other observer's.
const turn = incrementTurn(db, world.id)
addActionToHistory(db, world.id, { turn, action: PLAYER_ACTION, result: '' })
createMessage(db, manifest.roomId, {
  content: PLAYER_ACTION,
  role: 'user',
  participantType: 'user',
  participantName: world.userName,
})

const pool = new SessionPool()
let narrationDeltaChars = 0
let narrationProduced = false
const toolsUsed = new Set<string>()
const perAgent = new Map<string, { content: number; thinking: number }>()

console.log(`\n> ${PLAYER_ACTION}\n`)
const startedAt = Date.now()

// The real logging sinks, so the pilot exercises them too. Both are no-ops
// unless PERF_LOG / debug.yaml turn them on, which is why they can sit in the
// hot path unconditionally.
const telemetry = createTurnTelemetry({ roomId: manifest.roomId })

const onEvent = (agent: { name: string }, event: TurnEvent): void => {
  telemetry.onEvent(agent, event)

  const tally = perAgent.get(agent.name) ?? { content: 0, thinking: 0 }
  if (event.type === 'content_delta') tally.content += event.delta.length
  if (event.type === 'thinking_delta') tally.thinking += event.delta.length
  if (event.type === 'narration_delta') narrationDeltaChars += event.delta.length
  perAgent.set(agent.name, tally)

  if (event.type === 'stream_end') {
    const bits = [
      `${event.responseText?.length ?? 0} chars`,
      `thinking ${tally.thinking}`,
      event.skipped ? 'SKIPPED' : '',
      event.interrupted ? 'INTERRUPTED' : '',
      event.error ? `ERROR ${event.error}` : '',
    ].filter(Boolean)
    console.log(`  [${agent.name}] ${bits.join(', ')}`)
  }
}

const result = await runGameplayTurn(
    {
      db,
      pool,
      services,
      projectRoot: manifest.root,
      serverDeps: {
        players: services.players,
        rooms: services.rooms,
        locations: services.locations,
        onNarrationProduced: () => {
          narrationProduced = true
        },
      },
      onEvent,
      onTelemetry: (t) => {
        telemetry.onTelemetry(t)
        if (t.kind === 'tool_used') toolsUsed.add(t.toolName)
        if (t.kind === 'subagent_completed') {
          console.log(`  [subagent] ${t.subagentType} ${t.durationMs}ms`)
        }
      },
    },
  { world, roomId: manifest.roomId, action: PLAYER_ACTION },
)

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

// --- Verify against the database, not the return value ---------------------
// A hidden turn reports responses it never persisted, so the only honest check
// is what actually landed in `messages`.

const narration = db
  .select()
  .from(schema.messages)
  .where(eq(schema.messages.roomId, manifest.roomId))
  .orderBy(desc(schema.messages.id))
  .limit(1)
  .get()

const suggestions = services.rooms.loadSuggestions(manifest.worldName)

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

console.log(`\n--- turn completed in ${elapsed}s ---`)
console.log(
  `cells=${result.cellsExecuted} responses=${result.totalResponses} ` +
    `reactions=${result.reactions.length} interrupted=${result.wasInterrupted}`,
)

console.log('\n--- checks ---')
check(result.cellsExecuted === 2, `both tape cells ran (got ${result.cellsExecuted})`)
check(
  result.reactions.length === manifest.npcs.length,
  `every NPC reacted (${result.reactions.length}/${manifest.npcs.length})`,
)
check(narrationProduced, 'narration tool fired')
check(
  narration?.role === 'assistant' && (narration.content?.length ?? 0) > 0,
  `narration persisted as a message (${narration?.content?.length ?? 0} chars)`,
)
check(narrationDeltaChars > 0, `narration streamed incrementally (${narrationDeltaChars} chars)`)
check(
  narration?.thinking?.includes('[NPC_REACTIONS]') === true,
  'NPC reactions stored on the narration message',
)
check(suggestions.length === 2, `two follow-up options suggested (${suggestions.length})`)

const sessions = db
  .select()
  .from(schema.roomAgentSessions)
  .where(eq(schema.roomAgentSessions.roomId, manifest.roomId))
  .all()
check(
  sessions.length === manifest.npcs.length + 1,
  `session ids persisted for every agent (${sessions.length}/${manifest.npcs.length + 1})`,
)

check(
  toolsUsed.has('mcp__action_manager__narration'),
  `narration tool observed by the PreToolUse hook (saw: ${[...toolsUsed].join(', ')})`,
)
check(
  toolsUsed.has('mcp__action__recall'),
  'a character called recall to read its long-term memory',
)

// --- Turn two: does the pool actually reuse the warm sessions? -------------
// This is the whole reason the pool exists, and the one property a single turn
// cannot demonstrate. Session ids must be unchanged and no session reopened.

const sessionsBefore = new Map(sessions.map((s) => [s.agentId, s.sessionId]))
const poolKeysBefore = pool.keys.slice().sort()

const SECOND_ACTION = 'I ask Bram what the toll house took from him.'
const turn2 = incrementTurn(db, world.id)
addActionToHistory(db, world.id, { turn: turn2, action: SECOND_ACTION, result: '' })
createMessage(db, manifest.roomId, {
  content: SECOND_ACTION,
  role: 'user',
  participantType: 'user',
  participantName: world.userName,
})

console.log(`\n> ${SECOND_ACTION}\n`)
const result2 = await runGameplayTurn(
  {
    db,
    pool,
    services,
    projectRoot: manifest.root,
    serverDeps: {
      players: services.players,
      rooms: services.rooms,
      locations: services.locations,
    },
    onEvent,
  },
  { world, roomId: manifest.roomId, action: SECOND_ACTION },
)

const sessionsAfter = db
  .select()
  .from(schema.roomAgentSessions)
  .where(eq(schema.roomAgentSessions.roomId, manifest.roomId))
  .all()

console.log('\n--- turn two checks ---')
check(result2.cellsExecuted === 2, `second turn ran both cells (got ${result2.cellsExecuted})`)
check(
  sessionsAfter.every((s) => sessionsBefore.get(s.agentId) === s.sessionId),
  'session ids unchanged across turns (conversations continued, not forked)',
)
check(
  JSON.stringify(pool.keys.slice().sort()) === JSON.stringify(poolKeysBefore),
  `pool reused the same warm sessions (${pool.size} sessions, no reopen)`,
)

const narration2 = db
  .select()
  .from(schema.messages)
  .where(eq(schema.messages.roomId, manifest.roomId))
  .orderBy(desc(schema.messages.id))
  .limit(1)
  .get()
check(
  (narration2?.id ?? 0) > (narration?.id ?? 0),
  'second turn persisted its own narration',
)

// --- Show the turn ---------------------------------------------------------

console.log('\n--- NPC reactions (hidden from the player) ---')
for (const reaction of result.reactions) {
  console.log(`\n### ${reaction.agentName}\n${reaction.content.trim()}`)
}

console.log('\n--- narration, turn 1 (what the player sees) ---\n')
console.log(narration?.content?.trim() ?? '(none)')
console.log('\n--- narration, turn 2 ---\n')
console.log(narration2?.content?.trim() ?? '(none)')
if (suggestions.length) console.log(`\nOptions: ${suggestions.map((s, i) => `${i + 1}. ${s}`).join('  ')}`)

await pool.shutdown()

console.log(failures === 0 ? '\nPHASE 0 PASS' : `\nPHASE 0 FAIL (${failures} checks failed)`)
process.exit(failures === 0 ? 0 : 1)
