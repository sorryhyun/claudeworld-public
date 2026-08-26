import { getSettings } from '@/config/settings'

import { getAgentsCached } from '@/crud/cached'
import { getAgentsInRoom, getRoom, markRoomAsFinished } from '@/crud/rooms'
import { getCharactersAtLocation, getLocation } from '@/crud/locations'
import {
  countAssistantMessages,
  createMessage,
  getMessagesAfterAgentResponse,
  type MessageWithAgent,
} from '@/crud/messages'
import { getPlayerState } from '@/crud/player-state'
import { getRoomAgentSession, updateRoomAgentSession } from '@/crud/sessions'
import type { Db } from '@/db'
import type { Agent, World } from '@/db/schema'
import { isActionManager, isOnboardingManager } from '@/domain/agent'
import { getLogger } from '@/infrastructure/logging/logger'
import { buildHooks, SubagentTimings, type HookTelemetry } from '@/sdk/agent/hooks'
import {
  buildAgentOptions,
  optionsFingerprint,
  type AgentOptionsInput,
} from '@/sdk/agent/options-builder'
import { buildSubagentDefinitionsForRole } from '@/sdk/agent/subagent-definitions'
import { renderWorldSettingsBrief, toWorldSettings } from '@/domain/world-settings'
import { TurnRunner, type TurnEvent } from '@/sdk/agent/turn-runner'
import type { SessionPool } from '@/sdk/client/session-pool'
import type { ServerDeps, ServerRole } from '@/sdk/handlers/servers'
import type { McpTools } from '@/sdk/mcp'
import type { NpcReaction, ToolContext } from '@/sdk/handlers/context'
import { parseAgentConfig } from '@/sdk/parsing/agent-config'
import { buildSystemPrompt } from '@/services/prompt-builder'
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
 * Runs one turn, in three shapes: gameplay (the NPCs and the Action Manager
 * side by side, all hidden), onboarding (the Onboarding Manager alone) and chat
 * (NPCs, one per cell). A hidden agent's prose is never persisted — its
 * `narration` tool writes the visible message instead.
 */

const logger = getLogger('Turn')

const MAX_TOTAL_MESSAGES_GAMEPLAY = 30
const MAX_TOTAL_MESSAGES_CHAT = 15

export interface TurnDeps {
  db: Db
  pool: SessionPool
  services: GameplayServices
  serverDeps: ServerDeps
  // Every turn binds its context here first and the endpoint resolves that
  // binding per tool call. Per-turn in-process servers would be discarded by a
  // warm session, leaving the CLI calling turn 1's closures forever.
  mcp: McpTools
  projectRoot: string
  useSonnet?: boolean
  onEvent?: (agent: Agent, event: TurnEvent, meta: TurnEventMeta) => void
  /** A visible response was persisted; SSE pushes it so clients need not wait
   * for the next poll after the typing bubble clears on `stream_end`. */
  onMessageSaved?: (roomId: number, message: MessageWithAgent) => void
  onTelemetry?: (event: HookTelemetry) => void
  // Has the player spoken again since this response started? A reply in flight
  // when the next player message lands is stale and gets dropped.
  isSuperseded?: (roomId: number, startedAt: number) => boolean
}

/** Where a turn event happened. `hidden` gates what may be shown to clients:
 * a hidden agent's prose never leaves the server, its thinking and narration do. */
export interface TurnEventMeta {
  roomId: number
  hidden: boolean
}

export interface RunTurnInput {
  world: World
  roomId: number
  action: string
  signal?: AbortSignal
}

export interface RunChatTurnInput extends RunTurnInput {
  /** NULL for gameplay messages, so a filter keeps side chat out of the log. */
  chatSessionId: number | null
}

/**
 * Run a player action — the gameplay tape, or the onboarding one. Throws when
 * the room cannot produce a tape: a generic fallback would run whichever agents
 * happen to be present and produce output that only looks like a turn.
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
      // Throw rather than fall back to a generic responder: that produces
      // output which is not a game turn.
      throw new Error(
        `Room ${input.roomId} has no Action_Manager; a gameplay turn cannot be built.`,
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

/**
 * Chat mode: no Action Manager, no Narrator, just the NPCs at the player's
 * location answering in priority order. An empty location is a completed turn.
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

/** Follow-up rounds after the initial one. */
export const MAX_FOLLOW_UP_ROUNDS = 5

/** Runaway guard across every round of one turn. */
export const MAX_TOTAL_MESSAGES_CHAT_ROOM = 30

export interface RunChatRoomTurnInput {
  roomId: number
  action: string
  // Null for "everyone". Ids not in the room are dropped with a warning rather
  // than failing the turn: the mentions come from a client-side parse.
  mentionedAgentIds?: number[] | null
  signal?: AbortSignal
}

/**
 * Run one user message in a plain chat room: the agents talk to the user, then
 * to each other, which makes this a *loop* of tapes. It stops on pause,
 * interruption, `max_interactions`, {@link MAX_FOLLOW_UP_ROUNDS}, or a round in
 * which every agent skipped — which also marks the room finished.
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

  const budget = (): number => Math.max(0, MAX_TOTAL_MESSAGES_CHAT_ROOM - total.totalResponses)

  const allAgents = tapes.allAgents
  if (allAgents.length <= 1) return total

  // Only-transparent interrupt agents leave no visible reactor; running
  // follow-up rounds nobody sees is pointless.
  if (interruptAgents.length > 0 && interruptAgents.every((a) => (a.transparent ?? false))) {
    logger.info('[ChatRoom] All interrupt agents are transparent, skipping follow-up rounds')
    return total
  }

  for (let round = 0; round < MAX_FOLLOW_UP_ROUNDS; round++) {
    const tape = tapes.followUp(round)
    if (tape === null) break

    const result = await executor.execute(tape, {
      userMessage: '',
      signal: input.signal,
      // The guard is cumulative across rounds, not per round.
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
 * Run *one* follow-up round in a plain chat room, with no user message — what
 * the background scheduler drives every couple of seconds so agents keep talking
 * while nobody is watching, on round 0 of {@link runChatRoomTurn}'s follow-up
 * tape. There is no loop: the next tick two seconds later is the loop, and it
 * re-reads pause, finished and `max_interactions` on the way in, which is what
 * makes the conversation stoppable from the UI between rounds.
 */
export async function runAutonomousRound(
  deps: TurnDeps,
  input: RunAutonomousRoundInput,
): Promise<ExecutionResult> {
  const { db } = deps
  const { roomId } = input

  // Cached: this runs on a 2-second timer for every active room, and the roster
  // changes far more slowly.
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
      // No world: see `ResponderContext.world`.
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

// Narrow the roster to the mentioned agents. An empty intersection means every
// mention was stale, and is treated as "no filter", so the message still gets
// an answer.
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
 * Give the NPCs at a location one turn to write down what just happened, fired
 * by `travel` before the player leaves. Each runs hidden and with `skipContext`:
 * the conversation is already in its own SDK session, so sending context would
 * replay the scene it just lived through. Best-effort throughout.
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
        deps.onEvent?.(npc, event, { roomId, hidden: true })
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
 * Open sessions for the characters at a location without running a turn. Only
 * pays off if the options are *identical* to the real turn's — the pool reopens
 * a session whose fingerprint changed — hence {@link buildAgentTurn} rather than
 * options of its own. Capped at five, and failures are swallowed.
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

// Re-read every cell rather than captured once: a player can pause a room, or
// hit its `max_interactions` ceiling, part-way through a turn. `onCellComplete`
// is deliberately unused — it would re-resolve the room after a hidden cell in
// case `travel` moved the player, but the Action Manager's cell is the *last* on
// both tapes, so the refreshed id would never be read.
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
  // Null for a plain chat room, which has no player state or location either, so
  // everything below that reads a world field needs a fallback.
  world: World | null
  roomId: number
  locationName: string | null
  byId: Map<number, Agent>
  chatSessionId: number | null
  timings: SubagentTimings
  runner: TurnRunner
}

// Builds the executor's `respond` function: one agent, one turn — prompt
// assembly, the SDK stream, session bookkeeping, and whether to persist.
function makeResponder(deps: TurnDeps, ctx: ResponderContext) {
  const { db } = deps

  return async function respond({
    agentId,
    userMessage,
    hidden,
    npcReactions,
    pendingReactions,
    signal,
  }: RespondArgs): Promise<RespondResult> {
    const agent = ctx.byId.get(agentId)
    if (!agent) return { responded: false, responseText: '', agentName: `Agent ${agentId}` }

    // Captured before the model runs, so a player message landing *during* the
    // turn compares as newer.
    const startedAt = Date.now()

    const built = buildAgentTurn(deps, {
      world: ctx.world,
      agent,
      roomId: ctx.roomId,
      locationName: ctx.locationName,
      userMessage,
      npcReactions,
      // Resolved to names here, not in the executor: the tape deals in ids, and
      // it is the prompt that needs to say who is still speaking.
      pendingReactions: pendingReactions
        ? {
            names: pendingReactions.agentIds.map(
              (id) => ctx.byId.get(id)?.name ?? `Agent ${String(id)}`,
            ),
            reactions: pendingReactions.reactions,
          }
        : undefined,
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
      deps.onEvent?.(agent, event, { roomId: ctx.roomId, hidden })
      if (event.type !== 'stream_end') continue

      // If the new id is not written back, the next turn resumes a stale
      // session and silently forks the conversation.
      if (event.sessionId && event.sessionId !== built.resume) {
        updateRoomAgentSession(db, ctx.roomId, agent.id, event.sessionId)
      }
      if (event.error) throw new Error(`${agent.name}: ${event.error}`)

      responseText = event.responseText ?? ''
      thinkingText = event.thinkingText
      anthropicCalls = event.anthropicCalls
      responded = !event.skipped && responseText.length > 0
    }

    // A hidden agent has nothing to persist: whatever it wanted the player to
    // see, its tools already wrote.
    if (hidden || !responded) {
      return { responded, responseText, agentName: agent.name }
    }

    const discard = discardReason(deps, ctx.roomId, startedAt)
    if (discard) {
      logger.info(`⏭️  Discarding response | Room: ${ctx.roomId} | ${agent.name} | ${discard}`)
      return { responded: false, responseText: '', agentName: agent.name }
    }

    const saved = createMessage(db, ctx.roomId, {
      content: responseText,
      role: 'assistant',
      agentId: agent.id,
      thinking: thinkingText || null,
      anthropicCalls: anthropicCalls.length > 0 ? anthropicCalls : null,
      chatSessionId: ctx.chatSessionId,
      // Read at save time, not turn start: a tool may have advanced the clock
      // mid-turn, and the stamp should say when the line was spoken. A chat room
      // has no clock, so the column stays NULL.
      gameTimeSnapshot:
        ctx.world === null
          ? null
          : (deps.services.players.loadPlayerState(ctx.world.name)?.gameTime ?? null),
    })
    deps.onMessageSaved?.(ctx.roomId, { ...saved, agent })

    return { responded: true, responseText, agentName: agent.name }
  }
}

// Why this finished response must not be shown, or `null` to persist it. Both
// are races only knowable once the model has finished — hence the late check.
function discardReason(deps: TurnDeps, roomId: number, startedAt: number): string | null {
  if (deps.isSuperseded?.(roomId, startedAt)) return 'superseded by a newer player message'
  if (getRoom(deps.db, roomId)?.isPaused === true) return 'room was paused mid-response'
  return null
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

interface BuildTurnInput {
  /** Null for a plain chat room. See {@link ResponderContext.world}. */
  world: World | null
  agent: Agent
  roomId: number
  locationName: string | null
  userMessage: string
  npcReactions: AgentReaction[] | undefined
  /** NPCs still speaking as this agent starts — a deferred cell of the tape,
   * resolved to names for the prompt. */
  pendingReactions?: { names: string[]; reactions: Promise<AgentReaction[]> }
  chatSessionId: number | null
  timings: SubagentTimings
  /** Send `userMessage` as written instead of building conversation context. */
  skipContext?: boolean
}

// Assembles one agent's prompt, tools and message for a single turn.
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

  const pending = input.pendingReactions
  const reactionsSoFar: NpcReaction[] = [...(input.npcReactions ?? [])]

  const ctx: ToolContext = {
    agentName: agent.name,
    agentId: agent.id,
    configFile: agent.configFile ?? undefined,
    groupName: agent.group ?? undefined,
    roomId: input.roomId,
    // Absent for a chat room; the tools a character is offered read the agent's
    // own folder, not the world.
    worldName: world?.name,
    worldId: world?.id,
    longTermMemoryIndex: config?.longTermMemoryIndex ?? {},
    // The tools share one array with the awaiter below, so a `narration` written
    // after `await_reactions` records the reactions and one written before it
    // records that there were none yet.
    npcReactions: reactionsSoFar,
    awaitNpcReactions: pending
      ? async (): Promise<NpcReaction[]> => {
          const settled = await pending.reactions
          reactionsSoFar.splice(0, reactionsSoFar.length, ...settled)
          return reactionsSoFar
        }
      : undefined,
    getDb: () => db,
  }

  // One role for both the tool set and the sub-agent set: deriving them
  // separately leaves a parent with `mcp__subagents__*` in its allow-list and no
  // sub-agent to hand them to, or the reverse.
  const role: ServerRole = asActionManager
    ? 'action_manager'
    : asOnboardingManager
      ? 'onboarding'
      : 'character'

  // Must bind before the session is acquired; the ordering here guarantees it.
  const servers = deps.mcp.bindTurn({ roomId: input.roomId, agentId: agent.id }, ctx, {
    role,
    configDir: agent.configFile
      ? `${deps.projectRoot}/${agent.configFile}`.replace(/\/+/g, '/')
      : undefined,
  })

  let systemPrompt = systemPromptBase
  let message: string

  if (asActionManager) {
    // Asserted rather than defaulted: a world silently substituted here would
    // produce narration against the wrong one.
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
      pendingReactionNames: pending?.names,
    })
  } else if (input.skipContext) {
    message = input.userMessage
  } else {
    // Characters and the Onboarding Manager read the action out of the room's
    // messages rather than being handed it. The "keep only the latest" filters
    // are a gameplay economy — a game turn needs only the newest narration and
    // player action — but onboarding and chat are ordinary dialogue, where
    // dropping intermediate turns deletes the conversation.
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
      // stands in and the language falls back to the prompt default.
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
      // What the dispatch tool can reach; `undefined` for a character, so its
      // dispatch stays inert. Tool names are passed so a designer whose persist
      // tool this turn does not serve is dropped rather than left with nothing
      // to call, and the settings brief so every designer writes in the world's
      // own language without the dispatching agent having to say so.
      agents: buildSubagentDefinitionsForRole(
        role,
        servers.toolNames,
        worldSettingsBrief(deps, world),
      ),
      hooks,
      resume,
      useSonnet: deps.useSonnet,
    },
    message,
    resume,
  }
}

/**
 * The world's ground rules, as every design sub-agent dispatched this turn will
 * read them. Empty for a chat room, which has no world and so no language of its
 * own to write in.
 *
 * Read from `world.json` rather than from the `worlds` row: the free-text half
 * of the settings — the naming convention, the house rules — has no column, and
 * the filesystem is the source of truth for the rest of it anyway. The service's
 * mtime cache makes this a `stat` on the turns where nothing changed.
 */
function worldSettingsBrief(deps: TurnDeps, world: World | null): string {
  if (world === null) return ''
  const config = deps.services.worlds.loadWorldConfig(world.name)
  if (!config) return ''
  return renderWorldSettingsBrief(toWorldSettings(config))
}

// Gameplay messages (`chat_session_id IS NULL`) are visible to everyone; what is
// filtered out is *other* chat sessions, which the SDK session already
// remembers and would otherwise be replayed into context every turn.
function visibleInSession(messageSession: number | null, turnSession: number | null): boolean {
  if (turnSession === null) return true
  return messageSession === null || messageSession === turnSession
}
