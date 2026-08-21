import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { AgentSession, parseSessionKey, sessionKeyOf, type SessionKey } from './session'

/**
 * One warm Claude session per (room, agent), reused across turns.
 *
 * Port of `sdk/client/client_pool.py`. The pool exists for latency: opening a
 * session spawns a CLI subprocess and hands it a system prompt, several
 * in-process MCP servers, hooks and sub-agent definitions. A gameplay turn fans
 * out to every NPC at the player's location plus the Action Manager, so paying
 * that cost per turn would multiply it by the size of the cast.
 *
 * Two rules are inherited deliberately from Python:
 *
 * - **No idle eviction.** Sessions live until something explicitly removes them.
 *   A player idling in a tavern should not have to re-warm the room's NPCs.
 * - **Interrupt keeps the session; an error kills it.** A player interrupting
 *   their own turn is routine and must not cost the warm subprocess. An error
 *   leaves the CLI in an unknown state, so the session is discarded and the next
 *   turn reopens with `resume`.
 */
export class SessionPool {
  private readonly sessions = new Map<string, AgentSession>()
  /** Serializes concurrent opens for the same key (double-checked locking). */
  private readonly opening = new Map<string, Promise<AgentSession>>()

  /**
   * Caps simultaneous CLI spawns. Python used a semaphore of 10 for the same
   * reason: a location with a large cast would otherwise try to spawn one
   * subprocess per NPC at once.
   */
  constructor(private readonly maxConcurrentConnections = 10) {}

  private inFlightConnects = 0
  private readonly connectWaiters: Array<() => void> = []

  get size(): number {
    return this.sessions.size
  }

  get keys(): string[] {
    return [...this.sessions.keys()]
  }

  /**
   * Get the warm session for this key, or open one.
   *
   * Reopens when either the fingerprint or the resume target has changed. Both
   * are baked in at `query()` time and cannot be mutated afterwards, so reuse
   * with stale values would silently run the turn under the wrong system prompt
   * or the wrong conversation.
   */
  async acquire(key: SessionKey, options: Options, fingerprint: string): Promise<AgentSession> {
    const id = sessionKeyOf(key)
    const resume = options.resume

    const existing = this.sessions.get(id)
    if (existing && this.isReusable(existing, fingerprint, resume)) return existing
    if (existing) await this.evict(id)

    const pending = this.opening.get(id)
    if (pending) return pending

    const open = this.openSession(id, options, fingerprint, resume).finally(() => {
      this.opening.delete(id)
    })
    this.opening.set(id, open)
    return open
  }

  private isReusable(session: AgentSession, fingerprint: string, resume: string | undefined): boolean {
    if (session.isDead || session.busy) return false
    if (session.fingerprint !== fingerprint) return false
    // A virgin stream carries only the conversation it resumed; once it has run
    // a turn, the id it reports is the authority and the caller's `resume` value
    // is just a stale copy of it.
    return session.turnsProcessed === 0
      ? resume === session.openedWithResume
      : resume === undefined || resume === session.sessionId
  }

  private async openSession(
    id: string,
    options: Options,
    fingerprint: string,
    resume: string | undefined,
  ): Promise<AgentSession> {
    await this.acquireConnectSlot()
    try {
      const session = new AgentSession(id, fingerprint, resume, options)
      this.sessions.set(id, session)
      return session
    } finally {
      this.releaseConnectSlot()
    }
  }

  private async acquireConnectSlot(): Promise<void> {
    if (this.inFlightConnects < this.maxConcurrentConnections) {
      this.inFlightConnects++
      return
    }
    await new Promise<void>((resolve) => this.connectWaiters.push(resolve))
    this.inFlightConnects++
  }

  private releaseConnectSlot(): void {
    this.inFlightConnects--
    this.connectWaiters.shift()?.()
  }

  /**
   * Agent ids with a live session in this room.
   *
   * Port of `get_chatting_agents`, which walked `AgentManager.active_clients`
   * and matched on `task_id.room_id`. The polling endpoint reports these as the
   * agents currently "in" the room, so it is deliberately *presence*, not
   * busyness: an NPC whose session is warm but idle is still part of the scene.
   */
  agentsInRoom(roomId: number): number[] {
    return this.keys
      .map(parseSessionKey)
      .filter((key): key is SessionKey => key?.roomId === roomId)
      .map((key) => key.agentId)
  }

  /**
   * Every live session belonging to one agent, across all its rooms.
   *
   * Port of `ClientPool.get_keys_for_agent`. Parsing rather than substring
   * matching matters here: agent 3 owns `room_12_agent_3`, and a naive search
   * for `3` would also claim `room_3_agent_12`.
   */
  keysForAgent(agentId: number): string[] {
    return this.keys.filter((key) => parseSessionKey(key)?.agentId === agentId)
  }

  /** Close every session belonging to an agent — the agent is being deleted. */
  async evictAgent(agentId: number): Promise<void> {
    await Promise.all(this.keysForAgent(agentId).map((k) => this.evict(k)))
  }

  /** Drop and close one session. Safe to call for an absent key. */
  async evict(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.close()
  }

  async evictKey(key: SessionKey): Promise<void> {
    await this.evict(sessionKeyOf(key))
  }

  /** Close every session belonging to a room — world reset, room deletion. */
  async evictRoom(roomId: number): Promise<void> {
    const prefix = `room_${roomId}_agent_`
    await Promise.all(this.keys.filter((k) => k.startsWith(prefix)).map((k) => this.evict(k)))
  }

  /**
   * Interrupt every in-flight turn in a room, leaving the sessions warm.
   *
   * Returns the ids the CLI reported as still queued. An empty list is not proof
   * of quiet — messages enqueued without a uuid are never listed — so callers
   * should treat it as best-effort rather than a guarantee.
   */
  async interruptRoom(roomId: number): Promise<string[]> {
    const prefix = `room_${roomId}_agent_`
    const receipts = await Promise.all(
      this.keys
        .filter((k) => k.startsWith(prefix))
        .map((k) => this.sessions.get(k))
        .filter((s): s is AgentSession => s !== undefined && s.busy)
        .map((s) => s.interrupt()),
    )
    return receipts.flatMap((r) => r.stillQueued)
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.keys.map((k) => this.evict(k)))
  }
}
