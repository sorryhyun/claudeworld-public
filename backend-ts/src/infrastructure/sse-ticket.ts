/**
 * Single-use tickets for SSE authentication.
 *
 * Port of `backend/infrastructure/sse_ticket.py`. `EventSource` cannot send an
 * `X-API-Key` header, and putting the JWT in the query string would write a
 * long-lived credential into every access log and `Referer`. So the client
 * trades its JWT for a ticket over a normal authenticated POST, then spends the
 * ticket on the stream URL: 60-second lifetime, one use, bound to one room.
 *
 * `auth.ts` excludes `GET /rooms/{id}/stream` from the JWT middleware precisely
 * because this module is what authenticates it instead.
 */

import { getLogger } from './logging/logger'
import type { UserRole } from '../auth/roles'

const logger = getLogger('SSETicket')

/** How long a ticket stays spendable. Python's `TICKET_TTL`. */
export const TICKET_TTL_MS = 60_000

/** How often expired tickets are swept, at most. Python's `CLEANUP_INTERVAL`. */
export const CLEANUP_INTERVAL_MS = 300_000

export interface TicketData {
  userId: string
  role: UserRole
  roomId: number
  /** Monotonic milliseconds, from `performance.now()`. */
  createdAt: number
}

/**
 * Mint a URL-safe token.
 *
 * 32 random bytes, base64url without padding — the same shape and entropy as
 * Python's `secrets.token_urlsafe(32)`, so a ticket is interchangeable between
 * the two backends in the mixed-mode deployments the migration allows.
 */
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

  /**
   * Issue a ticket for one room.
   *
   * @param now Injectable clock, for tests that need to age a ticket without
   *   sleeping for a minute.
   */
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

  /**
   * Spend a ticket, or return null if it cannot be spent.
   *
   * The delete happens before every check, so a ticket is consumed even when it
   * turns out to be expired or aimed at another room — a replay of a rejected
   * ticket must not get a second verdict.
   */
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

  /** Live ticket count, for tests and diagnostics. */
  get size(): number {
    return this.tickets.size
  }

  /**
   * Drop expired tickets, at most once per {@link CLEANUP_INTERVAL_MS}.
   *
   * Unspent tickets are the only ones that accumulate — a connected client's is
   * removed on validation — so this is a slow leak, not a fast one, and paying
   * for a sweep on every issue would be the wrong trade.
   */
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
