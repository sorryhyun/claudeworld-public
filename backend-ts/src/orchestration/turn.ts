import { and, count, eq } from 'drizzle-orm'

import { getSettings } from '../config/settings'

import { getAgentsCached } from '../crud/cached'
import { getAgentsInRoom, getRoom, markRoomAsFinished } from '../crud/rooms'
import { getCharactersAtLocation, getLocation } from '../crud/locations'
import { createMessage, getMessagesAfterAgentResponse } from '../crud/messages'
import { getPlayerState } from '../crud/player-state'
import { getRoomAgentSession, updateRoomAgentSession } from '../crud/sessions'
import type { Db } from '../db'
import { messages, type Agent, type World } from '../db/schema'
import { isActionManager, isOnboardingManager } from '../domain/agent'
import { getLogger } from '../infrastructure/logging/logger'
import { buildHooks, SubagentTimings, type HookTelemetry } from '../sdk/agent/hooks'
import {
  buildAgentOptions,
  optionsFingerprint,
  type AgentOptionsInput,
} from '../sdk/agent/options-builder'
import { TurnRunner, type TurnEvent } from '../sdk/agent/turn-runner'
import type { SessionPool } from '../sdk/client/session-pool'
import type { ServerDeps } from '../sdk/handlers/servers'
import type { McpTools } from '../sdk/mcp'
import type { ToolContext } from '../sdk/handlers/context'
import { parseAgentConfig } from '../sdk/parsing/agent-config'
import { buildSystemPrompt } from '../services/prompt-builder'
import { separateInterruptAgents } from './agent-ordering'
import { buildConversationContext } from './conversation-context'
import { createChatRoomTapes } from './tape/chat-room-tape'
import {
  buildActionManagerSystemPrompt,
  buildActionManagerUserMessage,
  type GameplayServices,
} from './gameplay-context'
import { createChatModeTape } from './tape/chat-tape'
import { createGameplayTape, createOnboardingTape } from './tape/gameplay-tape'
import { TapeExecutor, type RespondArgs, type RespondResult } from './tape/executor'
import type { AgentReaction, ExecutionResult } from './tape/models'

/**
 * Runs one turn. Port of the paths through `orchestration/trpg_orchestrator.py`,
 * `chat_mode_orchestrator.py` and `response_generator.py`.
 *
 * Three turn shapes share almost everything and differ in exactly the places
 * worth naming:
 *
 * | | agents | hidden | persists prose |
 * |---|---|---|---|
 * | **gameplay** | NPCs at the location, then the Action Manager | yes | no — the `narration` tool writes the visible message |
 * | **onboarding** | the Onboarding Manager, alone | no | yes |
 * | **chat** | NPCs at the location, one per cell | no | yes, tagged with the chat session |
 *
 * "Hidden" is the axis that matters: a hidden agent's prose is scratch work the
 * player never sees, so nothing is written for it. The other two modes are
 * conversations, and the reply *is* the output.
 */

const logger = getLogger('Turn')

/** Python's `max_total_messages` per orchestrator: 30 for gameplay, 15 for chat. */
const MAX_TOTAL_MESSAGES_GAMEPLAY = 30
const MAX_TOTAL_MESSAGES_CHAT = 15

export interface TurnDeps {
  db: Db
  pool: SessionPool
  services: GameplayServices
  serverDeps: ServerDeps
  /**
   * The stateless MCP surface the spawned CLI calls back into.
   *
   * Every turn binds its context here before running, and the endpoint resolves
   * that binding per tool call. It replaces the in-process servers this file
   * used to build per turn — which a warm session silently discarded, leaving
   * the CLI calling turn 1's closures forever. See `sdk/mcp/`.
   */
  mcp: McpTools
  projectRoot: string
  useSonnet?: boolean
  onEvent?: (agent: Agent, event: TurnEvent) => void
  onTelemetry?: (event: HookTelemetry) => void
  /**
   * Has the player spoken again since this response started?
   *
   * Python's `ResponseGenerator._was_interrupted`: a reply that was already in
   * flight when the player sent their next message is stale, and showing it
   * would answer a question the player has moved on from. The generator drops
   * it rather than persisting it. Supplied by {@link RoomOrchestrator}; absent
   * in tests and in the pilot, where nothing can interrupt.
   */
  isSuperseded?: (roomId: number, startedAt: number) => boolean
}

export interface RunTurnInput {
  world: World
  roomId: number
  action: string
  signal?: AbortSignal
}

export interface RunChatTurnInput extends RunTurnInput {
  /**
   * Groups this exchange into one chat session.
   *
   * Chat sessions are how a side conversation stays out of the game log: the
   * column is NULL for gameplay messages, so a filter on it separates the two
   * without a second table.
   */
  chatSessionId: number | null
}

// ============================================================================
// Gameplay and onboarding
// ============================================================================

/**
 * Run a player action — the gameplay tape, or the onboarding one while the
 * world is still being interviewed into existence.
 *
 * Throws when the room cannot produce a tape at all. Python fell through to a
 * generic sequential handler in that case, which ran whichever agents happened
 * to be in the room and produced output that looked like a turn but was not one;
 * the pilot flagged that as a trap worth failing loudly on instead.
 */
export async function runGameplayTurn(
  deps: TurnDeps,
  input: RunTurnInput,
): Promise<ExecutionResult> {
  const { db } = deps
  const { world } = input
  const playerState = getPlayerState(db, world.id)
  const locationId = playerState?.currentLocationId ?? null
  const location = locationId === null ? null : getLocation(db, locationId)

  const roomAgents = getAgentsInRoom(db, input.roomId)
  const onboarding = world.phase === 'onboarding'

  const byId = new Map<number, Agent>()
  let tape

  if (onboarding) {
    const manager = roomAgents.find((a) => isOnboardingManager(a.name)) ?? null
    if (manager) byId.set(manager.id, manager)
    tape = createOnboardingTape(manager?.id ?? null)
    if (!tape) {
      throw new Error(
        `Room ${input.roomId} is in the onboarding phase but has no Onboarding Manager.`,
      )
    }
  } else {
    const actionManager = roomAgents.find((a) => isActionManager(a.name)) ?? null
    const npcs = locationId === null ? [] : getCharactersAtLocation(db, locationId)
    for (const agent of [...npcs, ...(actionManager ? [actionManager] : [])]) {
      byId.set(agent.id, agent)
    }
    tape = createGameplayTape(
      actionManager?.id ?? null,
      npcs.map((n) => n.id),
    )
    if (!tape) {
      throw new Error(
        `Room ${input.roomId} has no Action_Manager; a gameplay turn cannot be built. ` +
          'Python fell through to a generic handler here, which produced output that was not a game turn.',
      )
    }
  }

  const executor = new TapeExecutor({
    ...roomGuards(db, input.roomId),
    respond: makeResponder(deps, {
      world,
      roomId: input.roomId,
      locationName: location?.name ?? null,
      byId,
      chatSessionId: null,
      timings: new SubagentTimings(),
      runner: new TurnRunner(deps.pool),
    }),
  })

  return executor.execute(tape, {
    userMessage: input.action,
    signal: input.signal,
    maxTotalMessages: MAX_TOTAL_MESSAGES_GAMEPLAY,
  })
}

// ============================================================================
// Chat mode
// ============================================================================

/**
 * Run a player message in chat mode.
 *
 * There is no Action Manager and no Narrator here — the NPCs at the player's
 * location simply answer, in priority order, each seeing the replies of those
 * before them. An empty location is a completed turn, not an error: talking to
 * nobody is something a player is allowed to do.
 */
export async function runChatTurn(
  deps: TurnDeps,
  input: RunChatTurnInput,
): Promise<ExecutionResult> {
  const { db } = deps
  const { world } = input
  const playerState = getPlayerState(db, world.id)
  const locationId = playerState?.currentLocationId ?? null
  const location = locationId === null ? null : getLocation(db, locationId)

  const npcs = locationId === null ? [] : getCharactersAtLocation(db, locationId)
  const tape = createChatModeTape(npcs)
  if (!tape) {
    logger.info(`[ChatMode] No NPCs at location ${String(locationId)}; nothing to respond`)
    return emptyResult()
  }

  const byId = new Map(npcs.map((npc) => [npc.id, npc]))

  const executor = new TapeExecutor({
    ...roomGuards(db, input.roomId),
    respond: makeResponder(deps, {
      world,
      roomId: input.roomId,
      locationName: location?.name ?? null,
      byId,
      chatSessionId: input.chatSessionId,
      timings: new SubagentTimings(),
      runner: new TurnRunner(deps.pool),
    }),
  })

  return executor.execute(tape, {
    userMessage: input.action,
    signal: input.signal,
    maxTotalMessages: MAX_TOTAL_MESSAGES_CHAT,
  })
}

// ============================================================================
// Chat rooms
// ============================================================================

/** Follow-up rounds after the initial one — Python's `MAX_FOLLOW_UP_ROUNDS`. */
export const MAX_FOLLOW_UP_ROUNDS = 5

/** Runaway guard across every round of one turn — Python's `MAX_TOTAL_MESSAGES`. */
export const MAX_TOTAL_MESSAGES_CHAT_ROOM = 30

export interface RunChatRoomTurnInput {
  roomId: number
  action: string
  /**
   * Agent ids parsed out of `@mentions`, or null for "everyone".
   *
   * Ids not in the room are dropped with a warning rather than failing the
   * turn: the mention came from a client-side parse of free text, and a stale
   * roster there should not cost the user their message.
   */
  mentionedAgentIds?: number[] | null
  signal?: AbortSignal
}

/**
 * Run one user message in a plain chat room — port of
 * `ChatOrchestrator._process_agent_responses`.
 *
 * A chat room has no world, no location and no Action Manager; the agents in
 * the room simply talk, first to the user and then to each other. That second
 * half is what makes this different from every other turn in the system: it is
 * a *loop* of tapes, not one tape.
 *
 * The loop stops on the first of: pause, interruption, the room's
 * `max_interactions` ceiling, {@link MAX_FOLLOW_UP_ROUNDS}, or a round in which
 * every agent skipped — which is read as the conversation having run its course
 * and marks the room finished.
 */
export async function runChatRoomTurn(
  deps: TurnDeps,
  input: RunChatRoomTurnInput,
): Promise<ExecutionResult> {
  const { db, roomId } = { db: deps.db, roomId: input.roomId }

  const roster = getAgentsInRoom(db, roomId)
  const selected = filterMentioned(roster, input.mentionedAgentIds ?? null, roomId)
  if (selected.length === 0) {
    logger.info(`[ChatRoom] No agents to respond in room ${roomId}`)
    return emptyResult()
  }

  const [interruptAgents, plainAgents] = separateInterruptAgents(selected)
  const tapes = createChatRoomTapes(plainAgents, interruptAgents)
  const byId = new Map(selected.map((agent) => [agent.id, agent]))

  const executor = new TapeExecutor({
    ...roomGuards(db, roomId),
    respond: makeResponder(deps, {
      // No world: see `ResponderContext.world`.
      world: null,
      roomId,
      locationName: null,
      byId,
      chatSessionId: null,
      timings: new SubagentTimings(),
      runner: new TurnRunner(deps.pool),
    }),
  })

  const total = await executor.execute(tapes.initial(), {
    userMessage: input.action,
    signal: input.signal,
    maxTotalMessages: MAX_TOTAL_MESSAGES_CHAT_ROOM,
  })

  if (total.wasPaused || total.wasInterrupted || total.reachedLimit) return total

  /** What is left of the cumulative runaway budget after the rounds so far. */
  const budget = (): number => Math.max(0, MAX_TOTAL_MESSAGES_CHAT_ROOM - total.totalResponses)

  // A one-agent room has nobody to talk *to*, so there is nothing to follow up.
  const allAgents = tapes.allAgents
  if (allAgents.length <= 1) return total

  // A room whose only interrupt agents are transparent has no visible reactor,
  // and Python skips the follow-up entirely rather than running rounds nobody
  // sees.
  if (interruptAgents.length > 0 && interruptAgents.every((a) => (a.transparent ?? false))) {
    logger.info('[ChatRoom] All interrupt agents are transparent, skipping follow-up rounds')
    return total
  }

  for (let round = 0; round < MAX_FOLLOW_UP_ROUNDS; round++) {
    const tape = tapes.followUp(round)
    if (tape === null) break

    const result = await executor.execute(tape, {
      // No user message: the agents are answering each other now.
      userMessage: '',
      signal: input.signal,
      // The guard is cumulative across rounds — Python threads `current_total`
      // into the executor for this; subtracting from the budget is the same sum.
      maxTotalMessages: budget(),
    })

    total.totalResponses += result.totalResponses
    total.totalSkips += result.totalSkips
    total.cellsExecuted += result.cellsExecuted
    total.wasInterrupted = result.wasInterrupted
    total.wasPaused = result.wasPaused
    total.reachedLimit = result.reachedLimit

    if (result.wasPaused || result.wasInterrupted || result.reachedLimit) break

    if (result.allSkipped) {
      logger.info(`[ChatRoom] All agents skipped in room ${roomId}. Marking as finished.`)
      markRoomAsFinished(db, roomId)
      total.allSkipped = true
      break
    }
  }

  return total
}

export interface RunAutonomousRoundInput {
  roomId: number
  signal?: AbortSignal
}

/**
 * Run *one* follow-up round in a plain chat room, with no user message — port of
 * `ChatOrchestrator.process_autonomous_round`.
 *
 * This is what the background scheduler drives every couple of seconds so that
 * agents keep talking to each other while nobody is watching. It is deliberately
 * the same tape {@link runChatRoomTurn} uses for its follow-ups — round 0 of
 * {@link ChatRoomTapes.followUp} — rather than a second scheduler: the only
 * difference between "the user said something and the agents followed up" and
 * "the agents talked among themselves" is where the first line came from.
 *
 * Unlike {@link runChatRoomTurn} there is no loop. One tick, one round; the next
 * tick two seconds later is the loop, and it re-reads pause, finished and
 * `max_interactions` from the database on the way in — which is what makes the
 * conversation stoppable from the UI between rounds.
 *
 * Stopping conditions, all of them Python's:
 *
 * - **fewer than 2 agents** — nobody to talk to, so nothing is scheduled.
 * - **`max_interactions` reached** — counted against the assistant messages
 *   already in the room, exactly as {@link roomGuards} counts it mid-tape, and
 *   surfaced as `reachedLimit` so the caller can tell it apart from a quiet round.
 * - **every agent skipped** — the conversation has run its course, and the room
 *   is marked finished so the scheduler stops selecting it.
 */
export async function runAutonomousRound(
  deps: TurnDeps,
  input: RunAutonomousRoundInput,
): Promise<ExecutionResult> {
  const { db } = deps
  const { roomId } = input

  // Cached, like Python's `crud.get_agents_cached`: this runs on a 2-second
  // timer for every active room, and the roster changes far more slowly.
  const roster = getAgentsCached(db, roomId)
  if (roster.length < 2) {
    logger.debug(`[Autonomous] Room ${roomId} has fewer than 2 agents, skipping`)
    return emptyResult()
  }

  const guards = roomGuards(db, roomId)
  if (guards.isInteractionLimitReached()) {
    logger.debug(`[Autonomous] Room ${roomId} reached its max_interactions ceiling`)
    return { ...emptyResult(), reachedLimit: true }
  }

  const [interruptAgents, plainAgents] = separateInterruptAgents(roster)
  const tape = createChatRoomTapes(plainAgents, interruptAgents).followUp(0)
  // Null when every agent in the room is an interrupt agent: they only ever
  // react to someone else's line, so there is no round to open with.
  if (tape === null) return emptyResult()

  const executor = new TapeExecutor({
    ...guards,
    respond: makeResponder(deps, {
      // No world: a chat room belongs to none. See `ResponderContext.world`.
      world: null,
      roomId,
      locationName: null,
      byId: new Map(roster.map((agent) => [agent.id, agent])),
      chatSessionId: null,
      timings: new SubagentTimings(),
      runner: new TurnRunner(deps.pool),
    }),
  })

  const result = await executor.execute(tape, {
    // The agents are answering each other; there is no user turn to answer.
    userMessage: '',
    signal: input.signal,
    maxTotalMessages: MAX_TOTAL_MESSAGES_CHAT_ROOM,
  })

  if (result.allSkipped) {
    logger.info(`[Autonomous] All agents skipped in room ${roomId}. Marking as finished.`)
    markRoomAsFinished(db, roomId)
  } else {
    logger.info(
      `[Autonomous] Round complete | Room: ${roomId} | Responses: ${result.totalResponses}`,
    )
  }

  return result
}

/**
 * Narrow the roster to the mentioned agents, if any were mentioned.
 *
 * An empty intersection means every mention was stale, and Python treats that
 * as "no filter" rather than "nobody responds" — the message still gets an
 * answer instead of vanishing into a silent room.
 */
function filterMentioned<T extends { id: number; name: string }>(
  roster: T[],
  mentionedAgentIds: number[] | null,
  roomId: number,
): T[] {
  if (!mentionedAgentIds || mentionedAgentIds.length === 0) return roster

  const mentioned = new Set(mentionedAgentIds)
  const inRoom = new Set(roster.map((agent) => agent.id))
  const valid = [...mentioned].filter((id) => inRoom.has(id))

  if (valid.length !== mentioned.size) {
    const invalid = [...mentioned].filter((id) => !inRoom.has(id))
    logger.warning(`⚠️ Invalid @mentions (not in room ${roomId}): ${invalid.join(', ')}`)
  }
  if (valid.length === 0) return roster

  const validSet = new Set(valid)
  const filtered = roster.filter((agent) => validSet.has(agent.id))
  logger.info(
    `🎯 MENTION FILTER | Room: ${roomId} | Only responding: ${filtered.map((a) => a.name).join(', ')}`,
  )
  return filtered
}

// ============================================================================
// Turn side effects
// ============================================================================

/** Python's default prompt for the memory round, kept verbatim. */
export const MEMORY_ROUND_PROMPT =
  'Use the memorize tool to remember any significant events from this conversation ' +
  'before the player leaves.'

export interface MemoryRoundInput {
  world: World
  /** The *departing* location — its room, its NPCs. */
  locationId: number
  prompt?: string
  signal?: AbortSignal
}

/**
 * Give the NPCs at a location one turn to write down what just happened.
 *
 * Fired by the `travel` tool before the player leaves. Each NPC runs hidden and
 * with `skipContext`: the conversation being remembered is already in that NPC's
 * own SDK session, so the prompt is an instruction *about* it rather than a turn
 * *in* it — sending conversation context here would replay the scene the agent
 * has just lived through.
 *
 * Best-effort throughout. Returns how many NPCs actually did something; a
 * character that skips, errors, or has no session left simply does not count,
 * because the player is leaving either way.
 */
export async function runMemoryRound(
  deps: TurnDeps,
  input: MemoryRoundInput,
): Promise<number> {
  const { db } = deps
  const location = getLocation(db, input.locationId)
  if (!location?.roomId) {
    logger.warning(`Location ${input.locationId} has no room; skipping memory round`)
    return 0
  }

  const npcs = getCharactersAtLocation(db, input.locationId)
  if (npcs.length === 0) return 0

  const roomId = location.roomId
  const runner = new TurnRunner(deps.pool)
  const timings = new SubagentTimings()
  const prompt = input.prompt ?? MEMORY_ROUND_PROMPT

  logger.info(`Memory round: ${npcs.length} NPC(s) at location ${input.locationId}`)

  const outcomes = await Promise.allSettled(
    npcs.map(async (npc) => {
      const built = buildAgentTurn(deps, {
        world: input.world,
        agent: npc,
        roomId,
        locationName: location.name,
        userMessage: prompt,
        npcReactions: undefined,
        chatSessionId: null,
        timings,
        skipContext: true,
      })

      let responded = false
      for await (const event of runner.run({
        roomId,
        agentId: npc.id,
        agentName: npc.name,
        content: built.message,
        options: built.options,
        hidden: true,
        signal: input.signal,
      })) {
        deps.onEvent?.(npc, event)
        if (event.type !== 'stream_end') continue
        if (event.sessionId && event.sessionId !== built.resume) {
          updateRoomAgentSession(db, roomId, npc.id, event.sessionId)
        }
        responded = !event.skipped && !event.error
      }
      return responded
    }),
  )

  const processed = outcomes.filter((o) => o.status === 'fulfilled' && o.value).length
  logger.info(`Memory round complete: ${processed}/${npcs.length} NPCs processed`)
  return processed
}

/**
 * Open sessions for the characters at a location without running a turn.
 *
 * Pure latency work, and it only pays off if the options built here are
 * *identical* to the ones the real turn will build: the pool reopens a session
 * whose fingerprint has changed, so a pre-connect that guesses differently is
 * worse than none — it pays the subprocess cost twice. That is why this goes
 * through {@link buildAgentTurn} rather than assembling options of its own, and
 * why the message it passes is irrelevant (the fingerprint covers the system
 * prompt, tools and model, never the message).
 *
 * Capped at five characters, as Python's `_pre_connect_npcs` is: a crowded
 * location would otherwise try to spawn one subprocess per character at once.
 * Every failure is swallowed — the turn opens the session on demand instead.
 */
export async function preConnectLocation(
  deps: TurnDeps,
  input: { world: World; roomId: number; locationId: number; limit?: number },
): Promise<number> {
  const location = getLocation(deps.db, input.locationId)
  const npcs = getCharactersAtLocation(deps.db, input.locationId).slice(0, input.limit ?? 5)
  if (npcs.length === 0) return 0

  const timings = new SubagentTimings()
  const outcomes = await Promise.allSettled(
    npcs.map(async (npc) => {
      const built = buildAgentTurn(deps, {
        world: input.world,
        agent: npc,
        roomId: input.roomId,
        locationName: location?.name ?? null,
        userMessage: '',
        npcReactions: undefined,
        chatSessionId: null,
        timings,
        skipContext: true,
      })
      await deps.pool.acquire(
        { roomId: input.roomId, agentId: npc.id },
        buildAgentOptions(built.options),
        optionsFingerprint(built.options),
      )
    }),
  )

  const warmed = outcomes.filter((o) => o.status === 'fulfilled').length
  if (warmed < npcs.length) {
    logger.debug(`Pre-connect warmed ${warmed}/${npcs.length} characters (best-effort)`)
  }
  return warmed
}

// ============================================================================
// Shared turn machinery
// ============================================================================

/**
 * The between-cell checks the executor makes against the room.
 *
 * Both are re-read every cell rather than captured once: a player can pause a
 * room, or hit its `max_interactions` ceiling, part-way through a turn, and the
 * point of checking between cells is to notice.
 *
 * Deliberately absent: `onCellComplete`, the hook that re-resolves the room
 * after a hidden cell because `travel` may have moved the player. Python ran it
 * after every hidden cell, but the Action Manager's cell is the *last* one on
 * both tapes, so the refreshed room id was never read by anything — the room a
 * turn writes to is fixed when the turn starts, and the next turn resolves the
 * new location for itself. The hook stays available on the executor for a tape
 * that one day has a cell after the Action Manager's.
 */
function roomGuards(
  db: Db,
  roomId: number,
): { isPaused: () => boolean; isInteractionLimitReached: () => boolean } {
  return {
    isPaused: () => getRoom(db, roomId)?.isPaused === true,
    isInteractionLimitReached: () => {
      const room = getRoom(db, roomId)
      if (room?.maxInteractions === null || room?.maxInteractions === undefined) return false
      return countAssistantMessages(db, roomId) >= room.maxInteractions
    },
  }
}

interface ResponderContext {
  /**
   * The world this room belongs to, or null for a plain chat room.
   *
   * Chat rooms (`rooms.world_id IS NULL`) predate the TRPG mode and still have
   * no world, no player state and no location. Everything below that reads a
   * world field therefore has a non-world fallback; see {@link buildAgentTurn}.
   */
  world: World | null
  roomId: number
  locationName: string | null
  byId: Map<number, Agent>
  chatSessionId: number | null
  timings: SubagentTimings
  runner: TurnRunner
}

/**
 * Builds the executor's `respond` function: one agent, one turn, start to
 * finish — prompt assembly, the SDK stream, session bookkeeping, and the
 * decision of whether anything is persisted.
 */
function makeResponder(deps: TurnDeps, ctx: ResponderContext) {
  const { db } = deps

  return async function respond({
    agentId,
    userMessage,
    hidden,
    npcReactions,
    signal,
  }: RespondArgs): Promise<RespondResult> {
    const agent = ctx.byId.get(agentId)
    if (!agent) return { responded: false, responseText: '', agentName: `Agent ${agentId}` }

    // Captured before the model runs, so a player message that lands *during*
    // the turn compares as newer. Taking it afterwards would make every
    // interruption look like it arrived first.
    const startedAt = Date.now()

    const built = buildAgentTurn(deps, {
      world: ctx.world,
      agent,
      roomId: ctx.roomId,
      locationName: ctx.locationName,
      userMessage,
      npcReactions,
      chatSessionId: ctx.chatSessionId,
      timings: ctx.timings,
    })

    let responseText = ''
    let thinkingText = ''
    let anthropicCalls: string[] = []
    let responded = false

    for await (const event of ctx.runner.run({
      roomId: ctx.roomId,
      agentId: agent.id,
      agentName: agent.name,
      content: built.message,
      options: built.options,
      hidden,
      signal,
    })) {
      deps.onEvent?.(agent, event)
      if (event.type !== 'stream_end') continue

      // Persisted before the next turn runs: if the new id is not written
      // back, the next turn resumes a stale session and silently forks the
      // conversation.
      if (event.sessionId && event.sessionId !== built.resume) {
        updateRoomAgentSession(db, ctx.roomId, agent.id, event.sessionId)
      }
      if (event.error) throw new Error(`${agent.name}: ${event.error}`)

      responseText = event.responseText ?? ''
      thinkingText = event.thinkingText
      anthropicCalls = event.anthropicCalls
      responded = !event.skipped && responseText.length > 0
    }

    // A hidden agent has nothing to persist by definition — whatever it wanted
    // the player to see, its tools already wrote.
    if (hidden || !responded) {
      return { responded, responseText, agentName: agent.name }
    }

    const discard = discardReason(deps, ctx.roomId, startedAt)
    if (discard) {
      logger.info(`⏭️  Discarding response | Room: ${ctx.roomId} | ${agent.name} | ${discard}`)
      return { responded: false, responseText: '', agentName: agent.name }
    }

    createMessage(db, ctx.roomId, {
      content: responseText,
      role: 'assistant',
      agentId: agent.id,
      thinking: thinkingText || null,
      anthropicCalls: anthropicCalls.length > 0 ? anthropicCalls : null,
      chatSessionId: ctx.chatSessionId,
      // Read at save time rather than turn start: a tool may have advanced the
      // clock during the turn, and the stamp should say when the line was
      // spoken, not when the turn began.
      // A chat room has no world and therefore no clock; the column stays NULL,
      // which is what every message written before the TRPG mode existed has.
      gameTimeSnapshot:
        ctx.world === null
          ? null
          : (deps.services.players.loadPlayerState(ctx.world.name)?.gameTime ?? null),
    })

    return { responded: true, responseText, agentName: agent.name }
  }
}

/**
 * Why this finished response must not be shown, or `null` to persist it.
 *
 * Both reasons are races the player created and both are late checks by design
 * — the answer is only knowable once the model has finished, because that is
 * when the window closes.
 */
function discardReason(deps: TurnDeps, roomId: number, startedAt: number): string | null {
  if (deps.isSuperseded?.(roomId, startedAt)) return 'superseded by a newer player message'
  if (getRoom(deps.db, roomId)?.isPaused === true) return 'room was paused mid-response'
  return null
}

/**
 * Assistant messages in a room, for the `max_interactions` ceiling.
 *
 * Python counts `role == ASSISTANT`, not "has an agent_id" — the two differ for
 * the narration tool's output, which is written with the Action Manager's id
 * *and* the assistant role, and for system messages, which have neither.
 */
function countAssistantMessages(db: Db, roomId: number): number {
  return (
    db
      .select({ total: count() })
      .from(messages)
      .where(and(eq(messages.roomId, roomId), eq(messages.role, 'assistant')))
      .get()?.total ?? 0
  )
}

function emptyResult(): ExecutionResult {
  return {
    totalResponses: 0,
    totalSkips: 0,
    cellsExecuted: 0,
    wasInterrupted: false,
    wasPaused: false,
    reachedLimit: false,
    allSkipped: false,
    reactions: [],
  }
}

// ============================================================================
// Prompt assembly
// ============================================================================

interface BuildTurnInput {
  /** Null for a plain chat room. See {@link ResponderContext.world}. */
  world: World | null
  agent: Agent
  roomId: number
  locationName: string | null
  userMessage: string
  npcReactions: AgentReaction[] | undefined
  chatSessionId: number | null
  timings: SubagentTimings
  /**
   * Send `userMessage` as written instead of building conversation context.
   *
   * Python's `skip_context`. Used by the memory round, where the SDK session
   * already holds the conversation being remembered and the prompt is an
   * instruction about it rather than a turn in it.
   */
  skipContext?: boolean
}

/** Assembles one agent's prompt, tools and message for a single turn. */
function buildAgentTurn(
  deps: TurnDeps,
  input: BuildTurnInput,
): { options: AgentOptionsInput; message: string; resume: string | undefined } {
  const { db } = deps
  const { agent, world } = input
  const asActionManager = isActionManager(agent.name)
  const asOnboardingManager = isOnboardingManager(agent.name)

  // Filesystem-primary: the DB columns are a cache, and the config on disk is
  // re-read every turn so an edit to a character file takes effect immediately.
  const config = agent.configFile ? parseAgentConfig(agent.configFile) : null
  const systemPromptBase = config ? buildSystemPrompt(agent.name, config) : agent.systemPrompt

  const resume = getRoomAgentSession(db, input.roomId, agent.id) ?? undefined

  const ctx: ToolContext = {
    agentName: agent.name,
    agentId: agent.id,
    configFile: agent.configFile ?? undefined,
    groupName: agent.group ?? undefined,
    roomId: input.roomId,
    // Both optional on `ToolContext`, and absent for a chat room. The tools a
    // character is offered (skip, memorize, recall, guidelines) read the agent's
    // own folder, not the world, so none of them needs these.
    worldName: world?.name,
    worldId: world?.id,
    longTermMemoryIndex: config?.longTermMemoryIndex ?? {},
    npcReactions: input.npcReactions,
    getDb: () => db,
  }

  // Binds before the session is acquired, which the ordering here already
  // guarantees: the caller does not touch the pool until these options exist,
  // and the CLI's first `tools/list` cannot precede its own subprocess.
  const servers = deps.mcp.bindTurn({ roomId: input.roomId, agentId: agent.id }, ctx, {
    role: asActionManager ? 'action_manager' : asOnboardingManager ? 'onboarding' : 'character',
    configDir: agent.configFile
      ? `${deps.projectRoot}/${agent.configFile}`.replace(/\/+/g, '/')
      : undefined,
  })

  let systemPrompt = systemPromptBase
  let message: string

  if (asActionManager) {
    // Unreachable for a chat room: the Action Manager is a gameplay agent and
    // is never a member of one. Asserted rather than defaulted, because a world
    // silently substituted here would produce narration against the wrong one.
    if (world === null) {
      throw new Error(`${agent.name} requires a world; room ${input.roomId} has none`)
    }
    const contextInput = {
      worldName: world.name,
      userName: world.userName,
      language: world.language,
      currentLocation: input.locationName,
    }
    systemPrompt += `\n\n${buildActionManagerSystemPrompt(deps.services, contextInput)}`
    message = buildActionManagerUserMessage(deps.services, {
      ...contextInput,
      playerAction: input.userMessage,
      agentName: agent.name,
      npcReactions: input.npcReactions,
    })
  } else if (input.skipContext) {
    message = input.userMessage
  } else {
    // Characters — and the Onboarding Manager, which is a conversational agent
    // in the same sense — are not handed the action directly. They read it out
    // of the room's messages, where it was persisted before the turn started,
    // which is what makes their view of the scene identical to any other
    // observer's.
    //
    // The two "keep only the latest" filters are a gameplay economy: in a game
    // turn a character needs the newest narration and the newest player action
    // and nothing else, because the rest is already in its own SDK session. An
    // onboarding interview and a chat conversation are ordinary dialogue, where
    // dropping intermediate turns would delete the conversation.
    const conversational = asOnboardingManager || input.chatSessionId !== null
    const messages = getMessagesAfterAgentResponse(
      db,
      input.roomId,
      agent.id,
      input.chatSessionId !== null ? 100 : 120,
    ).filter((m) => visibleInSession(m.chatSessionId, input.chatSessionId))

    message = buildConversationContext({
      messages: messages.map((m) => ({
        id: m.id,
        content: m.content,
        role: m.role,
        agentId: m.agentId,
        agentName: m.agent?.name ?? null,
        participantType: m.participantType,
        participantName: m.participantName,
      })),
      agentId: agent.id,
      agentName: agent.name,
      // A chat room has no world to name the user, so the global `USER_NAME`
      // stands in — which is the setting Python's chat rooms have always used
      // for exactly this, and the language falls back to the prompt default.
      worldUserName: world?.userName ?? getSettings().userName,
      worldLanguage: world?.language ?? null,
      includeResponseInstruction: true,
      keepOnlyLatestActionManager: !conversational,
      keepOnlyLatestUser: !conversational,
    })
  }

  const anthropicCalls: string[] = []
  const hooks = buildHooks(
    {
      agentName: agent.name,
      roomId: input.roomId,
      anthropicCalls: { push: (s) => anthropicCalls.push(s) },
      onEvent: deps.onTelemetry,
    },
    input.timings,
  )

  return {
    options: {
      systemPrompt,
      mcpServers: servers.mcpServers,
      toolNames: servers.toolNames,
      hooks,
      resume,
      useSonnet: deps.useSonnet,
    },
    message,
    resume,
  }
}

/**
 * Should a stored message appear in this turn's context?
 *
 * Gameplay messages (`chat_session_id IS NULL`) are visible to everyone: a chat
 * happens inside the world, and an NPC that just watched a monster arrive should
 * not lose that because the player opened a side conversation. What is filtered
 * out is *other* chat sessions — earlier conversations the SDK session already
 * remembers, and which would otherwise be replayed into context every turn.
 */
function visibleInSession(messageSession: number | null, turnSession: number | null): boolean {
  if (turnSession === null) return true
  return messageSession === null || messageSession === turnSession
}
