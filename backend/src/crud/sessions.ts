/** Room/agent SDK session bookkeeping. */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { roomAgentSessions } from '../db/schema'

export type RoomAgentSession = typeof roomAgentSessions.$inferSelect

/** The SDK session id for a room/agent pair, if one is stored. */
export function getRoomAgentSession(db: Db, roomId: number, agentId: number): string | null {
  const row = db
    .select({ sessionId: roomAgentSessions.sessionId })
    .from(roomAgentSessions)
    .where(and(eq(roomAgentSessions.roomId, roomId), eq(roomAgentSessions.agentId, agentId)))
    .get()

  return row?.sessionId ?? null
}

/** Upserts on the composite key, closing the two-turns-both-insert race. */
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
 * Called when a transcript is wiped: each row points at a CLI conversation still
 * holding the deleted messages, which the next turn would `resume`.
 */
export function deleteRoomAgentSessions(db: Db, roomId: number): void {
  db.delete(roomAgentSessions).where(eq(roomAgentSessions.roomId, roomId)).run()
}
