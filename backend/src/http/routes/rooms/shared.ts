/**
 * Helpers shared by the four chat-room route modules.
 *
 * The `/rooms` surface is the chat half of the app — the part that predates the
 * TRPG mode and that `frontend/src/hooks/usePolling.ts` and `useSSE.ts` drive.
 * It is mounted at the root, like `/worlds`, so each module writes its own
 * `/rooms/...` paths; see `routes/game/index.ts` for why.
 */

import type { Context } from 'hono'

import { getRoom, type RoomWithRelations } from '../../../crud/rooms'
import type { Db } from '../../../db'
import { RoomNotFoundError } from '../../../domain/errors'
import { assertRoomAccess } from '../../access-control'
import { identityOf } from '../../state'
import type { AppEnv } from '../../types'

/**
 * Load a room the caller is allowed to see, or throw.
 *
 * Port of `core/dependencies.py::ensure_room_access`, minus its world-phase
 * filesystem sync. That sync exists because the onboarding tools write
 * `world.yaml` directly and the row goes stale; it belongs to the `/worlds`
 * surface, which does it in `routes/game/worlds.ts::syncWorldFromFs`, and
 * running it again here would mean every chat poll stat-ing a YAML file.
 *
 * Order is Python's and is observable: a room that does not exist is a 404 even
 * for a caller who would have been 403'd, so probing ids cannot be used to
 * enumerate other people's rooms by their error code.
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

/** {@link ensureRoomAccess} against the caller on a request context. */
export function ensureRoomAccessFor(
  c: Context<AppEnv>,
  db: Db,
  roomId: number,
): RoomWithRelations {
  return ensureRoomAccess(db, roomId, identityOf(c))
}
