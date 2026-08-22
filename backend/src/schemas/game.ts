/**
 * TRPG request/response schemas — port of `backend/schemas/game.py`.
 *
 * Three of these models are *not* plain reflections of a table, and the
 * difference is where the parity risk lives:
 *
 * - `World` merges a DB row with two filesystem reads (`lore.md`, `stats.yaml`),
 *   because the filesystem is the source of truth for both.
 * - `PlayerState` is assembled by `routers/game/state.py` from a DB row plus the
 *   *resolved* inventory, clock and equipment out of `player.yaml`. The
 *   `model_validator` on the Python class that reads all of this off an ORM row
 *   instead is dead code — nothing constructs a `PlayerState` that way.
 * - `Location` reproduces a live bug; see {@link toLocation}.
 */

import { z } from 'zod'
import type { PlayerStateWithLocation } from '../crud/player-state'
import type { Location as LocationRow, World as WorldRow } from '../db/schema'
import { LANGUAGES, WORLD_PHASES } from '../db/schema'
import type { InventoryEntry } from '../domain/player-rules'
import {
  isoDatetime,
  optionalBool,
  optionalInt,
  optionalString,
  parseJsonColumn,
  pydanticBool,
  pydanticInt,
  requiredTimestamp,
  serializeBool,
  serializeOptionalUtcDatetime,
} from './common'

// =============================================================================
// World
// =============================================================================

export const WorldBase = z.object({
  name: z.string(),
  /** The player's display name *inside* the world, set during onboarding. */
  user_name: optionalString(),
  language: z.enum(LANGUAGES).default('en'),
})

export type WorldBase = z.infer<typeof WorldBase>

export const WorldCreate = WorldBase

export type WorldCreate = z.infer<typeof WorldCreate>

/**
 * A partial world update.
 *
 * `stat_definitions` is an open `dict` here, not `StatDefinitions` — the update
 * path writes whatever it is given straight into the TEXT column, while the read
 * path wraps it in `{stats: [...]}`. The asymmetry is Python's and is preserved.
 */
export const WorldUpdate = z.object({
  phase: z.enum(WORLD_PHASES).nullable().default(null),
  genre: optionalString(),
  theme: optionalString(),
  user_name: optionalString(),
  stat_definitions: z.record(z.string(), z.unknown()).nullable().default(null),
})

export type WorldUpdate = z.infer<typeof WorldUpdate>

/**
 * One stat the world tracks, as authored in `worlds/<world>/stats.yaml`.
 *
 * `max` is optional because uncapped stats exist (currency, reputation), and
 * `min`/`color` are optional because the frontend has its own fallbacks.
 */
export const StatDefinition = z.object({
  name: z.string(),
  display: z.string(),
  min: optionalInt(),
  max: optionalInt(),
  default: pydanticInt().default(0),
  color: optionalString(),
})

export type StatDefinition = z.infer<typeof StatDefinition>

/**
 * The `{ stats: [...] }` wrapper.
 *
 * It exists purely for frontend compatibility — `GameStatePanel` reads
 * `world.stat_definitions?.stats`, so the array cannot be hoisted to the top
 * level even though nothing else uses the wrapper.
 */
export const StatDefinitions = z.object({
  stats: StatDefinition.array().default([]),
})

export type StatDefinitions = z.infer<typeof StatDefinitions>

/** The world listing shape. */
export const WorldSummary = WorldBase.extend({
  id: pydanticInt(),
  owner_id: optionalString(),
  phase: z.enum(WORLD_PHASES).default('onboarding'),
  genre: optionalString(),
  theme: optionalString(),
  onboarding_room_id: optionalInt(),
  created_at: isoDatetime(),
  updated_at: isoDatetime(),
  last_played_at: isoDatetime().nullable().default(null),
})

export type WorldSummary = z.infer<typeof WorldSummary>

/** The full world: the summary plus the two filesystem-sourced fields. */
export const World = WorldSummary.extend({
  stat_definitions: StatDefinitions.nullable().default(null),
  lore: optionalString(),
})

export type World = z.infer<typeof World>

/**
 * A world present in `worlds/` but absent from the database — offered for import.
 *
 * The only response model with no `from_attributes`: it is built field by field
 * from a `WorldConfig`, never from a row, so it has no `id` and its `created_at`
 * is optional (a hand-made world folder need not carry one).
 */
export const ImportableWorld = z.object({
  name: z.string(),
  owner_id: optionalString(),
  user_name: optionalString(),
  language: z.enum(LANGUAGES).default('en'),
  phase: z.enum(WORLD_PHASES).default('onboarding'),
  genre: optionalString(),
  theme: optionalString(),
  created_at: isoDatetime().nullable().default(null),
})

export type ImportableWorld = z.infer<typeof ImportableWorld>

/** `confirm` is a deliberate speed bump: a reset wipes the world's progress. */
export const WorldResetRequest = z.object({
  confirm: pydanticBool().default(false),
})

export type WorldResetRequest = z.infer<typeof WorldResetRequest>

export const WorldResetResponse = z.object({
  success: z.boolean(),
  message: z.string(),
  world_id: pydanticInt(),
  /** Display name of the location the player was returned to. */
  starting_location: z.string(),
})

export type WorldResetResponse = z.infer<typeof WorldResetResponse>

/** Drizzle row → `WorldSummary` response. */
export function toWorldSummary(row: WorldRow): WorldSummary {
  return {
    name: row.name,
    user_name: row.userName,
    language: row.language ?? 'en',
    id: row.id,
    owner_id: row.ownerId,
    phase: row.phase ?? 'onboarding',
    genre: row.genre,
    theme: row.theme,
    onboarding_room_id: row.onboardingRoomId,
    created_at: requiredTimestamp(row.createdAt, 'WorldSummary', 'created_at'),
    updated_at: requiredTimestamp(row.updatedAt, 'WorldSummary', 'updated_at'),
    last_played_at: serializeOptionalUtcDatetime(row.lastPlayedAt),
  }
}

/**
 * What `routers/game/worlds.py::_build_world_response` overlays on the row.
 *
 * Both come from the filesystem and both *replace* rather than merge: the
 * `worlds.stat_definitions` column is a cache that the read path ignores.
 */
export interface WorldFilesystemOverlay {
  /** `WorldService.load_lore(world.name)`. */
  lore: string | null
  /** `PlayerService.load_stat_definitions(world.name)`, already `{stats: [...]}`. */
  stat_definitions: StatDefinitions | null
}

/**
 * Drizzle row → `World` response.
 *
 * Without an overlay this is `World.model_validate(orm_world)`: `lore` is
 * `null` — the ORM model has no such attribute, so Pydantic falls back to the
 * default — and `stat_definitions` is decoded from the TEXT column. Every real
 * caller passes the overlay, because the route reads both from disk.
 *
 * The column's shape is not fixed: `{"stats": [...]}` and a bare `[...]` are
 * both in the wild, and the validator normalizes them to the former.
 */
export function toWorld(row: WorldRow, overlay?: WorldFilesystemOverlay): World {
  return {
    ...toWorldSummary(row),
    stat_definitions: overlay ? overlay.stat_definitions : parseStatDefinitionsColumn(row.statDefinitions),
    lore: overlay ? overlay.lore : null,
  }
}

/** `worlds.stat_definitions` TEXT → `StatDefinitions`, or null if unreadable. */
export function parseStatDefinitionsColumn(raw: string | null): StatDefinitions | null {
  return parseJsonColumn(
    raw,
    z.union([StatDefinitions, StatDefinition.array().transform((stats) => ({ stats }))]),
  )
}

/**
 * `stats.yaml`'s raw `stats:` list → `StatDefinitions`.
 *
 * This one **throws** on a malformed entry, unlike the DB-blob decoders which
 * fall back to null. The difference is deliberate: a bad JSON blob is one row in
 * a listing and should cost that row's field, while `stats.yaml` is a single
 * hand-authored file whose breakage should be loud rather than silently
 * emptying the player's stat panel. Python raises here too.
 */
export function toStatDefinitions(raw: readonly Record<string, unknown>[]): StatDefinitions {
  return { stats: raw.map((entry) => StatDefinition.parse(entry)) }
}

/**
 * `WorldConfig` → `ImportableWorld`.
 *
 * Typed structurally rather than against `services/world-service.ts`'s
 * `WorldConfig` so this module does not depend on the service layer; the config
 * satisfies it as written. `language` and `phase` are unvalidated strings on the
 * config (a world folder can hold anything), so both are narrowed here with the
 * same fallbacks Pydantic's enum defaults give.
 */
export function toImportableWorld(config: {
  name: string
  ownerId: string | null
  userName: string | null
  language: string
  phase: string
  genre: string | null
  theme: string | null
  createdAt: Date | null
}): ImportableWorld {
  return {
    name: config.name,
    owner_id: config.ownerId,
    user_name: config.userName,
    language: oneOf(LANGUAGES, config.language, 'en'),
    phase: oneOf(WORLD_PHASES, config.phase, 'onboarding'),
    genre: config.genre,
    theme: config.theme,
    created_at: serializeOptionalUtcDatetime(config.createdAt),
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: string, fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

// =============================================================================
// Location
// =============================================================================

export const LocationBase = z.object({
  /** The folder name under `worlds/<world>/locations/`, e.g. `old_mill`. */
  name: z.string(),
  /** The human-readable heading, e.g. `Old Mill`. */
  display_name: optionalString(),
  description: optionalString(),
})

export type LocationBase = z.infer<typeof LocationBase>

export const LocationCreate = LocationBase.extend({
  position_x: pydanticInt().default(0),
  position_y: pydanticInt().default(0),
  /**
   * Named `adjacent_to` on the way in and `adjacent_locations` on the way out.
   * The rename is Python's; the column is `adjacent_locations`.
   */
  adjacent_to: pydanticInt().array().nullable().default(null),
  is_discovered: pydanticBool().default(true),
  /** Set while the Location Designer sub-agent has yet to enrich the stub. */
  is_draft: pydanticBool().default(false),
})

export type LocationCreate = z.infer<typeof LocationCreate>

export const LocationUpdate = z.object({
  name: optionalString(),
  display_name: optionalString(),
  description: optionalString(),
  /** The one field the *user* can set; `PATCH .../locations/{id}` reads only this. */
  label: optionalString(),
  position_x: optionalInt(),
  position_y: optionalInt(),
  is_discovered: optionalBool(),
  is_draft: optionalBool(),
})

export type LocationUpdate = z.infer<typeof LocationUpdate>

export const Location = LocationBase.extend({
  id: pydanticInt(),
  world_id: pydanticInt(),
  label: optionalString(),
  position_x: pydanticInt().default(0),
  position_y: pydanticInt().default(0),
  adjacent_locations: pydanticInt().array().nullable().default(null),
  room_id: optionalInt(),
  is_current: pydanticBool().default(false),
  is_discovered: pydanticBool().default(true),
  is_draft: pydanticBool().default(false),
})

export type Location = z.infer<typeof Location>

/**
 * Drizzle row → `Location` response.
 *
 * **Reproduces a live bug.** `Location.parse_adjacent_locations` rebuilds the
 * model as a dict when `adjacent_locations` holds JSON — and that dict omits
 * `is_draft`, so the field falls back to its default. The result is that
 * `is_draft` is reported honestly only for a location with *no* adjacencies, and
 * reads `false` for every connected location no matter what the column says.
 *
 * It is reproduced rather than fixed for the same reason as the Korean particle
 * bug in `to_system_prompt_markdown` (Open Decision 4 in the migration plan):
 * the Phase 4 gate diffs this backend's responses against Python's, and a silent
 * correction here would show up there as a parity failure with no explanation.
 * Nothing in `frontend/` reads `is_draft`, so fixing it is cheap once someone
 * decides to.
 */
export function toLocation(row: LocationRow): Location {
  const adjacent = row.adjacentLocations
    ? parseJsonColumn(row.adjacentLocations, pydanticInt().array())
    : null
  const rebuilt = adjacent !== null

  return {
    name: row.name,
    display_name: row.displayName,
    description: row.description,
    id: row.id,
    world_id: row.worldId,
    label: row.label,
    position_x: row.positionX ?? 0,
    position_y: row.positionY ?? 0,
    adjacent_locations: adjacent,
    room_id: row.roomId,
    is_current: serializeBool(row.isCurrent),
    is_discovered: row.isDiscovered ?? true,
    is_draft: rebuilt ? false : serializeBool(row.isDraft),
  }
}

// =============================================================================
// Player state
// =============================================================================

/** The in-world clock. The defaults are hour 8 of day 1 — a world opens at dawn. */
export const GameTime = z.object({
  hour: pydanticInt().default(8),
  minute: pydanticInt().default(0),
  day: pydanticInt().default(1),
})

export type GameTime = z.infer<typeof GameTime>

/**
 * One inventory entry, resolved against its item template.
 *
 * `player.yaml` stores references keyed `item_id`; the response calls the same
 * field `id`. {@link toInventoryItem} does the rename, which is why nothing
 * downstream has to know both spellings.
 */
export const InventoryItem = z.object({
  id: z.string(),
  name: z.string(),
  description: optionalString(),
  quantity: pydanticInt().default(1),
  properties: z.record(z.string(), z.unknown()).nullable().default(null),
})

export type InventoryItem = z.infer<typeof InventoryItem>

export const PlayerStateBase = z.object({
  turn_count: pydanticInt().default(0),
})

export type PlayerStateBase = z.infer<typeof PlayerStateBase>

export const PlayerState = PlayerStateBase.extend({
  id: pydanticInt(),
  world_id: pydanticInt(),
  current_location_id: optionalInt(),
  /** Denormalized from the joined location for the header; not a column. */
  current_location_name: optionalString(),
  stats: z.record(z.string(), z.unknown()).nullable().default(null),
  inventory: InventoryItem.array().nullable().default(null),
  effects: z.record(z.string(), z.unknown()).array().nullable().default(null),
  action_history: z.record(z.string(), z.unknown()).array().nullable().default(null),
  is_chat_mode: pydanticBool().default(false),
  /** Where the transcript resumes when chat mode is left. */
  chat_mode_start_message_id: optionalInt(),
  game_time: GameTime.nullable().default(null),
  /** `slot_name -> item_id`, with `null` for an empty slot. */
  equipment: z.record(z.string(), z.unknown()).nullable().default(null),
})

export type PlayerState = z.infer<typeof PlayerState>

export const PlayerAction = z.object({
  text: z.string(),
  image_data: optionalString(),
  image_media_type: optionalString(),
})

export type PlayerAction = z.infer<typeof PlayerAction>

/**
 * Declared by `schemas/game.py` and used by nothing — no route returns it.
 * `GET .../state` returns a bare `PlayerState` and the world and location come
 * from their own endpoints. Ported so the module is complete.
 */
export const GameStateResponse = z.object({
  world: WorldSummary,
  player_state: PlayerState,
  current_location: Location.nullable().default(null),
  suggestions: z.string().array().nullable().default(null),
})

export type GameStateResponse = z.infer<typeof GameStateResponse>

/**
 * The `player.yaml`-sourced half of a player-state response.
 *
 * All three are filesystem-primary: `player.yaml` is the source of truth and the
 * `player_states` columns are a cache the read path does not consult. When there
 * is no `player.yaml` at all, `game_time` and `equipment` are both null — that
 * is the shape `routers/game/state.py` produces and the frontend renders as "no
 * clock yet".
 */
export interface PlayerStateOverlay {
  /** `PlayerService.getResolvedInventory(worldName)`. */
  inventory: InventoryEntry[]
  gameTime: GameTime | null
  equipment: Record<string, string | null> | null
}

/**
 * Drizzle row + filesystem overlay → `PlayerState` response.
 *
 * Port of `routers/game/state.py::get_game_state`, which is the only thing that
 * builds this model. Note `stats`, `effects` and `action_history` are `null`
 * when their column is empty, *not* `{}` / `[]` — the route decodes them with a
 * bare `json.loads` guarded by a truthiness check, so an unset column and an
 * empty one both come back as null. `PlayerStateSerializer`'s empty-collection
 * defaults are not in play on this path.
 */
export function toPlayerState(row: PlayerStateWithLocation, overlay: PlayerStateOverlay): PlayerState {
  const location = row.currentLocation
  return {
    turn_count: row.turnCount ?? 0,
    id: row.id,
    world_id: row.worldId,
    current_location_id: row.currentLocationId,
    current_location_name: location ? (location.displayName ?? location.name) : null,
    stats: parseJsonColumn(row.stats, z.record(z.string(), z.unknown())),
    inventory: overlay.inventory.map(toInventoryItem),
    effects: parseJsonColumn(row.effects, z.record(z.string(), z.unknown()).array()),
    action_history: parseJsonColumn(row.actionHistory, z.record(z.string(), z.unknown()).array()),
    is_chat_mode: serializeBool(row.isChatMode),
    chat_mode_start_message_id: row.chatModeStartMessageId,
    game_time: overlay.gameTime,
    equipment: overlay.equipment,
  }
}

/**
 * A resolved `player.yaml` entry → `InventoryItem`.
 *
 * `item_id` wins over `id` when both are present, and an entry with neither
 * becomes `""` rather than an error — Python's `item.get("item_id") or
 * item.get("id", "")`. An unnamed item likewise becomes `""`. Both are the
 * shapes a partially-written `player.yaml` produces mid-turn, and rendering a
 * blank row beats 500-ing the game panel.
 */
export function toInventoryItem(entry: InventoryEntry): InventoryItem {
  return {
    id: entry.item_id || entry.id || '',
    name: entry.name ?? '',
    description: entry.description ?? null,
    quantity: entry.quantity ?? 1,
    properties: entry.properties ?? null,
  }
}
