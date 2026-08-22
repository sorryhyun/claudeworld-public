/** Request coercion, the 422 body Hono lacks, and cross-route helpers. */

import { dirname } from 'node:path'
import type { Context } from 'hono'
import { z } from 'zod'

import { addAgentToRoom } from '../../../crud/rooms'
import { createLocation, type LocationWithRoom } from '../../../crud/locations'
import { getAgentByName } from '../../../crud/agents'
import type { MessageWithAgent } from '../../../crud/messages'
import { getWorld } from '../../../crud/worlds'
import type { World } from '../../../db/schema'
import { spawnBackground } from '../../../infrastructure/background'
import { getLogger } from '../../../infrastructure/logging/logger'
import { tryCompressImage as compressImage } from '../../../lib/images'
import { GameTimeSnapshot } from '../../../schemas/messages'
import { parseJsonColumn } from '../../../schemas/common'
import { RoomMappingService } from '../../../services/room-mapping'
import { assertWorldAccess } from '../../access-control'
import { HttpError, validationError } from '../../errors'
import { identityOf, type AppState } from '../../state'
import type { AppEnv } from '../../types'

const logger = getLogger('GameRouter')

/** A non-numeric segment is a 422; a silent `NaN` would read as "not found". */
export function intPathParam(c: Context<AppEnv>, name: string): number {
  return parseIntOr422(c.req.param(name), ['path', name])
}

export function intQueryParam(c: Context<AppEnv>, name: string): number | null {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return null
  return parseIntOr422(raw, ['query', name])
}

export function intQueryParamOr(c: Context<AppEnv>, name: string, fallback: number): number {
  return intQueryParam(c, name) ?? fallback
}

/** `Boolean(raw)` would read the string `"false"` as true. Hence the sets below. */
export function boolQueryParam(c: Context<AppEnv>, name: string, fallback: boolean): boolean {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return fallback

  const normalized = raw.trim().toLowerCase()
  if (TRUE_SPELLINGS.has(normalized)) return true
  if (FALSE_SPELLINGS.has(normalized)) return false

  throw validationError([
    {
      loc: ['query', name],
      msg: 'Input should be a valid boolean, unable to interpret input',
      type: 'bool_parsing',
    },
  ])
}

const TRUE_SPELLINGS = new Set(['true', '1', 'yes', 'y', 'on', 't'])
const FALSE_SPELLINGS = new Set(['false', '0', 'no', 'n', 'off', 'f'])

function parseIntOr422(raw: string | undefined, loc: (string | number)[]): number {
  // Surrounding whitespace is stripped and a sign is accepted.
  if (raw !== undefined && /^\s*[+-]?\d+\s*$/.test(raw)) return Number(raw.trim())

  throw validationError([
    {
      loc,
      msg: 'Input should be a valid integer, unable to parse string as an integer',
      type: 'int_parsing',
    },
  ])
}

/** Unparseable JSON and failed validation both 422, never 400. */
export async function parseBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw validationError([
      { loc: ['body'], msg: 'Invalid JSON body', type: 'json_invalid' },
    ])
  }

  const result = schema.safeParse(raw)
  if (result.success) return result.data

  throw validationError(
    result.error.issues.map((issue) => ({
      loc: ['body', ...issue.path.map((segment) => segment as string | number)],
      msg: issue.message,
      type: issue.code,
    })),
  )
}

/** 404 if gone, 403 if not yours. An ownerless world is admin-only. */
export function requireWorld(
  state: AppState,
  c: Context<AppEnv>,
  worldId: number,
  detail?: string,
): World {
  const world = getWorld(state.db, worldId)
  if (!world) throw new HttpError(404, 'World not found')
  assertWorldAccess(identityOf(c), world.ownerId ?? '', detail)
  return world
}

/**
 * Deliberately *not* the `Message` schema: agent fields are flattened and
 * `timestamp` is naive — **no `Z`** — unlike every other API timestamp.
 */
export interface PollMessage {
  id: number
  content: string
  role: string
  agent_id: number | null
  agent_name: string | null
  agent_profile_pic: string | null
  thinking: string | null
  timestamp: string | null
  image_data: string | null
  image_media_type: string | null
  game_time_snapshot: Record<string, number> | null
}

export function toPollMessage(row: MessageWithAgent): PollMessage {
  return {
    id: row.id,
    content: row.content,
    role: row.role,
    agent_id: row.agentId,
    agent_name: row.agent?.name ?? null,
    agent_profile_pic: row.agent?.profilePic ?? null,
    thinking: row.thinking,
    timestamp: row.timestamp ? naiveIsoTimestamp(row.timestamp) : null,
    image_data: row.imageData,
    image_media_type: row.imageMediaType,
    // Null rather than a throw: one malformed blob must not take down the
    // whole poll the game runs on.
    game_time_snapshot: parseJsonColumn(row.gameTimeSnapshot, GameTimeSnapshot),
  }
}

/** No zone, a `T`, no fraction at zero — as `src/db/columns.ts` writes it. */
export function naiveIsoTimestamp(value: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
  const ms = value.getUTCMilliseconds()
  return ms === 0 ? `${date}T${time}` : `${date}T${time}.${pad(ms, 3)}000`
}

/** Recovered from a bound service so a test never reads the real `worlds/`. */
export function worldsDirOf(state: AppState): string {
  return dirname(state.services.worlds.getWorldPath('_'))
}

/**
 * Background work must never start "now": an async function runs synchronously
 * to its first `await` and `bun:sqlite` is synchronous, so a body handed
 * straight to {@link spawnBackground} writes to the database *in* the handler.
 */

/** After the current synchronous block, same tick (a microtask). */
export function startBackground(
  body: (signal: AbortSignal) => Promise<unknown>,
  options: { name: string },
): void {
  void spawnBackground(async (signal) => {
    await Promise.resolve()
    if (signal.aborted) return
    return body(signal)
  }, options)
}

/** A macrotask later, so after the response has been sent. */
export function deferBackground(
  body: (signal: AbortSignal) => Promise<unknown>,
  options: { name: string },
): void {
  void spawnBackground(async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (signal.aborted) return
    return body(signal)
  }, options)
}

/** The `await` is a suspension point: keep it above any run of database writes. */
export async function tryCompressImage(
  imageData: string | null | undefined,
  imageMediaType: string | null | undefined,
  context: string,
): Promise<{ imageData: string | null; imageMediaType: string | null }> {
  const compressed = await compressImage(imageData, imageMediaType, context)
  return { imageData: compressed.data, imageMediaType: compressed.mediaType }
}

/**
 * Adopt a location that exists only on disk. The room mapping is re-read before
 * the row is created and written back after: creating it mints a fresh room id,
 * and dropping the agent list would strand those characters.
 */
export function createLocationFromFilesystem(
  state: AppState,
  worldName: string,
  worldId: number,
  locationName: string,
): LocationWithRoom | null {
  try {
    const config = state.services.locations.loadLocation(worldName, locationName)
    if (!config) {
      logger.warning(`Location '${locationName}' not found in filesystem`)
      return null
    }

    const roomKey = RoomMappingService.locationToRoomKey(locationName)
    const existingMapping = state.services.rooms.getRoomMapping(worldName, roomKey)
    const existingAgents = existingMapping?.agents ?? []

    const created = createLocation(state.db, worldId, {
      name: locationName,
      displayName: config.displayName,
      description: config.description || '',
      positionX: config.position[0],
      positionY: config.position[1],
      adjacentTo: null,
      isDiscovered: config.isDiscovered,
      isDraft: config.isDraft,
    })
    logger.info(`Created location '${locationName}' in database (id=${created.id})`)

    if (created.roomId) {
      state.services.rooms.setRoomMapping(worldName, roomKey, created.roomId, existingAgents)
      for (const agentName of existingAgents) {
        const agent = getAgentByName(state.db, agentName)
        if (agent) addAgentToRoom(state.db, created.roomId, agent.id)
      }
      if (existingAgents.length > 0) {
        logger.info(`Added ${existingAgents.length} agents to room ${created.roomId}`)
      }
    }

    // Callers want `room_id`, which the bare row carries; the room is not
    // re-queried.
    return { ...created, room: null }
  } catch (error) {
    logger.error(`Failed to create location '${locationName}' from filesystem: ${String(error)}`)
    return null
  }
}
