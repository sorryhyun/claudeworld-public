/**
 * The JSON encode/decode boundary for the four TEXT columns on `player_states`:
 * `stats`, `inventory`, `effects` and `action_history`.
 *
 * **Every `parse*` swallows a decode error and returns the empty default.** A
 * corrupt `stats` blob silently becomes `{}` rather than failing the request —
 * ugly, but rows in the wild were written against it, and throwing here would
 * turn a cosmetically broken world into an unopenable one.
 *
 * `addActionToHistory` in `src/crud/player-state.ts` deliberately parses
 * `action_history` itself and throws. Do not "unify" the two.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `{}` also covers valid JSON of the wrong kind, which is corrupt either way.
function parseObjectColumn(data: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (data === null || data === undefined) return {}
  // By reference: FS-path callers hand in a parsed mapping and expect it back.
  if (isRecord(data)) return data
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function parseArrayColumn<T>(data: string | T[] | null | undefined): T[] {
  if (data === null || data === undefined) return []
  if (Array.isArray(data)) return data
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

export const PlayerStateSerializer = {
  parseStats(statsData: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
    return parseObjectColumn(statsData)
  },

  /**
   * Returns `"{}"` for empty stats, not null — writing NULL for an empty
   * collection is the *CRUD* layer's convention (`jsonOrNull`).
   */
  serializeStats(stats: Record<string, unknown>): string {
    return JSON.stringify(stats)
  },

  parseInventory<T = unknown>(inventoryData: string | T[] | null | undefined): T[] {
    return parseArrayColumn(inventoryData)
  },

  serializeInventory(inventory: unknown[]): string {
    return JSON.stringify(inventory)
  },

  parseEffects<T = unknown>(effectsData: string | T[] | null | undefined): T[] {
    return parseArrayColumn(effectsData)
  },

  serializeEffects(effects: unknown[]): string {
    return JSON.stringify(effects)
  },

  /**
   * `addActionToHistory` in `src/crud/player-state.ts` deliberately does *not*
   * go through this: it throws, so a corrupt blob is not quietly replaced by an
   * empty history on the next write.
   */
  parseActionHistory<T = unknown>(historyData: string | T[] | null | undefined): T[] {
    return parseArrayColumn(historyData)
  },

  serializeActionHistory(history: unknown[]): string {
    return JSON.stringify(history)
  },
} as const
