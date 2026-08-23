/**
 * Drives three complete gameplay turns against a seeded SQLite database, with no
 * HTTP server anywhere. Passing means the SDK, tool, tape and persistence layers
 * all work together.
 *
 * Prerequisite: bun src/scripts/seed-pilot.ts <scratch> <source-db>
 * Usage:        bun src/scripts/pilot-turn.ts <scratch>/pilot-manifest.json
 */
import { desc, eq } from 'drizzle-orm'
import { getWorldByName } from '@/crud/worlds'
import { createMessage } from '@/crud/messages'
import { addActionToHistory, incrementTurn } from '@/crud/player-state'
import { openDb, schema } from '@/db'
import { createTurnTelemetry } from '@/infrastructure/logging/turn-telemetry'
import { runGameplayTurn } from '@/orchestration/turn'
import { SessionPool } from '@/sdk/client/session-pool'
import { McpTools } from '@/sdk/mcp'
import type { ServerDeps } from '@/sdk/handlers/servers'
import { LocationStorage } from '@/services/location-storage'
import { PlayerService } from '@/services/player-service'
import { RoomMappingService } from '@/services/room-mapping'
import { PersistenceManager } from '@/services/persistence-manager'
import { MtimeCache, WorldService } from '@/services/world-service'
import type { TurnEvent } from '@/sdk/agent/turn-runner'
import type { HookTelemetry } from '@/sdk/agent/hooks'

interface Manifest {
  root: string
  dbPath: string
  worldName: string
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
// The fallback keeps older manifests usable — `seed-pilot` stamps every row
// `admin`, and `getWorldByName` no longer scans across owners.
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

// Persisted before any agent runs: NPCs read the action back out of the room
// rather than being handed it, so their view matches any other observer's.
const turn = incrementTurn(db, world.id)
addActionToHistory(db, world.id, { turn, action: PLAYER_ACTION, result: '' })
createMessage(db, manifest.roomId, {
  content: PLAYER_ACTION,
  role: 'user',
  participantType: 'user',
  participantName: world.userName,
})

let narrationDeltaChars = 0
let narrationProduced = false

// Tools are served over the stateless MCP endpoint, so even a driver with no
// HTTP app needs one; `mcp.stop()` at the end closes it.
//
// `worlds` + `persistence` are here for turn three: `buildToolSets` gates
// `persist_location_design` on `ServerDeps.worlds`, and without it the
// `subagents` namespace is empty and `location_designer` is dropped from
// `Options.agents`. The factory must carry `worldsDir`, or the design lands
// next to the developer's own worlds instead of the seeded scratch root.
const serverDeps: ServerDeps = {
  players: services.players,
  rooms: services.rooms,
  locations: services.locations,
  worlds: services.worlds,
  persistence: (db, worldId, worldName) =>
    new PersistenceManager(db, worldId, worldName, worldsDir),
  onNarrationProduced: () => {
    narrationProduced = true
  },
}

const mcp = new McpTools(serverDeps)
const pool = new SessionPool(10, (id) => mcp.release(id))
const toolsUsed = new Set<string>()
const subagentsDispatched = new Set<string>()
const perAgent = new Map<string, { content: number; thinking: number }>()

console.log(`\n> ${PLAYER_ACTION}\n`)
const startedAt = Date.now()

// The real logging sinks, so the pilot exercises them too; no-ops unless
// PERF_LOG / debug.yaml turn them on.
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

// One deps object for every turn. A copy missing `onTelemetry` silently stops
// tool and sub-agent telemetry after turn one.
const turnDeps = {
  db,
  pool,
  services,
  mcp,
  projectRoot: manifest.root,
  serverDeps,
  onEvent,
  onTelemetry: (t: HookTelemetry) => {
    telemetry.onTelemetry(t)
    if (t.kind === 'tool_used') toolsUsed.add(t.toolName)
    if (t.kind === 'subagent_invoked') subagentsDispatched.add(t.subagentType)
    if (t.kind === 'subagent_completed') {
      console.log(`  [subagent] ${t.subagentType} ${t.durationMs}ms`)
    }
  },
}

const result = await runGameplayTurn(turnDeps, {
  world,
  roomId: manifest.roomId,
  action: PLAYER_ACTION,
})

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

// Verify against the database, not the return value: a hidden turn reports
// responses it never persisted.

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

// Turn two: does the pool reuse the warm sessions? The one property a single
// turn cannot demonstrate. Session ids must be unchanged and no session reopened.

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
const result2 = await runGameplayTurn(turnDeps, {
  world,
  roomId: manifest.roomId,
  action: SECOND_ACTION,
})

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

// Turn three: does a sub-agent reach the HTTP MCP endpoint? `bun run spike`
// proves the dispatch, but serves its `subagents` namespace in process;
// production serves it over the stateless endpoint, and the sub-agent's
// `tools/call` arrives there while the parent turn is still open.
//
// The action names the sub-agent and the slug on purpose: depending on the model
// *choosing* to design a location is a coin flip, and the slug must be one no
// earlier turn could have invented. The round-trip is under test, not judgement.
const DESIGNED_LOCATION = 'sunken_ford'
const THIRD_ACTION =
  'I leave the mill and follow the water south, looking for a crossing. ' +
  `[Out of character: dispatch the location_designer sub-agent to design and persist a new ` +
  `location with the exact snake_case name "${DESIGNED_LOCATION}", adjacent to old_mill, ` +
  'then narrate my arrival there.]'

const locationNames = (): string[] =>
  db
    .select()
    .from(schema.locations)
    .where(eq(schema.locations.worldId, world.id))
    .all()
    .map((l) => l.name)

const locationsBefore = locationNames()

// Both sets have been accumulating since turn one; the checks below are about
// turn three only.
subagentsDispatched.clear()
toolsUsed.clear()

const turn3 = incrementTurn(db, world.id)
addActionToHistory(db, world.id, { turn: turn3, action: THIRD_ACTION, result: '' })
createMessage(db, manifest.roomId, {
  content: THIRD_ACTION,
  role: 'user',
  participantType: 'user',
  participantName: world.userName,
})

console.log(`\n> ${THIRD_ACTION}\n`)
await runGameplayTurn(turnDeps, {
  world,
  roomId: manifest.roomId,
  action: THIRD_ACTION,
})

const locationsAfter = locationNames()

console.log('\n--- turn three checks (sub-agent round-trip) ---')
check(
  subagentsDispatched.has('location_designer'),
  `the location_designer sub-agent was dispatched (saw: ${[...subagentsDispatched].join(', ') || 'none'})`,
)
check(
  toolsUsed.has('mcp__subagents__persist_location_design'),
  `the sub-agent called its persist tool over the MCP endpoint (saw: ${
    [...toolsUsed].filter((n) => n.startsWith('mcp__subagents__')).join(', ') || 'none'
  })`,
)
check(
  !locationsBefore.includes(DESIGNED_LOCATION) && locationsAfter.includes(DESIGNED_LOCATION),
  `the design landed in the database (${locationsBefore.length} → ${locationsAfter.length}: ${locationsAfter.join(', ')})`,
)

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
mcp.stop()

console.log(failures === 0 ? '\nPHASE 0 PASS' : `\nPHASE 0 FAIL (${failures} checks failed)`)
process.exit(failures === 0 ? 0 : 1)
