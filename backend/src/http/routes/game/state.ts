/**
 * Game state queries — port of `backend/routers/game/state.py`.
 *
 * Four read-only endpoints feeding the right-hand game panel. What they have in
 * common is worth naming once: **the filesystem wins on every field it owns.**
 * `player.yaml` holds the authoritative inventory, clock and equipment, and
 * `stats.yaml` the stat definitions; the matching `player_states` columns are a
 * cache that these routes deliberately do not read for those fields. A turn's
 * tools write the files first, so reading the columns instead would show the
 * player a panel one turn behind the prose they are looking at.
 *
 * The `stats` *values* are the exception — those do come from the column, since
 * `crud/player_state.py` is what mutates them.
 */

import { Hono } from 'hono'
import { z } from 'zod'

import { getPlayerState } from '../../../crud/player-state'
import { getLogger } from '../../../infrastructure/logging/logger'
import { parseJsonColumn } from '../../../schemas/common'
import { GameTime, toPlayerState } from '../../../schemas/game'
import { HttpError } from '../../errors'
import type { AppState } from '../../state'
import type { AppEnv } from '../../types'
import { intPathParam, requireWorld } from './shared'

const logger = getLogger('GameRouter.State')

export function createStateRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  /** The full player state: stats, resolved inventory, location, clock. */
  routes.get('/worlds/:world_id/state', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)

    const playerState = getPlayerState(state.db, worldId)
    if (!playerState) throw new HttpError(404, 'Player state not found')

    const fsState = state.services.players.loadPlayerState(world.name)

    return c.json(
      toPlayerState(playerState, {
        inventory: state.services.players.getResolvedInventory(world.name),
        // Both null when there is no `player.yaml` at all — the shape the
        // frontend renders as "no clock yet" during onboarding.
        gameTime: fsState ? GameTime.parse(fsState.gameTime) : null,
        equipment: fsState ? (fsState.equipment ?? {}) : null,
      }),
    )
  })

  /**
   * Stat definitions plus current values, for the stat bars.
   *
   * **No 404 when the player state is missing**, unlike `/state` above: Python
   * fetches the row, never checks it, and falls back to `{}` for the values. A
   * world mid-creation therefore renders empty bars rather than an error, which
   * is the behaviour the panel is written against.
   */
  routes.get('/worlds/:world_id/state/stats', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)

    const playerState = getPlayerState(state.db, worldId)
    const definitions = state.services.players.loadStatDefinitions(world.name).stats

    return c.json({
      definitions,
      current: parseJsonColumn(playerState?.stats ?? null, z.record(z.string(), z.unknown())) ?? {},
    })
  })

  /** The inventory, with every reference resolved against its item template. */
  routes.get('/worlds/:world_id/state/inventory', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)

    const resolved = state.services.players.getResolvedInventory(world.name)
    return c.json({ items: resolved, count: resolved.length })
  })

  /**
   * The world's item catalogue — every template under `worlds/<name>/items/`,
   * whether or not the player holds one.
   *
   * Distinct from `/state/inventory`: this is what *exists*, that is what is
   * *carried*. The crafting and shop UIs read this one.
   */
  routes.get('/worlds/:world_id/items', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)

    const all = state.items.getAllItemsInWorld(world.name)
    logger.debug(`Loaded ${all.length} item templates for world '${world.name}'`)
    return c.json({ items: all, count: all.length })
  })

  return routes
}
