import type { World } from '../db/schema'
import { getLogger } from '../infrastructure/logging/logger'
import type { SessionPool } from '../sdk/client/session-pool'
import type { ExecutionResult } from './tape/models'
import {
  preConnectLocation,
  runAutonomousRound,
  runChatRoomTurn,
  runChatTurn,
  runGameplayTurn,
  runMemoryRound,
  type TurnDeps,
} from './turn'

/**
 * One turn at a time per room, and a way to stop it.
 *
 * Port of the room-level halves of `orchestration/trpg_orchestrator.py` and
 * `chat_mode_orchestrator.py` — everything those classes did *around* the tape:
 * tracking the in-flight turn so a later message can cancel it, remembering when
 * the player last spoke so a stale reply is discarded rather than shown, and
 * holding the transient per-room status the polling endpoint reports.
 *
 * Python kept two near-identical copies of this, one per mode, differing only in
 * which tape they built. They are one class here because the difference is an
 * argument, not a structure.
 *
 * ## Interrupting
 *
 * Stopping a turn takes two actions, not one, and the order is the opposite of
 * Python's:
 *
 * 1. **Tell the CLI to stop.** {@link SessionPool.interruptRoom} only reaches
 *    sessions it finds *busy*, and a session stops being busy the moment its
 *    local read is unwound. Aborting first would therefore leave every
 *    subprocess quietly generating a response nobody is waiting for.
 * 2. **Unwind the local await.** The `AbortSignal` is what actually ends the
 *    turn from this side: the tape stops advancing and the runner reports the
 *    turn as interrupted rather than errored — which is what keeps the warm
 *    session alive under the "interrupt keeps the session, error kills it" rule.
 *
 * Python could cancel first because `asyncio.Task.cancel()` propagates into the
 * SDK client itself. There is no equivalent here: an `AbortSignal` unwinds our
 * own read and nothing more.
 */

const logger = getLogger('RoomOrchestrator')

/** How long to wait for a cancelled turn to unwind before giving up on it. */
const INTERRUPT_TIMEOUT_MS = 5_000

/**
 * A non-agent actor the player should see as busy.
 *
 * The world seed generator and Task-tool sub-agents do real work for tens of
 * seconds without owning a room agent, so they have no message to stream and
 * would otherwise look like a hang. Python tracked them in two parallel dicts on
 * the orchestrator purely so the polling endpoint could render a "thinking"
 * row; this is those dicts, typed.
 */
export interface TransientActor {
  name: string
  thinkingText: string
  responseText: string
}

export interface TurnOutcome {
  /** False when the turn was cancelled or threw — Python's `False` return. */
  completed: boolean
  result?: ExecutionResult
  error?: unknown
  /**
   * The turn was never started, because the room was already running one.
   *
   * Only {@link RoomOrchestrator.handleAutonomousRound} sets this: a user's
   * message supersedes whatever the room is doing, but a background round must
   * yield to it rather than pile on. Python's scheduler path expresses the same
   * thing by returning early when `room.id in active_room_tasks`.
   */
  skipped?: boolean
}

interface ActiveTurn {
  controller: AbortController
  /** Never rejects: settled with the outcome so waiters cannot be poisoned. */
  done: Promise<TurnOutcome>
}

/**
 * The turn implementations, as a seam.
 *
 * Defaulted to the real ones and overridden only in tests — the same seam the
 * executor opens with its `respond` function, and for the same reason: the
 * interrupt and supersede rules are this class's whole job, and pinning them
 * should not require a live model and a CLI subprocess.
 */
export interface TurnImplementations {
  gameplay: typeof runGameplayTurn
  chat: typeof runChatTurn
  /** Plain chat rooms — no world, no location, follow-up rounds. */
  chatRoom: typeof runChatRoomTurn
  /** One follow-up round with no user message, driven by the scheduler. */
  autonomousRound: typeof runAutonomousRound
}

export interface RoomOrchestratorDeps extends Omit<TurnDeps, 'isSuperseded'> {
  pool: SessionPool
  /** Partial: a test overriding one turn shape keeps the real ones for the rest. */
  turns?: Partial<TurnImplementations>
}

export interface PlayerActionInput {
  world: World
  roomId: number
  action: string
}

export interface ChatMessageInput extends PlayerActionInput {
  chatSessionId: number | null
}

/** A message in a plain chat room, which has no world to act on. */
export interface ChatRoomMessageInput {
  roomId: number
  action: string
  /** Agent ids from `@mentions`, or null for everyone in the room. */
  mentionedAgentIds?: number[] | null
}

export class RoomOrchestrator {
  private readonly active = new Map<number, ActiveTurn>()
  /**
   * When the player last spoke in each room.
   *
   * Compared against the moment a response *started*, not the moment it
   * finished: a reply already in flight when the next message arrived is
   * answering a question the player has moved past.
   */
  private readonly lastUserMessageAt = new Map<number, number>()
  private readonly seedGeneration = new Map<number, TransientActor>()
  private readonly subAgents = new Map<number, TransientActor>()
  private readonly narrationProduced = new Set<number>()

  private readonly turnDeps: TurnDeps
  private readonly turns: TurnImplementations

  constructor(private readonly deps: RoomOrchestratorDeps) {
    this.turns = {
      gameplay: runGameplayTurn,
      chat: runChatTurn,
      chatRoom: runChatRoomTurn,
      autonomousRound: runAutonomousRound,
      ...deps.turns,
    }
    this.turnDeps = {
      ...deps,
      isSuperseded: (roomId, startedAt) => (this.lastUserMessageAt.get(roomId) ?? 0) > startedAt,
    }
  }

  // ==========================================================================
  // Turns
  // ==========================================================================

  /** Run a player action: the gameplay tape, or the onboarding one. */
  async handlePlayerAction(input: PlayerActionInput): Promise<TurnOutcome> {
    logger.info(
      `[Turn] Player action | Room: ${input.roomId} | Action: ${input.action.slice(0, 50)}...`,
    )
    return this.runTracked(input.roomId, input.world, (signal) =>
      this.turns.gameplay(this.turnDeps, {
        world: input.world,
        roomId: input.roomId,
        action: input.action,
        signal,
      }),
    )
  }

  /** Run a player message in chat mode. */
  async handleChatMessage(input: ChatMessageInput): Promise<TurnOutcome> {
    logger.info(
      `[ChatMode] Message | Room: ${input.roomId} | Session: ${String(input.chatSessionId)} | ` +
        `Text: ${input.action.slice(0, 50)}...`,
    )
    return this.runTracked(input.roomId, input.world, (signal) =>
      this.turns.chat(this.turnDeps, {
        world: input.world,
        roomId: input.roomId,
        action: input.action,
        chatSessionId: input.chatSessionId,
        signal,
      }),
    )
  }

  /**
   * Run a user message in a plain chat room.
   *
   * Tracked exactly like a world turn — same interrupt path, same supersede
   * rule — because the reasons for both are properties of the *room*, not of
   * the world it may or may not belong to.
   */
  async handleChatRoomMessage(input: ChatRoomMessageInput): Promise<TurnOutcome> {
    logger.info(
      `[ChatRoom] Message | Room: ${input.roomId} | Text: ${input.action.slice(0, 50)}...`,
    )
    return this.runTracked(input.roomId, null, (signal) =>
      this.turns.chatRoom(this.turnDeps, {
        roomId: input.roomId,
        action: input.action,
        mentionedAgentIds: input.mentionedAgentIds,
        signal,
      }),
    )
  }

  /**
   * Run one autonomous follow-up round — the background scheduler's entry point.
   *
   * Tracked exactly like every other turn, which is the point: it takes the
   * room's single in-flight slot, so a user message arriving mid-round finds a
   * busy room and interrupts it through the normal path, and the *next* tick
   * finds the user's turn in flight and yields.
   *
   * Returns `{ completed: false, skipped: true }` without touching the room when
   * a turn is already running. Python returns `True` there — "keep scheduling
   * this room" — which is the same decision phrased as a continuation flag.
   */
  async handleAutonomousRound(roomId: number): Promise<TurnOutcome> {
    if (this.active.has(roomId)) {
      logger.debug(`[Autonomous] Room ${roomId} is already processing, skipping`)
      return { completed: false, skipped: true }
    }

    logger.info(`[Autonomous] Round | Room: ${roomId}`)
    return this.runTracked(roomId, null, (signal) =>
      this.turns.autonomousRound(this.turnDeps, { roomId, signal }),
    )
  }

  /**
   * Stamp the room, start the turn, and keep a handle on it.
   *
   * The timestamp is taken here rather than in the caller so that it is always
   * set *before* the first response can start — otherwise a very fast NPC could
   * finish, compare against a stamp that had not been written yet, and be kept
   * when it should have been discarded.
   */
  private async runTracked(
    roomId: number,
    /** Null for a plain chat room, which belongs to no world. */
    world: World | null,
    run: (signal: AbortSignal) => Promise<ExecutionResult>,
  ): Promise<TurnOutcome> {
    this.lastUserMessageAt.set(roomId, Date.now())
    // Only worlds go in the map — `currentWorld()` reads it to find a world to
    // run a memory round against, and a chat room has none to offer.
    if (world !== null) this.worldOfRoom.set(roomId, world)

    const controller = new AbortController()
    const done = run(controller.signal).then(
      (result): TurnOutcome => ({ completed: true, result }),
      (error: unknown): TurnOutcome => {
        if (controller.signal.aborted) {
          logger.info(`[Turn] Processing cancelled | Room: ${roomId}`)
          return { completed: false }
        }
        logger.exception(`[Turn] Error processing | Room: ${roomId}`, error)
        return { completed: false, error }
      },
    )

    const turn: ActiveTurn = { controller, done }
    this.active.set(roomId, turn)

    try {
      const outcome = await done
      if (outcome.result) {
        logger.info(
          `[Turn] Complete | Room: ${roomId} | Responses: ${outcome.result.totalResponses} | ` +
            `Skips: ${outcome.result.totalSkips}`,
        )
      }
      return outcome
    } finally {
      // Only if it is still ours: `interruptRoom` removes the entry when it
      // takes over, and a turn started after that must not be cleared by this
      // one's unwinding.
      if (this.active.get(roomId) === turn) {
        this.active.delete(roomId)
        this.worldOfRoom.delete(roomId)
      }
      this.clearNarrationProduced(roomId)
    }
  }

  /**
   * Stop whatever this room is doing. Safe to call on an idle room.
   *
   * Returns once the in-flight turn has unwound, or after
   * {@link INTERRUPT_TIMEOUT_MS} if it will not — a wedged turn must not block
   * the player's next message forever.
   */
  async interruptRoom(roomId: number): Promise<void> {
    const turn = this.active.get(roomId)
    this.active.delete(roomId)
    this.worldOfRoom.delete(roomId)

    // First, while the sessions are still busy and can be reached. See the
    // class comment: reversing these two lines silently defeats the interrupt.
    const stillQueued = await this.deps.pool.interruptRoom(roomId)
    if (stillQueued.length > 0) {
      logger.warning(
        `[Turn] Interrupt left ${stillQueued.length} message(s) queued | Room: ${roomId}`,
      )
    }

    if (!turn) return

    turn.controller.abort()
    await Promise.race([
      turn.done,
      new Promise((resolve) => setTimeout(resolve, INTERRUPT_TIMEOUT_MS)),
    ])
  }

  // ==========================================================================
  // Turn side effects
  //
  // Both are fired by the `travel` tool, which reaches them through
  // `ServerDeps.status` rather than importing this class — the SDK layer must
  // not depend on orchestration. Both need the world, which a tool handler does
  // not carry, so it is remembered per room by the turn that is running.
  // ==========================================================================

  /**
   * The world each room's current turn belongs to.
   *
   * `travel` fires its side effects from inside a tool call, where the only
   * identifiers to hand are room and location ids. Rather than widening the
   * tool context to carry a whole world row, the turn that is running records
   * it here and the side effects look it up. Cleared with the turn.
   */
  private readonly worldOfRoom = new Map<number, World>()

  /**
   * Give the NPCs at a location a turn to write memories before the player
   * leaves it. Returns how many ran.
   */
  async triggerNpcMemoryRound(locationId: number, prompt?: string): Promise<number> {
    const world = this.currentWorld()
    if (!world) {
      logger.warning('Cannot trigger memory round — no turn is running')
      return 0
    }
    return runMemoryRound(this.turnDeps, { world, locationId, prompt })
  }

  /**
   * Warm sessions for the characters at a destination. Fire-and-forget: the
   * caller is a tool handler mid-turn and must not wait on it.
   */
  preConnectLocation(roomId: number, locationId: number): void {
    const world = this.currentWorld()
    if (!world) return
    void preConnectLocation(this.turnDeps, { world, roomId, locationId }).catch((error: unknown) => {
      logger.debug(`Pre-connect failed (non-critical): ${String(error)}`)
    })
  }

  /**
   * The world of the single in-flight turn.
   *
   * Python read this off `self._current_orch_context`, a single slot on the
   * orchestrator — so two rooms taking turns at once would have read each
   * other's world. The map is keyed by room for that reason, and this returns
   * the only entry: a tool handler knows its room id but the *side effect* it
   * fires does not always carry one, and every caller today is inside one turn.
   */
  private currentWorld(): World | null {
    const [first] = this.worldOfRoom.values()
    return first ?? null
  }

  /** Is a turn in flight in this room? */
  isBusy(roomId: number): boolean {
    return this.active.has(roomId)
  }

  /** Agent ids with a live session in this room — Python's `get_chatting_agents`. */
  getChattingAgents(roomId: number): number[] {
    return this.deps.pool.agentsInRoom(roomId)
  }

  /**
   * Drop supersede stamps for rooms nobody has spoken in for an hour.
   *
   * Port of the surviving half of `ChatOrchestrator.cleanup_stale_entries`,
   * called by the scheduler's five-minute sweep. Python also swept completed
   * entries out of `active_room_tasks`; there is nothing to sweep here, because
   * {@link runTracked} removes its own entry in a `finally` rather than leaving
   * a settled task in the map.
   *
   * Returns how many stamps were removed, matching Python's count.
   */
  cleanupStaleEntries(maxAgeSeconds = 3600): number {
    const cutoff = Date.now() - maxAgeSeconds * 1000
    let removed = 0

    for (const [roomId, at] of [...this.lastUserMessageAt]) {
      // A room with a turn in flight keeps its stamp whatever its age: the
      // supersede check is still live for the responses that turn will start.
      if (at > cutoff || this.active.has(roomId)) continue
      this.lastUserMessageAt.delete(roomId)
      removed++
    }

    if (removed > 0) logger.info(`Cleaned up ${removed} stale orchestrator entr(ies)`)
    return removed
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.keys()].map((roomId) => this.interruptRoom(roomId)))
  }

  // ==========================================================================
  // Transient status
  //
  // Read by the polling endpoint, which turns each of these into a row the
  // player sees as busy. None of it is persisted: it describes what is happening
  // right now in this process, and a restart legitimately forgets it.
  // ==========================================================================

  setSeedGenerationActive(roomId: number, name = 'World Seed Generator'): void {
    this.seedGeneration.set(roomId, {
      name,
      thinkingText: 'Creating your world...',
      responseText: '',
    })
    logger.info(`[Turn] Seed generation started | Room: ${roomId}`)
  }

  setSeedGenerationInactive(roomId: number): void {
    if (this.seedGeneration.delete(roomId)) {
      logger.info(`[Turn] Seed generation complete | Room: ${roomId}`)
    }
  }

  getSeedGenerationStatus(roomId: number): TransientActor | null {
    return this.seedGeneration.get(roomId) ?? null
  }

  setSubAgentActive(roomId: number, name: string, thinkingText = ''): void {
    this.subAgents.set(roomId, {
      name,
      thinkingText: thinkingText || `${name} is processing...`,
      responseText: '',
    })
    logger.info(`[Turn] Sub-agent active | Room: ${roomId} | Agent: ${name}`)
  }

  setSubAgentInactive(roomId: number): void {
    if (this.subAgents.delete(roomId)) {
      logger.info(`[Turn] Sub-agent complete | Room: ${roomId}`)
    }
  }

  getSubAgentStatus(roomId: number): TransientActor | null {
    return this.subAgents.get(roomId) ?? null
  }

  /**
   * The `narration` tool has written this turn's visible message.
   *
   * The player's input is unblocked on this rather than on the turn ending,
   * because the Action Manager keeps working afterwards — updating stats,
   * suggesting options — and there is nothing left to wait for once the prose is
   * on screen. Cleared when the turn ends, in {@link runTracked}.
   */
  setNarrationProduced(roomId: number): void {
    this.narrationProduced.add(roomId)
    logger.info(`[Turn] Narration produced | Room: ${roomId}`)
  }

  clearNarrationProduced(roomId: number): void {
    this.narrationProduced.delete(roomId)
  }

  hasNarrationProduced(roomId: number): boolean {
    return this.narrationProduced.has(roomId)
  }
}
