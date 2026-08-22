import type { Db } from '../../db'
import type { CreateLocationInput } from '../../services/persistence-manager'
import type { GameTime, PlayerState } from '../../services/player-service'
import type { InventoryEntry } from '../../domain/player-rules'

/**
 * Dependencies these handlers need that the service layer does not provide
 * directly, plus the seams the orchestrator plugs into.
 *
 * Everything Python's handlers reach for that *does* have a TypeScript home is
 * imported as the real class — `AgentFilesystemService`, `AgentFactory`,
 * `PersistenceManager`, `ItemService`, `WorldService`. What is left here is the
 * genuinely missing (`PlayerMutationsPort`, a port of
 * `services/facades/player_facade.py`), and the deliberately inverted
 * (`TurnStatusPort`, which exists so orchestration can call *into* the SDK
 * layer without the SDK layer importing orchestration).
 */

// ============================================================================
// services/facades/player_facade.py — NOT YET PORTED
// ============================================================================

export interface TimeAdvanceResult {
  oldTime: GameTime
  newTime: GameTime
}

/**
 * Filesystem-first player mutations with a write-through to the database.
 *
 * `PlayerService` already covers the read paths and `updateStats`; what is
 * missing is the inventory and clock mutations *and*, in every case, the sync
 * to the `player_states` row the polling endpoint reads. That sync is why these
 * cannot simply be `PlayerService` calls: a stat change that only lands on disk
 * is invisible to the player until something else forces a full state reload.
 *
 * Whoever ports the facade should satisfy this interface rather than widen it;
 * a handler needing a method not listed here is a handler doing something
 * `mechanics_tools.py` does not.
 */
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
  /** `null` when the world has no `player.yaml`, or when `minutes <= 0`. */
  advanceTime(worldName: string, minutes: number): TimeAdvanceResult | null
  /** Resolved against `items/` templates — names and descriptions, not ids. */
  getInventory(worldName: string): InventoryEntry[]
  loadPlayerState(worldName: string): PlayerState | null
}

/**
 * A {@link PlayerMutationsPort} for one world.
 *
 * A factory for the same reason {@link LocationPersistenceFactory} is one: the
 * facade's write-through targets a specific `player_states` row, so an instance
 * bound to the wrong world would write the right `player.yaml` and mirror it
 * onto somebody else's row. A tool server is built per turn for exactly one
 * world, which is where the binding belongs.
 */
export type PlayerMutationsFactory = (db: Db, worldId: number) => PlayerMutationsPort

// ============================================================================
// services/persistence_manager.py — bound per world
// ============================================================================

/** The one `PersistenceManager` method the location tools call. */
export interface LocationPersistence {
  createLocation(input: CreateLocationInput): number
}

/**
 * A `PersistenceManager` for one world.
 *
 * A factory rather than an instance because the manager is constructed per
 * `(db, worldId, worldName)` triple, and a tool server is built per turn for
 * exactly one world — so binding it here is what keeps the handler from
 * carrying three arguments it would only ever pass straight through.
 */
export type LocationPersistenceFactory = (
  db: Db,
  worldId: number,
  worldName: string,
) => LocationPersistence

// ============================================================================
// orchestration — status indicators and turn side effects
// ============================================================================

/**
 * Per-room transient status the polling endpoint reports, plus the two
 * orchestrator side effects `travel` triggers.
 *
 * Handlers never import `room-orchestrator.ts`; these are callbacks supplied
 * through `ServerDeps`, so the dependency runs from orchestration into the SDK
 * layer and not back. Each is optional: without them travel still travels, it
 * just does not light up the "Traveling to…" indicator.
 */
export interface TurnStatusPort {
  setSubAgentActive?: (roomId: number, name: string, thinkingText: string) => void
  setSubAgentInactive?: (roomId: number) => void
  setSeedGenerationActive?: (roomId: number, thinkingText: string) => void
  setSeedGenerationInactive?: (roomId: number) => void
  /**
   * Give the NPCs at a location a turn to write memories before the player
   * leaves it. Returns how many ran; `travel` only logs the count.
   */
  triggerNpcMemoryRound?: (locationId: number) => Promise<number>
  /**
   * Warm sessions for the characters at the destination, so their reactions on
   * the next turn do not each pay a cold subprocess start. Fire-and-forget:
   * `travel` does not await it, and Python caps it at five characters.
   */
  preConnectLocation?: (roomId: number, locationId: number) => void
}
