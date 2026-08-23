/**
 * Single-use tickets for SSE authentication. `EventSource` cannot send an
 * `X-API-Key` header, and a JWT in the query string would land a long-lived
 * credential in every access log and `Referer`; so the client trades its JWT for
 * a ticket over an authenticated POST — 60 seconds, one use, one room.
 *
 * `auth.ts` excludes `GET /rooms/{id}/stream` from the JWT middleware precisely
 * because this module authenticates it instead.
 */

import { getLogger } from './logging/logger'
import type { UserRole } from '@/auth/roles'

const logger = getLogger('SSETicket')

/** How long a ticket stays spendable. */
export const TICKET_TTL_MS = 60_000

/** How often expired tickets are swept, at most. */
export const CLEANUP_INTERVAL_MS = 300_000

export interface TicketData {
  userId: string
  role: UserRole
  roomId: number
  /** Monotonic milliseconds, from `performance.now()`. */
  createdAt: number
}

// 32 random bytes, base64url without padding.
function generateTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export class SSETicketManager {
  private readonly tickets = new Map<string, TicketData>()
  private lastCleanup = performance.now()

  /** @param now Injectable clock, so tests can age a ticket without sleeping. */
  createTicket(
    userId: string,
    role: UserRole,
    roomId: number,
    now: number = performance.now(),
  ): string {
    this.maybeCleanup(now)
    const ticket = generateTicket()
    this.tickets.set(ticket, { userId, role, roomId, createdAt: now })
    logger.debug(`SSE ticket created for user=${userId} room=${roomId}`)
    return ticket
  }

  // The delete happens before every check, so a ticket is consumed even when
  // expired or aimed at another room: a replay must not get a second verdict.
  validateTicket(ticket: string, roomId: number, now: number = performance.now()): TicketData | null {
    const data = this.tickets.get(ticket)
    if (data === undefined) return null
    this.tickets.delete(ticket)

    if (now - data.createdAt > TICKET_TTL_MS) {
      logger.debug('SSE ticket expired')
      return null
    }

    if (data.roomId !== roomId) {
      logger.warning(`SSE ticket room mismatch: ticket=${data.roomId} request=${roomId}`)
      return null
    }

    return data
  }

  get size(): number {
    return this.tickets.size
  }

  // Only unspent tickets accumulate (a connected client's is removed on
  // validation), so a sweep on every issue would be the wrong trade.
  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return
    this.lastCleanup = now

    let removed = 0
    for (const [ticket, data] of this.tickets) {
      if (now - data.createdAt > TICKET_TTL_MS) {
        this.tickets.delete(ticket)
        removed++
      }
    }
    if (removed > 0) logger.debug(`Cleaned up ${removed} expired SSE tickets`)
  }
}
