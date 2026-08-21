/**
 * Transient runtime state (`worlds/{name}/_state.json`).
 *
 * Ported from `backend/services/room_mapping_service.py`, minus
 * `validate_state`, `rebuild_room_mappings_from_db` and
 * `get_room_ids_for_world` — none of the three has a call site in
 * `routers/game/` or `orchestration/`.
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

import { LocationStorage } from './location-storage'
import { WorldService } from './world-service'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('RoomMapping')

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
  private readonly locations: LocationStorage

  constructor(worldsDir: string) {
    this.worlds = new WorldService(worldsDir)
    // Only reached by {@link RoomMappingService.findLocationRoomKeyFuzzy}'s
    // last tier. Python imports `LocationStorage` inside that function to
    // dodge a circular import (`room_mapping_service.py:340`); here
    // `location-storage.ts` does not import this module, so there is no cycle
    // to dodge.
    this.locations = new LocationStorage(worldsDir)
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
      logger.warning(`Failed to parse _state.json for '${worldName}': ${String(error)}`)
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

  /**
   * Ensure a room key is mapped, and repair it when it is mapped wrong.
   * `true` when the mapping was created, `false` when it already existed.
   *
   * The repair is the interesting half: `_state.json` and the database drift
   * apart whenever one is restored, copied or hand-edited without the other,
   * and the caller here holds the id the database just gave it. Trusting that
   * id over the file is what makes the path self-healing rather than a guard.
   *
   * The file is left alone when the mapping is already correct, so the common
   * case does not restamp `last_updated` on every call.
   */
  ensureRoomMappingExists(
    worldName: string,
    roomKey: string,
    dbRoomId: number,
    agents: string[] = [],
  ): boolean {
    const state = this.loadState(worldName)
    const existing = state.rooms[roomKey]

    if (existing !== undefined) {
      if (existing.dbRoomId !== dbRoomId) {
        logger.warning(
          `Room mapping mismatch for ${roomKey}: _state.json=${existing.dbRoomId}, ` +
            `expected=${dbRoomId}. Updating.`,
        )
        existing.dbRoomId = dbRoomId
        this.saveState(worldName, state)
      }
      return false
    }

    state.rooms[roomKey] = { dbRoomId, agents, createdAt: localIsoNow() }
    this.saveState(worldName, state)

    logger.info(`Created missing room mapping: ${worldName}/${roomKey} -> room_id=${dbRoomId}`)
    return true
  }

  /**
   * Forget a room key. `false` when it was not mapped.
   *
   * Clearing `current_room` when it pointed at the deleted key is what stops
   * the next turn resolving a room id that no longer exists.
   */
  deleteRoomMapping(worldName: string, roomKey: string): boolean {
    const state = this.loadState(worldName)
    if (state.rooms[roomKey] === undefined) return false

    delete state.rooms[roomKey]
    if (state.currentRoom === roomKey) state.currentRoom = null
    this.saveState(worldName, state)

    logger.info(`Deleted room mapping ${roomKey} from world ${worldName}`)
    return true
  }

  // --------------------------------------------------------------------
  // Room occupancy
  // --------------------------------------------------------------------

  /**
   * Record an agent as present in a room. `false` when the agent was already
   * there or the room could not be resolved — in both cases nothing is
   * written.
   *
   * Two fallbacks, because the caller is usually a character-movement tool
   * naming a location the way the model wrote it: an unmapped `location:` key
   * is retried through {@link findLocationRoomKeyFuzzy}, and a still-unmapped
   * one is auto-created with `db_room_id: 0`. A zero id is a placeholder, not
   * a valid room — {@link ensureRoomMappingExists} overwrites it once the
   * database row exists, and the agent list is what had to survive until then.
   */
  addAgentToRoom(worldName: string, roomKey: string, agentName: string): boolean {
    const state = this.loadState(worldName)
    let key = roomKey
    let mapping = state.rooms[key]

    if (mapping === undefined) {
      const fuzzy = this.resolveFuzzyLocationKey(worldName, key)
      if (fuzzy !== null) {
        key = fuzzy
        mapping = state.rooms[key]
      }
    }

    if (mapping === undefined) {
      if (!key.startsWith(LOCATION_PREFIX)) {
        logger.warning(`Room ${key} not found in world ${worldName}`)
        return false
      }
      mapping = { dbRoomId: 0, agents: [], createdAt: null }
      state.rooms[key] = mapping
      logger.info(`Auto-created room mapping for ${key} in world ${worldName}`)
    }

    if (mapping.agents.includes(agentName)) return false

    mapping.agents.push(agentName)
    this.saveState(worldName, state)

    logger.info(`Added agent ${agentName} to room ${key} in world ${worldName}`)
    return true
  }

  /**
   * Remove an agent from a room. `false` when the room is unmapped or the
   * agent was not in it.
   *
   * Same fuzzy retry as {@link addAgentToRoom} but no auto-create: there is
   * nothing to remove from a room that does not exist.
   */
  removeAgentFromRoom(worldName: string, roomKey: string, agentName: string): boolean {
    const state = this.loadState(worldName)
    let key = roomKey
    let mapping = state.rooms[key]

    if (mapping === undefined) {
      const fuzzy = this.resolveFuzzyLocationKey(worldName, key)
      if (fuzzy !== null) {
        key = fuzzy
        mapping = state.rooms[key]
      }
    }

    if (mapping === undefined) {
      logger.warning(`Room ${key} not found in world ${worldName}`)
      return false
    }

    const index = mapping.agents.indexOf(agentName)
    if (index === -1) return false

    mapping.agents.splice(index, 1)
    this.saveState(worldName, state)

    logger.info(`Removed agent ${agentName} from room ${key} in world ${worldName}`)
    return true
  }

  /**
   * The shared prelude of the two occupancy methods: retry an unmapped
   * `location:` key through fuzzy matching, logging the substitution.
   * `null` when the key is not a location key or nothing matched.
   */
  private resolveFuzzyLocationKey(worldName: string, roomKey: string): string | null {
    const locationName = RoomMappingService.roomKeyToLocation(roomKey)
    if (locationName === null) return null

    const fuzzyKey = this.findLocationRoomKeyFuzzy(worldName, locationName)
    if (fuzzyKey === null) return null

    logger.info(`Fuzzy matched room key: '${roomKey}' -> '${fuzzyKey}'`)
    return fuzzyKey
  }

  // --------------------------------------------------------------------
  // Current room
  // --------------------------------------------------------------------

  /** The room the player is currently in, or `null` before one is chosen. */
  getCurrentRoom(worldName: string): string | null {
    return this.loadState(worldName).currentRoom
  }

  /**
   * Point the world at a room. The key is stored as given — an unmapped key
   * is accepted, matching Python, and reads back as a `null` room id.
   */
  setCurrentRoom(worldName: string, roomKey: string): void {
    const state = this.loadState(worldName)
    state.currentRoom = roomKey
    this.saveState(worldName, state)

    logger.info(`Set current room for ${worldName} to ${roomKey}`)
  }

  /** DB room id of the current room; `null` when there is none, or it is unmapped. */
  getCurrentRoomId(worldName: string): number | null {
    const current = this.getCurrentRoom(worldName)
    if (!current) return null
    return this.getRoomId(worldName, current)
  }

  // --------------------------------------------------------------------
  // Room key resolution
  // --------------------------------------------------------------------

  /**
   * Resolve a location name to a mapped room key, tolerantly.
   *
   * The input comes from a model writing a place name into a tool call, so it
   * arrives capitalised differently, translated, abbreviated or padded with a
   * definite article. Six tiers run in order, each a complete pass over the
   * mapped location keys before the next begins — so a case-insensitive hit
   * always beats a prefix hit, and a prefix hit always beats a substring one.
   * Tier order *is* the disambiguation policy; within a tier the first mapped
   * key wins, which is insertion order in `_state.json`.
   *
   * The last tier leaves `_state.json` for the filesystem, and can therefore
   * return a key that is not mapped at all. That is intentional and its
   * callers handle it: {@link addAgentToRoom} auto-creates the mapping.
   *
   * Mirrors `room_mapping_service.py:302-347`.
   */
  findLocationRoomKeyFuzzy(worldName: string, locationName: string): string | null {
    const state = this.loadState(worldName)
    const search = locationName.toLowerCase()

    // 1. Exact.
    const exactKey = RoomMappingService.locationToRoomKey(locationName)
    if (state.rooms[exactKey] !== undefined) return exactKey

    // An empty location name (the bare key `location:`) is skipped by every
    // remaining tier, matching Python's `if loc_name and ...` guard.
    const candidates = Object.keys(state.rooms)
      .map((key) => ({ key, name: RoomMappingService.roomKeyToLocation(key) }))
      .filter((entry): entry is { key: string; name: string } => Boolean(entry.name))
      .map((entry) => ({ key: entry.key, name: entry.name.toLowerCase() }))

    // 2. Case-insensitive exact.
    for (const { key, name } of candidates) if (name === search) return key

    // 3. Prefix: 'old' finds 'old_mill'.
    for (const { key, name } of candidates) if (name.startsWith(search)) return key

    // 4. Contains: 'mill' finds 'old_mill'.
    for (const { key, name } of candidates) if (name.includes(search)) return key

    // 5. Reverse contains: 'the old mill, at dusk' finds 'old_mill' — the
    //    model padding a folder name with prose.
    for (const { key, name } of candidates) if (search.includes(name)) return key

    // 6. Filesystem fallback, for a location that exists on disk but has never
    //    had a room created for it. Note this tier is exact-or-contains only;
    //    it has no prefix pass, matching `room_mapping_service.py:343-345`.
    for (const folder of Object.keys(this.locations.loadAllLocations(worldName))) {
      const folderLower = folder.toLowerCase()
      if (folderLower === search || folderLower.includes(search)) {
        return RoomMappingService.locationToRoomKey(folder)
      }
    }

    return null
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
