/**
 * Transient runtime state (`worlds/{name}/_state.json`).
 *
 * Ported from `backend/services/room_mapping_service.py`.
 *
 * This file is the bridge between the filesystem world and the database: it
 * maps room keys to DB room ids, and carries state that must survive a restart
 * but is not game progression (progression lives in `player.yaml`).
 *
 * Nothing here is cached. Every method reads the file fresh because the state
 * is mutated by several code paths within a turn — and because
 * {@link RoomMappingService.loadAndClearArrivalContext} destroys what it
 * reads, which a cache would happily serve twice.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { WorldService } from './world-service'

// ============================================================================
// Types
// ============================================================================

/**
 * A room key -> DB room id mapping. Room keys follow three conventions:
 * `onboarding`, `location:{folder_name}`, and `chat:{agent_name}`.
 */
export interface RoomMapping {
  dbRoomId: number
  /** Agent names currently present in the room. */
  agents: string[]
  /** Local-time ISO string, or `null` for rows written without one. */
  createdAt: string | null
}

/**
 * `_state.json`. From `worlds/asdf/_state.json`:
 *
 * ```json
 * {
 *   "suggestions": [],
 *   "last_updated": "2026-08-06T13:14:54.939377",
 *   "rooms": {
 *     "onboarding": {
 *       "db_room_id": 1,
 *       "agents": ["Onboarding_Manager"],
 *       "created_at": "2026-08-06T13:14:54.939049"
 *     }
 *   },
 *   "current_room": "onboarding",
 *   "ui": {}
 * }
 * ```
 */
export interface TransientState {
  /** Action suggestions rendered as buttons under the player's input. */
  suggestions: string[]
  lastUpdated: string | null
  rooms: Record<string, RoomMapping>
  currentRoom: string | null
  /** Free-form UI state; also where `arrival_context` is parked. */
  ui: Record<string, unknown>
}

/**
 * One-shot continuity payload handed to the Action Manager on the first turn
 * after a travel, so the arrival narration can follow on from the departure.
 */
export interface ArrivalContext {
  previousNarration: string
  triggeringAction: string
  fromLocation: string
}

/** Prefix marking a room key as belonging to a world location. */
const LOCATION_PREFIX = 'location:'

/** Key under `ui` where the arrival payload is parked between turns. */
const ARRIVAL_CONTEXT_KEY = 'arrival_context'

// ============================================================================
// Helpers
// ============================================================================

function asMapping(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Timestamp in Python's `datetime.now().isoformat()` shape: local time, no
 * zone designator, microsecond precision. JS only has millisecond resolution,
 * so the last three digits are padding — the field is written for humans and
 * never parsed back.
 */
function localIsoNow(now: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `${date}T${time}.${pad(now.getMilliseconds(), 3)}000`
}

function emptyState(): TransientState {
  return { suggestions: [], lastUpdated: null, rooms: {}, currentRoom: null, ui: {} }
}

// ============================================================================
// Service
// ============================================================================

export class RoomMappingService {
  private readonly worlds: WorldService

  constructor(worldsDir: string) {
    this.worlds = new WorldService(worldsDir)
  }

  private stateFile(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), '_state.json')
  }

  // --------------------------------------------------------------------
  // Core state I/O
  // --------------------------------------------------------------------

  /**
   * Read `_state.json`. A missing, unreadable or corrupt file yields empty
   * state rather than an error: this file is disposable runtime bookkeeping,
   * and losing it must not stop a world from opening.
   */
  loadState(worldName: string): TransientState {
    let raw: string
    try {
      raw = readFileSync(this.stateFile(worldName), 'utf-8')
    } catch {
      return emptyState()
    }

    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch (error) {
      console.warn(`[room-mapping] Failed to parse _state.json for '${worldName}': ${String(error)}`)
      return emptyState()
    }

    const fields = asMapping(data)
    const rooms: Record<string, RoomMapping> = {}

    for (const [roomKey, roomValue] of Object.entries(asMapping(fields.rooms))) {
      if (typeof roomValue !== 'object' || roomValue === null || Array.isArray(roomValue)) continue
      const room = roomValue as Record<string, unknown>
      rooms[roomKey] = {
        dbRoomId: typeof room.db_room_id === 'number' ? room.db_room_id : 0,
        agents: asStringList(room.agents),
        createdAt: typeof room.created_at === 'string' ? room.created_at : null,
      }
    }

    return {
      suggestions: asStringList(fields.suggestions),
      lastUpdated: typeof fields.last_updated === 'string' ? fields.last_updated : null,
      rooms,
      currentRoom: typeof fields.current_room === 'string' ? fields.current_room : null,
      ui: asMapping(fields.ui),
    }
  }

  /**
   * Write `_state.json`, stamping `last_updated`.
   *
   * Two-space indent, unescaped non-ASCII and no trailing newline, matching
   * Python's `json.dump(..., ensure_ascii=False, indent=2)` byte for byte.
   */
  saveState(worldName: string, state: TransientState): void {
    const worldPath = this.worlds.getWorldPath(worldName)
    mkdirSync(worldPath, { recursive: true })

    const rooms: Record<string, unknown> = {}
    for (const [roomKey, mapping] of Object.entries(state.rooms)) {
      rooms[roomKey] = {
        db_room_id: mapping.dbRoomId,
        agents: mapping.agents,
        created_at: mapping.createdAt,
      }
    }

    const data = {
      suggestions: state.suggestions,
      last_updated: localIsoNow(),
      rooms,
      current_room: state.currentRoom,
      ui: state.ui,
    }

    writeFileSync(join(worldPath, '_state.json'), JSON.stringify(data, null, 2), 'utf-8')
  }

  // --------------------------------------------------------------------
  // Suggestions
  // --------------------------------------------------------------------

  /** Replace the player's suggested actions. */
  saveSuggestions(worldName: string, suggestions: string[]): void {
    const state = this.loadState(worldName)
    state.suggestions = suggestions
    this.saveState(worldName, state)
  }

  loadSuggestions(worldName: string): string[] {
    return this.loadState(worldName).suggestions
  }

  // --------------------------------------------------------------------
  // Arrival context
  // --------------------------------------------------------------------

  /** Park the departure narration for the next turn's arrival narration. */
  saveArrivalContext(worldName: string, context: ArrivalContext): void {
    const state = this.loadState(worldName)
    state.ui[ARRIVAL_CONTEXT_KEY] = {
      previous_narration: context.previousNarration,
      triggering_action: context.triggeringAction,
      from_location: context.fromLocation,
    }
    this.saveState(worldName, state)
  }

  /**
   * Read the arrival context **and delete it**.
   *
   * The clear-on-read is the point: the payload must colour exactly one
   * arrival narration. Leaving it in place would make every later turn at the
   * new location re-narrate the journey. The file is only rewritten when there
   * was something to clear.
   */
  loadAndClearArrivalContext(worldName: string): ArrivalContext | null {
    const state = this.loadState(worldName)
    const stored = state.ui[ARRIVAL_CONTEXT_KEY]
    if (stored === undefined || stored === null) return null

    const fields = asMapping(stored)
    delete state.ui[ARRIVAL_CONTEXT_KEY]
    this.saveState(worldName, state)

    return {
      previousNarration: typeof fields.previous_narration === 'string' ? fields.previous_narration : '',
      triggeringAction: typeof fields.triggering_action === 'string' ? fields.triggering_action : '',
      fromLocation: typeof fields.from_location === 'string' ? fields.from_location : '',
    }
  }

  // --------------------------------------------------------------------
  // Room mappings
  // --------------------------------------------------------------------

  /** Create or overwrite a room key's mapping, restamping `created_at`. */
  setRoomMapping(worldName: string, roomKey: string, dbRoomId: number, agents: string[] = []): void {
    const state = this.loadState(worldName)
    state.rooms[roomKey] = { dbRoomId, agents, createdAt: localIsoNow() }
    this.saveState(worldName, state)
  }

  /** Full mapping for a room key, or `null` when it is not mapped. */
  getRoomMapping(worldName: string, roomKey: string): RoomMapping | null {
    return this.loadState(worldName).rooms[roomKey] ?? null
  }

  /** DB room id for a room key, or `null` when it is not mapped. */
  getRoomId(worldName: string, roomKey: string): number | null {
    return this.getRoomMapping(worldName, roomKey)?.dbRoomId ?? null
  }

  /** Every mapping for the world, keyed by room key. */
  getAllRoomMappings(worldName: string): Record<string, RoomMapping> {
    return this.loadState(worldName).rooms
  }

  /** The room the player is currently in, or `null` before one is chosen. */
  getCurrentRoom(worldName: string): string | null {
    return this.loadState(worldName).currentRoom
  }

  /** `old_mill` -> `location:old_mill`. */
  static locationToRoomKey(locationName: string): string {
    return `${LOCATION_PREFIX}${locationName}`
  }

  /** `location:old_mill` -> `old_mill`; `null` for any other key shape. */
  static roomKeyToLocation(roomKey: string): string | null {
    return roomKey.startsWith(LOCATION_PREFIX) ? roomKey.slice(LOCATION_PREFIX.length) : null
  }
}
