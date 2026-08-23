/**
 * Deletions that reach further than the database: a `crud/` delete plus eviction
 * of the warm Claude sessions it invalidated. Skipping the eviction is a
 * correctness bug — a `SessionPool` entry outlives its row, and the next turn
 * for a *recycled* SQLite rowid gets a subprocess still holding the previous
 * agent's prompt.
 *
 * **Ordering: interrupt, delete, evict** — interrupting later leaves a window
 * where an in-flight turn's `createMessage` hits a dangling foreign key. **A
 * failed eviction never fails the operation,** since the row is already gone and
 * retrying would 404; each is isolated so one wedged subprocess strands nothing.
 */


import { invalidateRoomCache } from '@/crud/cache-invalidation'
import { deleteAgent } from '@/crud/agents'
import { deleteRoomMessages } from '@/crud/messages'
import { deleteRoom, getAgentsInRoom, removeAgentFromRoom } from '@/crud/rooms'
import type { Db } from '@/db'
import { deleteRoomAgentSessions } from '@/crud/sessions'
import { getLogger } from '@/infrastructure/logging/logger'
import { sessionKeyOf } from '@/sdk/client/session'
import type { SessionPool } from '@/sdk/client/session-pool'

const logger = getLogger('AgentService')

/** A seam: depending on the one method avoids a cycle with `RoomOrchestrator`. */
export interface RoomInterrupter {
  interruptRoom(roomId: number): Promise<void>
}

export class AgentService {
  /**
   * @param orchestrator Interrupts an in-flight turn before its room is
   *   dismantled. Optional: omitting it only warns, since a room the user asked
   *   to delete has to go away regardless.
   */
  constructor(
    private readonly pool: SessionPool,
    private readonly orchestrator: RoomInterrupter | null = null,
  ) {}

  /** `false` when it did not exist. Eviction is by *agent*: it may be in many rooms. */
  async deleteAgentWithCleanup(db: Db, agentId: number): Promise<boolean> {
    if (!deleteAgent(db, agentId)) return false

    for (const key of this.pool.keysForAgent(agentId)) {
      await this.evictQuietly(key, `agent ${agentId}`)
    }

    return true
  }

  /** `false` when the membership did not exist. Other rooms stay warm. */
  async removeAgentFromRoomWithCleanup(db: Db, roomId: number, agentId: number): Promise<boolean> {
    if (!removeAgentFromRoom(db, roomId, agentId)) return false

    await this.evictQuietly(sessionKeyOf({ roomId, agentId }), `room ${roomId}`)
    return true
  }

  /**
   * `pool.evictRoom` scans by key prefix, so it needs no pre-read of the
   * membership (which cascades away with the room).
   */
  async deleteRoomWithCleanup(db: Db, roomId: number): Promise<boolean> {
    if (this.orchestrator) {
      try {
        logger.info(`Cleaning up orchestrator state for room ${roomId}`)
        await this.orchestrator.interruptRoom(roomId)
      } catch (error) {
        logger.error(`Error cleaning orchestrator state for room ${roomId}: ${String(error)}`)
      }
    } else {
      logger.warning(
        `No orchestrator provided for room ${roomId} deletion - state may leak`,
      )
    }

    if (!deleteRoom(db, roomId)) return false

    await this.evictRoomQuietly(roomId)

    logger.info(`Room ${roomId} deleted successfully`)
    return true
  }

  /**
   * Wipe a room's transcript and make its agents forget it. Messages alone are
   * not enough: each `room_agent_sessions` row points at a CLI conversation
   * still holding them, which the next turn would `resume`.
   */
  async clearRoomMessagesWithCleanup(db: Db, roomId: number): Promise<boolean> {
    const agents = getAgentsInRoom(db, roomId)
    logger.info(`Clearing room ${roomId} messages | Agents: ${agents.length}`)

    if (this.orchestrator) {
      try {
        logger.info(`Interrupting room ${roomId} processing before clearing messages`)
        await this.orchestrator.interruptRoom(roomId)
      } catch (error) {
        logger.error(`Error interrupting room ${roomId}: ${String(error)}`)
      }
    }

    if (!deleteRoomMessages(db, roomId)) return false
    logger.info(`Deleted all messages from room ${roomId}`)

    deleteRoomAgentSessions(db, roomId)
    logger.info(`Cleared all session IDs for room ${roomId}`)

    await this.evictRoomQuietly(roomId)

    // `deleteRoomMessages` does not sweep its own cache; without this the poll
    // would keep serving the deleted transcript for a TTL.
    invalidateRoomCache(roomId)
    logger.info(`Invalidated room ${roomId} cache after clearing messages`)

    logger.info(`Room ${roomId} cleared successfully`)
    return true
  }

  private async evictQuietly(key: string, context: string): Promise<void> {
    try {
      await this.pool.evict(key)
      logger.info(`Cleaned up session ${key} for ${context}`)
    } catch (error) {
      logger.error(`Error cleaning up session ${key} for ${context}: ${String(error)}`)
    }
  }

  private async evictRoomQuietly(roomId: number): Promise<void> {
    try {
      await this.pool.evictRoom(roomId)
      logger.info(`Cleaned up sessions for room ${roomId}`)
    } catch (error) {
      logger.error(`Error cleaning up sessions for room ${roomId}: ${String(error)}`)
    }
  }
}

