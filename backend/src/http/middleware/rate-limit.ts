/**
 * Fixed-window rate limiting.
 *
 * Replaces `slowapi`, which the Python backend uses for exactly one thing:
 * `@limiter.limit("20/minute")` on the login endpoint, keyed by client IP. A
 * dependency for that would be more moving parts than the thing it limits, so
 * this is the same algorithm slowapi's default strategy uses — a counter per
 * key per window — written out.
 *
 * Fixed-window means a burst spanning a window boundary can briefly exceed the
 * nominal rate. That is slowapi's default behaviour too, and it does not matter
 * for the property being defended: 40 password guesses across two minutes is
 * still nowhere near enough to brute-force a bcrypt hash.
 */

import { getConnInfo } from 'hono/bun'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Human-readable rate, echoed in the 429 body — e.g. `20 per 1 minute`. */
  description: string
  /** Defaults to the peer address, matching slowapi's `get_remote_address`. */
  keyFor?: (c: Context) => string
}

interface Window {
  count: number
  resetAt: number
}

/**
 * Peer address of the connection.
 *
 * Deliberately *not* `X-Forwarded-For`: that header is attacker-controlled
 * unless a trusted proxy is known to overwrite it, and trusting it here would
 * let one client mint a fresh quota per request. `get_remote_address` takes the
 * socket peer for the same reason.
 */
function remoteAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    // No connection info (tests calling `app.request()` directly, or a runtime
    // that does not expose it). One shared bucket is the safe direction.
    return 'unknown'
  }
}

export function rateLimit({ limit, windowMs, description, keyFor = remoteAddress }: RateLimitOptions) {
  const windows = new Map<string, Window>()

  return createMiddleware(async (c, next) => {
    const now = Date.now()
    const key = keyFor(c)

    // Sweep on write rather than on a timer: the map is only ever touched from
    // here, so a background interval would keep the process alive for nothing.
    for (const [existingKey, window] of windows) {
      if (window.resetAt <= now) windows.delete(existingKey)
    }

    const window = windows.get(key)
    if (window === undefined || window.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    window.count += 1
    if (window.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000))
      // slowapi's `_rate_limit_exceeded_handler` shape, verbatim.
      return c.json({ error: `Rate limit exceeded: ${description}` }, 429, {
        'Retry-After': String(retryAfter),
      })
    }

    return next()
  })
}
