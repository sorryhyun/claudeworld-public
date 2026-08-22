import { sessionKeyOf, type SessionKey } from '../client/session'
import type { TurnBinding } from '../handlers/servers'

/**
 * What each (room, agent) is currently doing, for the MCP endpoint to read: a
 * tool call carries only `/:roomId/:agentId/:server`. Keyed by
 * {@link sessionKeyOf} so `SessionPool` evicts a binding with its session.
 *
 * **Bindings are overwritten, never cleared at turn end.** A dispatched
 * sub-agent can call back *after* its parent turn's `result`, and clearing
 * would race that call into a 409.
 */
export class TurnRegistry {
  private readonly bindings = new Map<string, TurnBinding>()

  get size(): number {
    return this.bindings.size
  }

  bind(key: SessionKey, binding: TurnBinding): void {
    this.bindings.set(sessionKeyOf(key), binding)
  }

  get(key: SessionKey): TurnBinding | undefined {
    return this.bindings.get(sessionKeyOf(key))
  }

  /** Takes the string form `SessionPool.evict` already holds. */
  release(id: string): void {
    this.bindings.delete(id)
  }

  clear(): void {
    this.bindings.clear()
  }
}
