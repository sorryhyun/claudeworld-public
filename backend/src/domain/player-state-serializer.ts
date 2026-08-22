/**
 * Player state serialization — port of
 * `backend/domain/services/player_state_serializer.py`.
 *
 * This is the JSON encode/decode boundary for the four TEXT columns on
 * `player_states`: `stats`, `inventory`, `effects` and `action_history`. Both
 * backends read and write the same rows, so what lands in those columns is a
 * compatibility contract, not an implementation detail.
 *
 * Two things about the Python original are worth stating plainly, because both
 * are load-bearing:
 *
 * 1. **Every `parse*` swallows a decode error and returns the empty default.**
 *    A corrupt `stats` blob silently becomes `{}` — the player's stats reset to
 *    nothing rather than the request failing. That is a bad behaviour, but it is
 *    the behaviour rows in the wild were written against, and a parse that
 *    started throwing here would turn a cosmetically broken world into an
 *    unopenable one. It is reproduced exactly.
 * 2. **`crud/player_state.py:207` does not use this class for
 *    `action_history`** — it calls `json.loads` bare, so a corrupt history blob
 *    raises there while `parseActionHistory` returns `[]` here. Both behaviours
 *    are correct in their own place and `src/crud/player-state.ts` keeps the
 *    throwing one. Do not "unify" them.
 *
 * Python's `json.dumps` defaults differ from `JSON.stringify` in two cosmetic
 * ways: it puts a space after `:` and `,`, and it escapes non-ASCII to `\uXXXX`.
 * Korean item names therefore serialize to different *bytes* here than in
 * Python. Both decode to the same values in either language, and the rest of
 * this port already writes compact UTF-8 JSON (`src/crud/messages.ts`), so the
 * difference is left alone rather than emulated.
 */

/** Whether a value is a plain JSON object, i.e. what Python calls a `dict`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode one of the object-shaped columns, or `{}` if it cannot be decoded.
 *
 * The wrong-kind case (valid JSON that is an array, a string or `null`) also
 * lands on `{}`. Python returns whatever `json.loads` produced regardless of its
 * type annotation, so a blob holding `[1, 2]` comes back from `parse_stats` as a
 * list and blows up at the first `.get`. TypeScript cannot return that lie, and
 * a column that holds the wrong kind is corrupt under either backend, so it is
 * treated the same as a decode failure.
 */
function parseObjectColumn(data: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (data === null || data === undefined) return {}
  // A dict is passed through by reference, exactly as Python does — callers of
  // the FS path hand in an already-parsed mapping and expect it back unchanged.
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

/** Decode one of the list-shaped columns, or `[]` if it cannot be decoded. */
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

/**
 * Domain logic for player state JSON serialization.
 *
 * Python exposes these as `@staticmethod`s on a class; the same shape is kept so
 * call sites read identically across the two backends. The four column pairs are
 * separate functions rather than one generic pair because the Python API is what
 * consumers import by name.
 */
export const PlayerStateSerializer = {
  /** Decode `player_states.stats`. Empty object when absent or unreadable. */
  parseStats(statsData: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
    return parseObjectColumn(statsData)
  },

  /**
   * Encode `player_states.stats`.
   *
   * Note this returns `"{}"` for empty stats, not null. Writing NULL for an
   * empty collection is the *CRUD* layer's convention (see `jsonOrNull` in
   * `src/crud/messages.ts`); the serializer stays faithful to `json.dumps`.
   */
  serializeStats(stats: Record<string, unknown>): string {
    return JSON.stringify(stats)
  },

  /** Decode `player_states.inventory`. Empty array when absent or unreadable. */
  parseInventory<T = unknown>(inventoryData: string | T[] | null | undefined): T[] {
    return parseArrayColumn(inventoryData)
  },

  /** Encode `player_states.inventory`. */
  serializeInventory(inventory: unknown[]): string {
    return JSON.stringify(inventory)
  },

  /** Decode `player_states.effects`. Empty array when absent or unreadable. */
  parseEffects<T = unknown>(effectsData: string | T[] | null | undefined): T[] {
    return parseArrayColumn(effectsData)
  },

  /** Encode `player_states.effects`. */
  serializeEffects(effects: unknown[]): string {
    return JSON.stringify(effects)
  },

  /**
   * Decode `player_states.action_history`. Empty array when unreadable.
   *
   * `addActionToHistory` in `src/crud/player-state.ts` deliberately does *not*
   * go through this: it mirrors Python's bare `json.loads` and throws, so a
   * corrupt blob is not quietly replaced by an empty history on the next write.
   */
  parseActionHistory<T = unknown>(historyData: string | T[] | null | undefined): T[] {
    return parseArrayColumn(historyData)
  },

  /** Encode `player_states.action_history`. */
  serializeActionHistory(history: unknown[]): string {
    return JSON.stringify(history)
  },
} as const
