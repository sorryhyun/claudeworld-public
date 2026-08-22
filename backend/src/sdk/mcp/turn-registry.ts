import { sessionKeyOf, type SessionKey } from '../client/session'
import type { TurnBinding } from '../handlers/servers'

/**
 * What each (room, agent) is currently doing, for the MCP endpoint to read.
 *
 * This is the replacement for the closure the in-process servers used to hold.
 * A tool call arrives over HTTP carrying only `/:roomId/:agentId/:server`, so
 * everything the handlers need — the room, the world, this turn's NPC
 * reactions, the database getter — has to be findable from that pair. The
 * orchestrator writes the binding as a turn starts; the endpoint reads whatever
 * is current when the call lands.
 *
 * Keyed by {@link sessionKeyOf}, deliberately: a binding's lifetime is a warm
 * Claude session's lifetime, and sharing the key is what lets `SessionPool`
 * evict both together without either side knowing the other's shape.
 *
 * ## Bindings are overwritten, never cleared at turn end
 *
 * A sub-agent spawned through the `Task` tool can still call back *after* its
 * parent turn's `result` message — `AgentSession`'s background pump exists for
 * exactly that (see `sdk/client/session.ts`). Clearing on turn end would race
 * that call and answer it with a 409. Last write wins instead: the next turn
 * for the same agent replaces the binding, and eviction removes it.
 *
 * That the *previous* turn's binding is what a late sub-agent call resolves
 * against is correct, not a leak — it is the turn that spawned it.
 */
export class TurnRegistry {
  private readonly bindings = new Map<string, TurnBinding>()

  get size(): number {
    return this.bindings.size
  }

  /** Make this binding current for the (room, agent). Replaces any previous one. */
  bind(key: SessionKey, binding: TurnBinding): void {
    this.bindings.set(sessionKeyOf(key), binding)
  }

  get(key: SessionKey): TurnBinding | undefined {
    return this.bindings.get(sessionKeyOf(key))
  }

  /**
   * Drop a binding by its session key string.
   *
   * Takes the string rather than a {@link SessionKey} because the caller is
   * `SessionPool.evict`, which works in the same string form and would
   * otherwise have to parse a key it had just built.
   */
  release(id: string): void {
    this.bindings.delete(id)
  }

  clear(): void {
    this.bindings.clear()
  }
}
