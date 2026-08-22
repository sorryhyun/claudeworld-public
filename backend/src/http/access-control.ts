// World and room ownership. Not a capability model: `guest` and `admin` may do
// exactly the same things, and the role only decides whose worlds are visible.

import type { UserRole } from '../auth/roles'
import { HttpError } from './errors'

export interface Identity {
  role: UserRole
  userId: string
}

/** An admin reaches every world; anyone else reaches only their own. */
export function canAccessWorld(identity: Identity, worldOwnerId: string): boolean {
  return identity.role === 'admin' || identity.userId === worldOwnerId
}

/**
 * Throw 403 unless the caller may touch this world. `detail` is a parameter
 * because the routes do not all use the same string and it is shown verbatim.
 */
export function assertWorldAccess(
  identity: Identity,
  worldOwnerId: string,
  detail = 'Not your world',
): void {
  if (!canAccessWorld(identity, worldOwnerId)) {
    throw new HttpError(403, detail)
  }
}

/**
 * Throw unless the caller may touch this room — same rule as worlds, different
 * `detail`. `ownerId` is nullable because `rooms.owner_id` is: rows predating
 * the column carry NULL, which belongs to nobody and matches no non-admin.
 */
export function assertRoomAccess(identity: Identity, ownerId: string | null): void {
  if (identity.role === 'admin') return
  if (ownerId !== null && ownerId === identity.userId) return
  throw new HttpError(403, 'You do not have access to this room')
}
