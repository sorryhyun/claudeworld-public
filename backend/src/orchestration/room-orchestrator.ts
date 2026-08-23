import type { World } from '@/db/schema'
import { getLogger } from '@/infrastructure/logging/logger'
import type { SessionPool } from '@/sdk/client/session-pool'
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
 * One turn at a time per room, and a way to stop it. **Interrupting takes two
 * actions in this order:** tell the CLI to stop — {@link
 * SessionPool.interruptRoom} only reaches sessions it finds *busy*, so aborting
 * first leaves subprocesses generating a response nobody awaits — then unwind
 * the local await. The `AbortSignal` ends the turn as interrupted rather than
 * errored, which keeps the warm session alive.
 */

const logger = getLogger('RoomOrchestrator')

const INTERRUPT_TIMEOUT_MS = 5_000

// The seed generator and sub-agents work for tens of seconds with no message
// to stream, so the player is shown a busy row for them instead.
export interface TransientActor {
  name: string
  thinkingText: string
  responseText: string
}

export interface TurnOutcome {
  /** False when the turn was cancelled or threw. */
  completed: boolean
  result?: ExecutionResult
  error?: unknown
  /** Never started: the room was busy. Only background rounds yield this way. */
  skipped?: boolean
}

interface ActiveTurn {
  controller: AbortController
  /** Never rejects: settled with the outcome so waiters cannot be poisoned. */
  done: Promise<TurnOutcome>
}

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

export interface ChatRoomMessageInput {
  roomId: number
  action: string
  /** Agent ids from `@mentions`, or null for everyone in the room. */
  mentionedAgentIds?: number[] | null
}

export class RoomOrchestrator {
  private readonly active = new Map<number, ActiveTurn>()
  // Compared against the moment a response *started*, not the moment it
  // finished: a reply in flight when the next message arrived is superseded.
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

  // Tracked exactly like a world turn: interrupt and supersede are properties
  // of the *room*, not of any world.
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

  // The scheduler's entry point. It takes the room's single in-flight slot, so
  // a user message mid-round interrupts it and the next tick yields.
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

  // The supersede stamp is taken here, not in the caller, so it is set before
  // the first response can start and compare against it.
  private async runTracked(
    roomId: number,
    /** Null for a plain chat room, which belongs to no world. */
    world: World | null,
    run: (signal: AbortSignal) => Promise<ExecutionResult>,
  ): Promise<TurnOutcome> {
    this.lastUserMessageAt.set(roomId, Date.now())
    // Only worlds: `currentWorld()` reads this and a chat room has none.
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
      // Only if still ours: `interruptRoom` removes the entry when it takes
      // over, and the turn started after it must not be cleared here.
      if (this.active.get(roomId) === turn) {
        this.active.delete(roomId)
        this.worldOfRoom.delete(roomId)
      }
      this.clearNarrationProduced(roomId)
    }
  }

  /**
   * Stop whatever this room is doing; safe on an idle room. Returns once the
   * turn unwinds, or after {@link INTERRUPT_TIMEOUT_MS} — a wedged turn must
   * not block the next message.
   */
  async interruptRoom(roomId: number): Promise<void> {
    const turn = this.active.get(roomId)
    this.active.delete(roomId)
    this.worldOfRoom.delete(roomId)

    // Must come before `abort()`, while the sessions are still busy and can be
    // reached; reversing these two silently defeats the interrupt.
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

  // `travel` fires side effects from inside a tool call, which carries only
  // room and location ids; the running turn records its world here.
  private readonly worldOfRoom = new Map<number, World>()

  /** NPCs at a location write memories before the player leaves. */
  async triggerNpcMemoryRound(locationId: number, prompt?: string): Promise<number> {
    const world = this.currentWorld()
    if (!world) {
      logger.warning('Cannot trigger memory round — no turn is running')
      return 0
    }
    return runMemoryRound(this.turnDeps, { world, locationId, prompt })
  }

  /** Warm sessions at a destination. Fire-and-forget: the caller is mid-turn. */
  preConnectLocation(roomId: number, locationId: number): void {
    const world = this.currentWorld()
    if (!world) return
    void preConnectLocation(this.turnDeps, { world, roomId, locationId }).catch((error: unknown) => {
      logger.debug(`Pre-connect failed (non-critical): ${String(error)}`)
    })
  }

  // Keyed by room so concurrent turns cannot read each other's world; returns
  // the only entry, since callers do not always carry a room id.
  private currentWorld(): World | null {
    const [first] = this.worldOfRoom.values()
    return first ?? null
  }

  isBusy(roomId: number): boolean {
    return this.active.has(roomId)
  }

  getChattingAgents(roomId: number): number[] {
    return this.deps.pool.agentsInRoom(roomId)
  }

  /** Drop supersede stamps for rooms idle past `maxAgeSeconds`. */
  cleanupStaleEntries(maxAgeSeconds = 3600): number {
    const cutoff = Date.now() - maxAgeSeconds * 1000
    let removed = 0

    for (const [roomId, at] of [...this.lastUserMessageAt]) {
      // A busy room keeps its stamp at any age: the supersede check is still
      // live for the responses that turn will start.
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

  // Transient status: read by the polling endpoint, which turns each of these
  // into a row the player sees as busy. Never persisted — a restart forgets it.

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
   * Claim the one restart a room's opening scene gets from `/poll` — true the
   * first time, false ever after. Lives here, with the rest of the per-room
   * transient state, so it dies with the process: after a restart the poll is
   * *supposed* to try again, since a restart is what strands an opening in the
   * first place.
   */
  claimOpeningRestart(roomId: number): boolean {
    if (this.openingRestarted.has(roomId)) return false
    this.openingRestarted.add(roomId)
    return true
  }

  private readonly openingRestarted = new Set<number>()

  // Player input unblocks here rather than at turn end: the Action Manager
  // keeps working afterwards with nothing left to wait for.
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
