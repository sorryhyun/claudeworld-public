/**
 * Deletions that have to reach further than the database.
 *
 * Ported from `backend/services/agent_service.py`.
 *
 * Every operation here is a `crud/` delete plus the eviction of whatever warm
 * Claude sessions that delete invalidated. Skipping the second half is not a
 * leak so much as a correctness bug: a `SessionPool` entry outlives its row, and
 * the next turn for a *recycled* SQLite rowid would be served by a subprocess
 * still holding the previous agent's system prompt and conversation.
 *
 * Nothing here reaches for a global. The pool — and the orchestrator, where a
 * room-level interrupt is needed — are constructor arguments, so a test drives
 * the real logic against a stub and the wiring lives in one place at startup.
 * Python threaded an `AgentManager` through every call signature instead.
 *
 * ## Ordering
 *
 * Interrupt first, delete second, evict last. The interrupt is what stops an
 * in-flight turn from writing a message into a room that is about to disappear;
 * doing it after the delete leaves a window in which the turn's `createMessage`
 * hits a foreign key that has already gone.
 *
 * ## Failure handling
 *
 * A failed eviction never fails the operation. The row is already gone by then,
 * so raising would report a delete that in fact happened, and the caller's only
 * possible response — retry — would 404. Each eviction is therefore isolated so
 * one wedged subprocess does not strand the rest of the room's sessions.
 */


import { invalidateRoomCache } from '../crud/cached'
import { deleteAgent } from '../crud/agents'
import { deleteRoomMessages } from '../crud/messages'
import { deleteRoom, getAgentsInRoom, removeAgentFromRoom } from '../crud/rooms'
import type { Db } from '../db'
import { deleteRoomAgentSessions } from '../crud/sessions'
import { getLogger } from '../infrastructure/logging/logger'
import { sessionKeyOf } from '../sdk/client/session'
import type { SessionPool } from '../sdk/client/session-pool'

const logger = getLogger('AgentService')

/**
 * The room-level half of the orchestrator, as a seam.
 *
 * Only `interruptRoom` is needed, and depending on the one method rather than on
 * `RoomOrchestrator` keeps this module out of the orchestration layer's import
 * graph — the two would otherwise reference each other through the app wiring.
 *
 * Python's two entry points differ in whether they pass a `chat_orchestrator`
 * and in `save_partial_responses`; both of the call sites ported here pass
 * `False` for the latter (`agent_service.py:98`, `:148`), and this port has no
 * partial-response persistence at all, so there is nothing for the flag to
 * select between.
 */
export interface RoomInterrupter {
  interruptRoom(roomId: number): Promise<void>
}

export class AgentService {
  /**
   * @param pool The SDK session pool, for eviction.
   * @param orchestrator Room orchestrator, for interrupting an in-flight turn
   *   before its room is dismantled. Optional, matching Python's optional
   *   `chat_orchestrator` — omitting it logs a warning and lets the delete
   *   proceed, because a room the user asked to delete must go away even when
   *   the orchestrator is not wired up.
   */
  constructor(
    private readonly pool: SessionPool,
    private readonly orchestrator: RoomInterrupter | null = null,
  ) {}

  /**
   * Delete an agent everywhere. `false` when it did not exist.
   *
   * The agent may be a member of several rooms, each with its own warm session,
   * so eviction is by *agent* rather than by room —
   * `SessionPool.keysForAgent`, the port of `ClientPool.get_keys_for_agent`.
   */
  async deleteAgentWithCleanup(db: Db, agentId: number): Promise<boolean> {
    if (!deleteAgent(db, agentId)) return false

    for (const key of this.pool.keysForAgent(agentId)) {
      await this.evictQuietly(key, `agent ${agentId}`)
    }

    return true
  }

  /**
   * Remove an agent from one room. `false` when the membership did not exist.
   *
   * Only that room's session goes; the agent's sessions in other rooms are a
   * different conversation and stay warm.
   */
  async removeAgentFromRoomWithCleanup(db: Db, roomId: number, agentId: number): Promise<boolean> {
    if (!removeAgentFromRoom(db, roomId, agentId)) return false

    await this.evictQuietly(sessionKeyOf({ roomId, agentId }), `room ${roomId}`)
    return true
  }

  /**
   * Delete a room, its transcript and every session belonging to it.
   *
   * Python reads the room's membership *before* the delete — `room_agents`
   * cascades away with the room, so the ids are unrecoverable afterwards — and
   * then evicts one key per agent it saw. `pool.evictRoom` scans by key prefix
   * instead, which needs no pre-read and is a strict superset: a session opened
   * by a turn that started between Python's read and its delete is missed there
   * and caught here.
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
   * Wipe a room's transcript and make its agents forget the conversation.
   *
   * Deleting the messages alone is not enough and the reason is the whole point
   * of this function: each agent's `room_agent_sessions` row points at a CLI
   * conversation that still contains everything that was just deleted, so the
   * next turn would `resume` it and the "cleared" room would keep answering from
   * a transcript the player can no longer see. The session rows go, the warm
   * sessions go, and the next turn starts a genuinely new conversation.
   *
   * The interrupt deliberately does not save partial responses: a half-written
   * reply to a message that no longer exists is not worth persisting.
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

    // `deleteRoomMessages` deliberately does not sweep its own cache, so the
    // polling endpoint would keep serving the deleted transcript for up to the
    // cache TTL without this.
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

