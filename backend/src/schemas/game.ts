// Three models are not plain reflections of a table: `World` merges a row with
// `lore.md` and `stats.yaml`, `PlayerState` merges one with the resolved
// inventory/clock/equipment from `player.yaml`, and `Location` reproduces a live
// bug — see `toLocation`.

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

export const WorldBase = z.object({
  name: z.string(),
  /** The player's display name *inside* the world, set during onboarding. */
  user_name: optionalString(),
  language: z.enum(LANGUAGES).default('en'),
})

export type WorldBase = z.infer<typeof WorldBase>

export const WorldCreate = WorldBase

export type WorldCreate = z.infer<typeof WorldCreate>

/** `stat_definitions` is deliberately open: the update path writes it into the
 * TEXT column as-is, while the read path wraps it in `{stats: []}`. */
export const WorldUpdate = z.object({
  phase: z.enum(WORLD_PHASES).nullable().default(null),
  genre: optionalString(),
  theme: optionalString(),
  user_name: optionalString(),
  stat_definitions: z.record(z.string(), z.unknown()).nullable().default(null),
})

export type WorldUpdate = z.infer<typeof WorldUpdate>

/** As authored in `worlds/<world>/stats.yaml`. `max` is optional because uncapped
 * stats exist; `min`/`color` have UI fallbacks. */
export const StatDefinition = z.object({
  name: z.string(),
  display: z.string(),
  min: optionalInt(),
  max: optionalInt(),
  default: pydanticInt().default(0),
  color: optionalString(),
})

export type StatDefinition = z.infer<typeof StatDefinition>

/** `GameStatePanel` reads `world.stat_definitions?.stats`, so the array cannot be
 * hoisted even though nothing else uses the wrapper. */
export const StatDefinitions = z.object({
  stats: StatDefinition.array().default([]),
})

export type StatDefinitions = z.infer<typeof StatDefinitions>

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

export const World = WorldSummary.extend({
  stat_definitions: StatDefinitions.nullable().default(null),
  lore: optionalString(),
})

export type World = z.infer<typeof World>

/** A world in `worlds/` but absent from the database — offered for import. Built
 * from a `WorldConfig`, never a row, so it has no `id` and a hand-made world
 * folder need not carry a `created_at`. */
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

/** Both fields *replace* rather than merge: the `worlds.stat_definitions` column
 * is a cache the read path ignores. */
export interface WorldFilesystemOverlay {
  lore: string | null
  /** Already in `{stats: [...]}` form. */
  stat_definitions: StatDefinitions | null
}

/** Without an overlay `lore` is null and `stat_definitions` comes from the TEXT
 * column, whose shape is not fixed — `{"stats": []}` and a bare `[]` are both in
 * the wild. Every real caller passes the overlay. */
export function toWorld(row: WorldRow, overlay?: WorldFilesystemOverlay): World {
  return {
    ...toWorldSummary(row),
    stat_definitions: overlay ? overlay.stat_definitions : parseStatDefinitionsColumn(row.statDefinitions),
    lore: overlay ? overlay.lore : null,
  }
}

/** Null when the column is unreadable. */
export function parseStatDefinitionsColumn(raw: string | null): StatDefinitions | null {
  return parseJsonColumn(
    raw,
    z.union([StatDefinitions, StatDefinition.array().transform((stats) => ({ stats }))]),
  )
}

/** **Throws** on a malformed entry, unlike the DB-blob decoders that fall back to
 * null: a hand-authored file breaking should be loud. */
export function toStatDefinitions(raw: readonly Record<string, unknown>[]): StatDefinitions {
  return { stats: raw.map((entry) => StatDefinition.parse(entry)) }
}

/** Typed structurally so this module does not depend on the service layer.
 * `language`/`phase` are unvalidated on the config, so both are narrowed here. */
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

export const LocationBase = z.object({
  /** The folder name under `worlds/<world>/locations/`, e.g. `old_mill`. */
  name: z.string(),
  display_name: optionalString(),
  description: optionalString(),
})

export type LocationBase = z.infer<typeof LocationBase>

export const LocationCreate = LocationBase.extend({
  position_x: pydanticInt().default(0),
  position_y: pydanticInt().default(0),
  /** Named `adjacent_to` in, `adjacent_locations` out; the column is the latter. */
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

/** **Reproduces a live bug, deliberately:** when `adjacent_locations` holds JSON,
 * `is_draft` reads `false` whatever the column says. Nothing in `frontend/` reads
 * it. */
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

/** The defaults are hour 8 of day 1 — a world opens at dawn. */
export const GameTime = z.object({
  hour: pydanticInt().default(8),
  minute: pydanticInt().default(0),
  day: pydanticInt().default(1),
})

export type GameTime = z.infer<typeof GameTime>

/** `player.yaml` keys the reference `item_id` and the response calls it `id`;
 * {@link toInventoryItem} renames it so nothing downstream knows both. */
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

/** Unused: no route returns it — `GET .../state` returns a bare `PlayerState`. */
export const GameStateResponse = z.object({
  world: WorldSummary,
  player_state: PlayerState,
  current_location: Location.nullable().default(null),
  suggestions: z.string().array().nullable().default(null),
})

export type GameStateResponse = z.infer<typeof GameStateResponse>

/** The `player.yaml`-sourced half of a player-state response; the matching
 * columns are a cache the read path does not consult. */
export interface PlayerStateOverlay {
  inventory: InventoryEntry[]
  gameTime: GameTime | null
  equipment: Record<string, string | null> | null
}

/** `stats`, `effects` and `action_history` come back `null` when their column is
 * empty, *not* `{}` / `[]`. */
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

/** `item_id` wins over `id`, and an entry with neither — or with no name —
 * becomes `""` rather than an error: a half-written `player.yaml` produces those
 * shapes mid-turn, and a blank row beats 500-ing the panel. */
export function toInventoryItem(entry: InventoryEntry): InventoryItem {
  return {
    id: entry.item_id || entry.id || '',
    name: entry.name ?? '',
    description: entry.description ?? null,
    quantity: entry.quantity ?? 1,
    properties: entry.properties ?? null,
  }
}
