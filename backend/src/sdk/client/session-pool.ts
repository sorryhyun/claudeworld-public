import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { AgentSession, parseSessionKey, sessionKeyOf, type SessionKey } from './session'

/**
 * One warm Claude session per (room, agent), reused across turns — opening one
 * spawns a CLI subprocess, and a gameplay turn fans out to the whole cast. Two
 * lifecycle rules: **no idle eviction**, so sessions live until something removes
 * them; and **interrupt keeps the session, an error kills it**, since an error
 * leaves the CLI in an unknown state and the next turn must `resume` a fresh one.
 */
/** What `GET /auth/health/pool` reports. */
export interface SessionPoolStats {
  poolSize: number
  poolKeys: string[]
  pendingCleanupTasks: number
  activeClients: number
  connectionSemaphoreAvailable: number
  maxConcurrentConnections: number
}

export class SessionPool {
  private readonly sessions = new Map<string, AgentSession>()
  /** Serializes concurrent opens for the same key (double-checked locking). */
  private readonly opening = new Map<string, Promise<AgentSession>>()

  /** `maxConcurrentConnections` caps simultaneous CLI spawns, which a large cast
   * would otherwise make one-per-NPC. The MCP turn registry hangs off `onEvict` —
   * a binding shares the session's key, so the two must die together or the
   * endpoint keeps answering for an agent with no subprocess. The one exception
   * is `acquire`'s reopen, which replaces a session under a key whose binding is
   * the incoming turn's; see there. */
  constructor(
    private readonly maxConcurrentConnections = 10,
    private readonly onEvict?: (id: string) => void,
  ) {}

  private inFlightConnects = 0
  private readonly connectWaiters: Array<() => void> = []

  get size(): number {
    return this.sessions.size
  }

  get keys(): string[] {
    return [...this.sessions.keys()]
  }

  /** Reopens when the fingerprint or the resume target changed: both are baked in
   * at `query()` time, so stale reuse runs the turn under the wrong prompt. */
  async acquire(key: SessionKey, options: Options, fingerprint: string): Promise<AgentSession> {
    const id = sessionKeyOf(key)
    const resume = options.resume

    const existing = this.sessions.get(id)
    if (existing && this.isReusable(existing, fingerprint, resume)) return existing
    // A *reopen*, not an eviction, so `onEvict` stays silent: the caller bound
    // this key's turn moments ago — `McpTools.bindTurn` runs before `acquire`,
    // deliberately — and releasing here would drop that binding on the floor.
    // The session about to open connects its MCP servers at startup, so it
    // would land on the endpoint's 409 and lose every tool for its whole life.
    // The binding in the registry belongs to the turn being opened, not to the
    // session being replaced, and both wear the same key.
    if (existing) await this.evict(id, { releaseBinding: false })

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
    // A virgin stream carries only the conversation it resumed; once it has run a
    // turn, the id it reports is the authority and `resume` is a stale copy.
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

  // `pendingCleanupTasks` is always 0 — `evict` awaits teardown — and
  // `activeClients` counts *busy* sessions.
  stats(): SessionPoolStats {
    return {
      poolSize: this.sessions.size,
      poolKeys: this.keys,
      pendingCleanupTasks: 0,
      activeClients: [...this.sessions.values()].filter((s) => s.busy).length,
      connectionSemaphoreAvailable: this.maxConcurrentConnections - this.inFlightConnects,
      maxConcurrentConnections: this.maxConcurrentConnections,
    }
  }

  // Deliberately *presence*, not busyness: a warm but idle NPC is still in scene.
  agentsInRoom(roomId: number): number[] {
    return this.keys
      .map(parseSessionKey)
      .filter((key): key is SessionKey => key?.roomId === roomId)
      .map((key) => key.agentId)
  }

  // Parsed, not substring-matched: a search for agent `3` would also claim
  // `room_3_agent_12`.
  keysForAgent(agentId: number): string[] {
    return this.keys.filter((key) => parseSessionKey(key)?.agentId === agentId)
  }

  async evictAgent(agentId: number): Promise<void> {
    await Promise.all(this.keysForAgent(agentId).map((k) => this.evict(k)))
  }

  /** Safe to call for an absent key. `releaseBinding: false` is the reopen in
   * `acquire` and nothing else — see the comment there. */
  async evict(id: string, options: { releaseBinding?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    // Before the close, not after: closing awaits the subprocess, and an in-flight
    // tool call must not resolve a binding for a session on its way out.
    if (options.releaseBinding !== false) this.onEvict?.(id)
    await session.close()
  }

  async evictKey(key: SessionKey): Promise<void> {
    await this.evict(sessionKeyOf(key))
  }

  async evictRoom(roomId: number): Promise<void> {
    const prefix = `room_${roomId}_agent_`
    await Promise.all(this.keys.filter((k) => k.startsWith(prefix)).map((k) => this.evict(k)))
  }

  /** Leaves the sessions warm. Returns the ids the CLI reported as still queued;
   * an empty list is not proof of quiet, since messages enqueued without a uuid
   * are never listed. */
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
