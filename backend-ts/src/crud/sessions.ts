/**
 * Room/agent SDK session bookkeeping — port of the session half of
 * `backend/crud/room_agents.py`.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { roomAgentSessions } from '../db/schema'

export type RoomAgentSession = typeof roomAgentSessions.$inferSelect

/** The Claude Agent SDK session id for a room/agent pair, if one is stored. */
export function getRoomAgentSession(db: Db, roomId: number, agentId: number): string | null {
  const row = db
    .select({ sessionId: roomAgentSessions.sessionId })
    .from(roomAgentSessions)
    .where(and(eq(roomAgentSessions.roomId, roomId), eq(roomAgentSessions.agentId, agentId)))
    .get()

  return row?.sessionId ?? null
}

/**
 * Store the session id for a room/agent pair, creating the row if absent.
 *
 * Python does select-then-branch; the composite primary key lets SQLite settle
 * it in one statement instead, which also closes the race where two turns for
 * the same agent both see "no row" and both insert.
 *
 * `updated_at` is written on both paths because the SQLAlchemy column carries
 * `onupdate` as well as `default`.
 */
export function updateRoomAgentSession(
  db: Db,
  roomId: number,
  agentId: number,
  sessionId: string,
): RoomAgentSession {
  const now = new Date()
  return db
    .insert(roomAgentSessions)
    .values({ roomId, agentId, sessionId, updatedAt: now })
    .onConflictDoUpdate({
      target: [roomAgentSessions.roomId, roomAgentSessions.agentId],
      set: { sessionId, updatedAt: now },
    })
    .returning()
    .get()
}

/**
 * Drop every stored session id for a room.
 *
 * Only called when a room's transcript is being wiped. Deleting the messages
 * alone would not do it: each row points at a CLI conversation that still holds
 * everything just deleted, so the next turn would `resume` it and the "cleared"
 * room would keep answering from a transcript the player can no longer see.
 *
 * Python has no counterpart function — `services/agent_service.py` issues the
 * `DELETE` inline — but the statement belongs beside the readers that write
 * these rows rather than in a service.
 */
export function deleteRoomAgentSessions(db: Db, roomId: number): void {
  db.delete(roomAgentSessions).where(eq(roomAgentSessions.roomId, roomId)).run()
}
