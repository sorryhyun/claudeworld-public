/**
 * Read-only game state for the right-hand panel. **The filesystem wins on every
 * field it owns** — inventory, clock, equipment, stat definitions — and the
 * matching `player_states` columns are a cache these routes deliberately skip:
 * a turn's tools write the files first, so the columns would show a panel one
 * turn behind the prose. Stat *values* are the exception.
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

  routes.get('/worlds/:world_id/state', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)

    const playerState = getPlayerState(state.db, worldId)
    if (!playerState) throw new HttpError(404, 'Player state not found')

    const fsState = state.services.players.loadPlayerState(world.name)

    return c.json(
      toPlayerState(playerState, {
        inventory: state.services.players.getResolvedInventory(world.name),
        // Both null without a `player.json` — the frontend renders that as
        // "no clock yet" during onboarding.
        gameTime: fsState ? GameTime.parse(fsState.gameTime) : null,
        equipment: fsState ? (fsState.equipment ?? {}) : null,
      }),
    )
  })

  // **No 404 when the player state is missing**, unlike `/state` above: a world
  // mid-creation renders empty bars, which is what the panel expects.
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

  routes.get('/worlds/:world_id/state/inventory', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)

    const resolved = state.services.players.getResolvedInventory(world.name)
    return c.json({ items: resolved, count: resolved.length })
  })

  // Every template under `worlds/<name>/items/` — what *exists*, where
  // `/state/inventory` is what is *carried*.
  routes.get('/worlds/:world_id/items', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)

    const all = state.items.getAllItemsInWorld(world.name)
    logger.debug(`Loaded ${all.length} item templates for world '${world.name}'`)
    return c.json({ items: all, count: all.length })
  })

  return routes
}
