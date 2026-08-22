// Fixed-window rate limiting, one counter per key per window, used only by the
// login endpoint. A burst spanning a window boundary can briefly exceed the
// nominal rate; 40 password guesses in two minutes is still nothing to bcrypt.

import { getConnInfo } from 'hono/bun'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'

export interface RateLimitOptions {
  limit: number
  windowMs: number
  /** Human-readable rate, echoed in the 429 body — e.g. `20 per 1 minute`. */
  description: string
  /** Defaults to the peer address. */
  keyFor?: (c: Context) => string
}

interface Window {
  count: number
  resetAt: number
}

// Deliberately *not* `X-Forwarded-For`: that header is attacker-controlled
// unless a trusted proxy is known to overwrite it, and trusting it would let one
// client mint a fresh quota per request.
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
      return c.json({ error: `Rate limit exceeded: ${description}` }, 429, {
        'Retry-After': String(retryAfter),
      })
    }

    return next()
  })
}
