/** Helpers for the chat-room route modules, which are mounted at the root. */

import type { Context } from 'hono'

import { getRoom, type RoomWithRelations } from '../../../crud/rooms'
import type { Db } from '../../../db'
import { RoomNotFoundError } from '../../../domain/errors'
import { assertRoomAccess } from '../../access-control'
import { identityOf } from '../../state'
import type { AppEnv } from '../../types'

/**
 * Load a room the caller may see, or throw. No world-phase filesystem sync —
 * that belongs to `/worlds`, and here it would make every chat poll stat a YAML
 * file. The check order is observable: a nonexistent room is a 404 even for a
 * caller who would have been 403'd, so ids cannot be probed by error code.
 */
export function ensureRoomAccess(
  db: Db,
  roomId: number,
  identity: { role: 'admin' | 'guest'; userId: string },
): RoomWithRelations {
  const room = getRoom(db, roomId)
  if (room === null) throw new RoomNotFoundError(roomId)
  assertRoomAccess(identity, room.ownerId)
  return room
}

/** {@link ensureRoomAccess} for the caller on a request context. */
export function ensureRoomAccessFor(
  c: Context<AppEnv>,
  db: Db,
  roomId: number,
): RoomWithRelations {
  return ensureRoomAccess(db, roomId, identityOf(c))
}
