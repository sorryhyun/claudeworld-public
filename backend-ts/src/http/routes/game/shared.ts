/**
 * What the six game route modules share.
 *
 * This module has no Python counterpart on purpose: most of what is here is
 * supplied by FastAPI's framework rather than by `routers/game/` — path and
 * query coercion, the 422 body, `BackgroundTasks` — and Hono supplies none of
 * it.
 *
 * Everything below is either a framework behaviour Hono does not have, or a
 * helper more than one route module needs. Nothing here decides policy: the
 * route modules keep Python's control flow, statuses and `detail` strings.
 */

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
import { GameTimeSnapshot } from '../../../schemas/messages'
import { parseJsonColumn } from '../../../schemas/common'
import { RoomMappingService } from '../../../services/room-mapping'
import { assertWorldAccess } from '../../access-control'
import { HttpError, validationError } from '../../errors'
import { identityOf, type AppState } from '../../state'
import type { AppEnv } from '../../types'

const logger = getLogger('GameRouter')

// =============================================================================
// Request coercion — the half of FastAPI that lives in the signature
// =============================================================================

/**
 * `world_id: int` in a path, as FastAPI validates it.
 *
 * A non-numeric segment is a 422 with pydantic's `int_parsing` body, not a 404
 * and not a 500 on `NaN`. The frontend never sends one, but the parity contract
 * covers status codes for malformed requests too, and a silent `NaN` would
 * otherwise reach the database as `WHERE id = NULL` and read as "world not
 * found" — a different status for the same request.
 */
export function intPathParam(c: Context<AppEnv>, name: string): number {
  return parseIntOr422(c.req.param(name), ['path', name])
}

/** An optional `int` query parameter. Absent (or empty) yields `null`. */
export function intQueryParam(c: Context<AppEnv>, name: string): number | null {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return null
  return parseIntOr422(raw, ['query', name])
}

/** An `int` query parameter with a default, e.g. `limit: int = 50`. */
export function intQueryParamOr(c: Context<AppEnv>, name: string, fallback: number): number {
  return intQueryParam(c, name) ?? fallback
}

/**
 * A `bool` query parameter with a default.
 *
 * The accepted spellings are pydantic's, not JavaScript's: `true/false`,
 * `1/0`, `yes/no`, `y/n`, `on/off`, `t/f`, case-insensitive. `Boolean(raw)`
 * would accept the string `"false"` as true, which is exactly the bug that
 * makes `?poll_onboarding=false` poll the onboarding room.
 */
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
  // Pydantic's lax str→int strips surrounding whitespace and accepts a sign.
  if (raw !== undefined && /^\s*[+-]?\d+\s*$/.test(raw)) return Number(raw.trim())

  throw validationError([
    {
      loc,
      msg: 'Input should be a valid integer, unable to parse string as an integer',
      type: 'int_parsing',
    },
  ])
}

/**
 * Parse a JSON request body against a Zod schema, 422-ing the way FastAPI does.
 *
 * A body that is not JSON at all and a body that fails validation both produce
 * 422 in FastAPI — the first as `json_invalid`, the second as one entry per
 * failed field — so both are produced here rather than collapsing to 400.
 */
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

// =============================================================================
// World lookup + access
// =============================================================================

/**
 * The three lines every handler in `routers/game/` opens with: fetch the world,
 * 404 if it is gone, 403 if it is not yours.
 *
 * `detail` is threaded through because the delete handler says "Not authorized
 * to delete this world" where every other check says "Not your world"; see
 * {@link assertWorldAccess}. `owner_id` is nullable in the schema and Python
 * compares it with `==`, so an ownerless world is reachable by admins only —
 * `?? ''` reproduces that without `userId` ever legitimately being empty.
 */
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

// =============================================================================
// Message shaping
// =============================================================================

/**
 * The eleven-field message dict the poll and location-history endpoints return.
 *
 * Deliberately *not* `schemas.Message`. `routers/game/polling.py` and
 * `routers/game/locations.py` both build this by hand, and it differs from the
 * schema in two ways the frontend depends on: `agent_name` /
 * `agent_profile_pic` are flattened off the joined agent, and `timestamp` is
 * `datetime.isoformat()` — naive, **no `Z`** — where every other timestamp in
 * the API carries one. See {@link naiveIsoTimestamp}.
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
    // Python does a bare `json.loads` here and 500s on a malformed blob; this
    // yields null instead, on the same reasoning as `parseJsonColumn` itself —
    // one bad row must not take down the whole poll the game runs on.
    game_time_snapshot: parseJsonColumn(row.gameTimeSnapshot, GameTimeSnapshot),
  }
}

/**
 * `datetime.isoformat()` on the naive UTC datetime SQLAlchemy stored.
 *
 * Three details are load-bearing: no zone designator (the column is naive), a
 * `T` separator, and the fractional part omitted entirely when the microsecond
 * field is zero. The trailing three digits are padding — `Date` resolves to
 * milliseconds — matching what `src/db/columns.ts` writes back into the column.
 */
export function naiveIsoTimestamp(value: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
  const ms = value.getUTCMilliseconds()
  return ms === 0 ? `${date}T${time}` : `${date}T${time}.${pad(ms, 3)}000`
}

// =============================================================================
// The `worlds/` root
// =============================================================================

/**
 * The `worlds/` directory this app was built against.
 *
 * Needed because `PersistenceManager` is constructed per world and takes the
 * root as an argument, while `AppState` exposes only services already bound to
 * it. Reading `settings.paths.worldsDir` instead would ignore the override
 * `createAppState` accepts and make every test that points at a temp tree read
 * the developer's real worlds; recovering the root from a service that already
 * holds it keeps the two in step.
 *
 * `_` survives `getWorldPath`'s sanitiser unchanged, so the join is exactly one
 * segment deep and `dirname` gives back the root.
 */
export function worldsDirOf(state: AppState): string {
  return dirname(state.services.worlds.getWorldPath('_'))
}

// =============================================================================
// Background work
// =============================================================================

/**
 * Python's game routes start background work two different ways, and neither is
 * "run it now".
 *
 * `spawn_background` (`actions.py`, `chat_mode.py`) wraps `asyncio.create_task`,
 * which schedules the coroutine and returns — the body does not begin until the
 * current synchronous block yields. `background_tasks.add_task` (`worlds.py`,
 * `polling.py`) is later still: FastAPI runs those only once the response has
 * been sent.
 *
 * Passing an async function straight to {@link spawnBackground} would match
 * *neither*, because a JavaScript async function runs synchronously up to its
 * first `await`. With `bun:sqlite` being synchronous, a turn started that way
 * performs its opening block of database writes *inside* the handler, in between
 * the reads the handler has already made and the response it has yet to build —
 * so a caller can observe rows the response has not accounted for.
 *
 * These two wrappers restore the distinction. Both take the same body; they
 * differ only in how long they wait before running it.
 */

/** `asyncio.create_task`: after the current synchronous block, same tick. */
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

/** FastAPI's `BackgroundTasks`: a macrotask later, after the response. */
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

// =============================================================================
// Images
// =============================================================================

/**
 * `utils/images.py::try_compress_image` — **currently a pass-through.**
 *
 * Python decodes the base64, re-encodes it as WebP with Pillow and stores the
 * smaller payload. The TypeScript port has no image library yet (`sharp` is a
 * Phase 3 item in the migration plan), so the original bytes and media type are
 * returned unchanged.
 *
 * That is a *supported* outcome rather than a hole: Python's own function
 * catches every exception from the compressor and returns the originals, so a
 * message written by this backend is byte-for-byte something the Python backend
 * can also produce and read — an uncompressed attachment. What is lost is the
 * payload reduction, not correctness. The function exists as the single place
 * to fix that when `sharp` lands.
 */
export function tryCompressImage(
  imageData: string | null | undefined,
  imageMediaType: string | null | undefined,
  context: string,
): { imageData: string | null; imageMediaType: string | null } {
  if (!imageData || !imageMediaType) {
    return { imageData: imageData ?? null, imageMediaType: imageMediaType ?? null }
  }

  logger.debug(`Image compression unavailable, storing original${context ? ` for ${context}` : ''}`)
  return { imageData, imageMediaType }
}

// =============================================================================
// Filesystem → database location adoption
// =============================================================================

/**
 * Create a database row for a location that exists only on disk.
 *
 * Port of `routers/game/worlds.py::_create_location_from_filesystem`, used by
 * the reset path. Python carries a second, near-identical copy in
 * `services/persistence_manager.py`; that one is ported as
 * `PersistenceManager`'s own private method and is what the polling sync path
 * uses, so neither backend has a single shared implementation here.
 *
 * The room mapping is re-read *before* the location is created and written back
 * after, which is the point of the whole function: a location stubbed out
 * during onboarding may already have characters listed against its room key in
 * `_state.json`, and creating the row mints a fresh room id. Dropping the agent
 * list would leave those characters standing in a room nobody can reach.
 *
 * Returns `null` on any failure, as Python does — a location that cannot be
 * adopted is not a request-level error, it is a world that has to be reset.
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

    // `createLocation` returns the bare row; callers want `room_id`, which is
    // on it, so the room itself is left unresolved rather than re-queried.
    return { ...created, room: null }
  } catch (error) {
    logger.error(`Failed to create location '${locationName}' from filesystem: ${String(error)}`)
    return null
  }
}
