/**
 * World ownership checks.
 *
 * Port of `backend/domain/services/access_control.py`. It lives under `http/`
 * rather than in a domain layer because the only thing it decides is which
 * HTTP status and `detail` string a request gets; Python's copy sits in
 * `domain/services/` but imports `fastapi.HTTPException`, so the layering was
 * already nominal.
 *
 * Access is not a capability model: `guest` and `admin` may do exactly the same
 * things, and the role only decides whose worlds are visible.
 */

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
 * Throw 403 unless the caller may touch this world.
 *
 * `detail` is a parameter because the Python routers are not consistent: every
 * check in `routers/game/worlds.py` says `"Not your world"` except the delete
 * handler (`worlds.py:399`), which says `"Not authorized to delete this
 * world"`. The frontend surfaces `detail` verbatim, so the inconsistency is
 * observable and is reproduced rather than tidied.
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
