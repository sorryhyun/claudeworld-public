import type { Db } from '../../db'
import type { CreateLocationInput } from '../../services/persistence-manager'
import type { GameTime, PlayerState } from '../../services/player-service'
import type { InventoryEntry } from '../../domain/player-rules'

/** Dependencies and orchestrator seams the service layer does not provide. */

export interface TimeAdvanceResult {
  oldTime: GameTime
  newTime: GameTime
}

// Filesystem-first, with a write-through to `player_states` — which is why these
// are not plain `PlayerService` calls: a disk-only change is invisible to polls.
export interface PlayerMutationsPort {
  /** Clamped by the world's stat definitions; returns the new values. */
  updateStats(worldName: string, changes: Record<string, number>): Record<string, number> | null
  addItem(
    worldName: string,
    item: {
      itemId: string
      name: string
      quantity?: number
      description?: string | null
      properties?: Record<string, unknown> | null
    },
  ): boolean
  removeItem(worldName: string, itemId: string, quantity?: number): boolean
  /** `null` when the world has no `player.json`, or when `minutes <= 0`. */
  advanceTime(worldName: string, minutes: number): TimeAdvanceResult | null
  /** Resolved against `items/` templates — names and descriptions, not ids. */
  getInventory(worldName: string): InventoryEntry[]
  loadPlayerState(worldName: string): PlayerState | null
}

// A factory, not an instance: a long-lived one would mirror the right
// `player.json` onto somebody else's `player_states` row.
export type PlayerMutationsFactory = (db: Db, worldId: number) => PlayerMutationsPort

export interface LocationPersistence {
  createLocation(input: CreateLocationInput): number
}

// A `PersistenceManager` for one world, bound per turn.
export type LocationPersistenceFactory = (
  db: Db,
  worldId: number,
  worldName: string,
) => LocationPersistence

/**
 * Per-room status the polling endpoint reports, plus the side effects `travel`
 * triggers. Optional callbacks supplied through `ServerDeps`, so handlers never
 * import `room-orchestrator.ts` and the dependency runs one way.
 */
export interface TurnStatusPort {
  setSubAgentActive?: (roomId: number, name: string, thinkingText: string) => void
  setSubAgentInactive?: (roomId: number) => void
  setSeedGenerationActive?: (roomId: number, thinkingText: string) => void
  setSeedGenerationInactive?: (roomId: number) => void
  /** Let the NPCs write memories before the player leaves. Returns how many ran. */
  triggerNpcMemoryRound?: (locationId: number) => Promise<number>
  /** Warm the destination's characters; fire-and-forget, `travel` never awaits. */
  preConnectLocation?: (roomId: number, locationId: number) => void
}
