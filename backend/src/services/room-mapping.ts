/**
 * Transient runtime state (`worlds/{name}/_state.json`) — room keys to DB room
 * ids, plus state that survives a restart without being game progression.
 * Nothing here is cached: several paths mutate it within one turn, and
 * {@link RoomMappingService.loadAndClearArrivalContext} destroys what it reads.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { LocationStorage } from './location-storage'
import { WorldService } from './world-service'
import { isLocationRoomKey, locationToRoomKey, roomKeyToLocation } from '../domain/room-keys'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('RoomMapping')

/** Room keys are `onboarding`, `location:{folder}` or `chat:{agent}`. */
export interface RoomMapping {
  dbRoomId: number
  agents: string[]
  createdAt: string | null
}

/** The shape of `_state.json`; on disk every key is snake_case. */
export interface TransientState {
  suggestions: string[]
  lastUpdated: string | null
  rooms: Record<string, RoomMapping>
  currentRoom: string | null
  /** Free-form UI state; also where `arrival_context` is parked. */
  ui: Record<string, unknown>
}

/** One-shot payload handed to the Action Manager on the turn after a travel. */
export interface ArrivalContext {
  previousNarration: string
  triggeringAction: string
  fromLocation: string
}

const ARRIVAL_CONTEXT_KEY = 'arrival_context'

function asMapping(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

// Local time, no zone designator, microsecond precision — the last three digits
// are padding. Written for humans and never parsed back.
function localIsoNow(now: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `${date}T${time}.${pad(now.getMilliseconds(), 3)}000`
}

function emptyState(): TransientState {
  return { suggestions: [], lastUpdated: null, rooms: {}, currentRoom: null, ui: {} }
}

export class RoomMappingService {
  private readonly worlds: WorldService
  private readonly locations: LocationStorage

  constructor(worldsDir: string) {
    this.worlds = new WorldService(worldsDir)
    // Only reached by `findLocationRoomKeyFuzzy`'s last tier.
    this.locations = new LocationStorage(worldsDir)
  }

  private stateFile(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), '_state.json')
  }

  /** A missing or corrupt file yields empty state: losing it must not stop a
   * world from opening. */
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

  /** Write `_state.json`, stamping `last_updated`. */
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

  saveSuggestions(worldName: string, suggestions: string[]): void {
    const state = this.loadState(worldName)
    state.suggestions = suggestions
    this.saveState(worldName, state)
  }

  loadSuggestions(worldName: string): string[] {
    return this.loadState(worldName).suggestions
  }

  saveArrivalContext(worldName: string, context: ArrivalContext): void {
    const state = this.loadState(worldName)
    state.ui[ARRIVAL_CONTEXT_KEY] = {
      previous_narration: context.previousNarration,
      triggering_action: context.triggeringAction,
      from_location: context.fromLocation,
    }
    this.saveState(worldName, state)
  }

  /** Reads **and deletes**: the payload must colour exactly one arrival
   * narration, or every later turn there re-narrates the journey. */
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

  /** Create or overwrite a mapping, restamping `created_at`. */
  setRoomMapping(worldName: string, roomKey: string, dbRoomId: number, agents: string[] = []): void {
    const state = this.loadState(worldName)
    state.rooms[roomKey] = { dbRoomId, agents, createdAt: localIsoNow() }
    this.saveState(worldName, state)
  }

  getRoomMapping(worldName: string, roomKey: string): RoomMapping | null {
    return this.loadState(worldName).rooms[roomKey] ?? null
  }

  getRoomId(worldName: string, roomKey: string): number | null {
    return this.getRoomMapping(worldName, roomKey)?.dbRoomId ?? null
  }

  getAllRoomMappings(worldName: string): Record<string, RoomMapping> {
    return this.loadState(worldName).rooms
  }

  /**
   * Ensure a room key is mapped, repairing a wrong mapping from the caller's id
   * — the file and the database drift apart when one is restored or hand-edited
   * without the other. A correct mapping is left alone, so the common case does
   * not restamp `last_updated`. `true` when one was created.
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

  /** Clearing `current_room` when it pointed here stops the next turn resolving
   * a room id that no longer exists. */
  deleteRoomMapping(worldName: string, roomKey: string): boolean {
    const state = this.loadState(worldName)
    if (state.rooms[roomKey] === undefined) return false

    delete state.rooms[roomKey]
    if (state.currentRoom === roomKey) state.currentRoom = null
    this.saveState(worldName, state)

    logger.info(`Deleted room mapping ${roomKey} from world ${worldName}`)
    return true
  }

  /**
   * `false` (and no write) when the agent was already there or the room could
   * not be resolved. An unmapped `location:` key is retried fuzzily, then
   * auto-created with a placeholder `db_room_id: 0` that
   * {@link ensureRoomMappingExists} overwrites — the agent list is what had to
   * survive until the database row exists.
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
      if (!isLocationRoomKey(key)) {
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

  /** Same fuzzy retry as {@link addAgentToRoom}, but no auto-create: there is
   * nothing to remove from a room that does not exist. */
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

  // `null` when the key is not a location key or nothing matched.
  private resolveFuzzyLocationKey(worldName: string, roomKey: string): string | null {
    const locationName = RoomMappingService.roomKeyToLocation(roomKey)
    if (locationName === null) return null

    const fuzzyKey = this.findLocationRoomKeyFuzzy(worldName, locationName)
    if (fuzzyKey === null) return null

    logger.info(`Fuzzy matched room key: '${roomKey}' -> '${fuzzyKey}'`)
    return fuzzyKey
  }

  getCurrentRoom(worldName: string): string | null {
    return this.loadState(worldName).currentRoom
  }

  setCurrentRoom(worldName: string, roomKey: string): void {
    const state = this.loadState(worldName)
    state.currentRoom = roomKey
    this.saveState(worldName, state)

    logger.info(`Set current room for ${worldName} to ${roomKey}`)
  }

  getCurrentRoomId(worldName: string): number | null {
    const current = this.getCurrentRoom(worldName)
    if (!current) return null
    return this.getRoomId(worldName, current)
  }

  /**
   * Resolve a location name to a room key tolerantly — the input is a model
   * writing a place name into a tool call. Each tier runs a complete pass before
   * the next begins, so tier order *is* the disambiguation policy. The last tier
   * reads the filesystem and can return an unmapped key, which
   * {@link addAgentToRoom} auto-creates.
   */
  findLocationRoomKeyFuzzy(worldName: string, locationName: string): string | null {
    const state = this.loadState(worldName)
    const search = locationName.toLowerCase()

    // 1. Exact.
    const exactKey = RoomMappingService.locationToRoomKey(locationName)
    if (state.rooms[exactKey] !== undefined) return exactKey

    // An empty location name (the bare key `location:`) is skipped by every
    // remaining tier.
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
    //    had a room created for it. Exact-or-contains only, no prefix pass.
    for (const folder of Object.keys(this.locations.loadAllLocations(worldName))) {
      const folderLower = folder.toLowerCase()
      if (folderLower === search || folderLower.includes(search)) {
        return RoomMappingService.locationToRoomKey(folder)
      }
    }

    return null
  }

  // Statics kept for the many call sites; the functions live in
  // `domain/room-keys.ts` so layers below services can format a key.
  static locationToRoomKey(locationName: string): string {
    return locationToRoomKey(locationName)
  }

  /** `null` for any key that is not a `location:` key. */
  static roomKeyToLocation(roomKey: string): string | null {
    return roomKeyToLocation(roomKey)
  }
}
