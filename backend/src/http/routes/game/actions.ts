/**
 * `POST /worlds/{id}/action` — the only way a player affects the world, and
 * deliberately fire-and-forget: it validates, writes the message, starts the
 * turn in the background and answers `{status: "processing"}`, since a turn
 * takes tens of seconds and results come back through `/poll`.
 *
 * Three flows, in this order: a slash command (`/chat`, `/end`), a message while
 * chat mode is on (both go to `./chat-mode`), and everything else — the gameplay
 * tape, the only one that bumps the turn counter or the action history.
 */

import { Hono } from 'hono'

import { getLocation } from '@/crud/locations'
import { createMessage } from '@/crud/messages'
import { addActionToHistory, getPlayerState, incrementTurn } from '@/crud/player-state'
import { addGameplayAgentsToRoom, getWorld, updateWorldLastPlayed } from '@/crud/worlds'
import { parseSlashCommand } from '@/domain/slash-commands'
import { getLogger } from '@/infrastructure/logging/logger'
import { PlayerAction } from '@/schemas/game'
import { HttpError } from '@/domain/errors'
import type { AppState } from '@/http/state'
import type { AppEnv } from '@/http/types'
import { handleChatCommand, handleChatModeAction, handleEndCommand } from './chat-mode'
import { intPathParam, parseBody, requireWorld, startBackground, tryCompressImage } from './shared'

const logger = getLogger('GameRouter.Actions')

export function createActionRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.post('/worlds/:world_id/action', async (c) => {
    const worldId = intPathParam(c, 'world_id')
    // Body before world lookup, so a malformed body on a nonexistent world is a
    // 422 rather than a 404.
    const action = await parseBody(c, PlayerAction)
    const world = requireWorld(state, c, worldId)

    const playerState = getPlayerState(state.db, worldId)
    if (!playerState) throw new HttpError(404, 'Player state not found')

    updateWorldLastPlayed(state.db, worldId)

    // The room depends on the phase, not the request: onboarding has one room
    // per world, play has one per location.
    let targetRoomId: number | null = null
    let currentLocationId: number | null = null

    if (world.phase === 'onboarding' && world.onboardingRoomId) {
      targetRoomId = world.onboardingRoomId
    } else if (playerState.currentLocationId) {
      const location = getLocation(state.db, playerState.currentLocationId)
      if (location?.roomId) {
        targetRoomId = location.roomId
        currentLocationId = location.id
      }
    }

    if (!targetRoomId) throw new HttpError(400, 'No target room available')

    const parsed = parseSlashCommand(action.text)

    if (parsed.commandType === 'chat') {
      // 200 with an error envelope, not a 4xx: the frontend shows `message` as
      // a system line, and a rejected slash command is a game rule.
      if (world.phase !== 'active') {
        return c.json({
          status: 'error',
          message: 'Chat mode is only available during active gameplay.',
        })
      }
      return c.json(handleChatCommand(state, worldId, playerState, targetRoomId))
    }

    if (parsed.commandType === 'end') {
      return c.json(handleEndCommand(state, worldId, playerState, targetRoomId, world))
    }

    if (playerState.isChatMode) {
      if (currentLocationId === null) {
        return c.json({
          status: 'error',
          message: 'Cannot process chat mode message without a current location.',
        })
      }
      return c.json(
        await handleChatModeAction(state, {
          worldId,
          playerState,
          roomId: targetRoomId,
          text: action.text,
          world,
          imageData: action.image_data,
          imageMediaType: action.image_media_type,
        }),
      )
    }

    // Hoisted above the three writes (history, turn, message) so they run with
    // no suspension point between them; an `await` in the middle would let a
    // concurrent action interleave its own message row.
    const image = await tryCompressImage(
      action.image_data,
      action.image_media_type,
      `world ${worldId}`,
    )

    // Recorded as "Processing..." and never updated: the history exists to
    // remind the Action Manager what the player has been *attempting*.
    addActionToHistory(state.db, worldId, {
      turn: (playerState.turnCount ?? 0) + 1,
      action: action.text,
      result: 'Processing...',
    })

    const newTurn = incrementTurn(state.db, worldId)

    // Onboarding has no clock, so no snapshot — `player.json` may not even carry
    // a `game_time` yet at that point.
    const gameTimeSnapshot =
      world.phase === 'active'
        ? (state.services.players.loadPlayerState(world.name)?.gameTime ?? null)
        : null

    createMessage(state.db, targetRoomId, {
      content: action.text,
      role: 'user',
      participantType: 'user',
      imageData: image.imageData,
      imageMediaType: image.imageMediaType,
      gameTimeSnapshot,
    })

    const roomId = targetRoomId
    startBackground(
      async () => {
        // A location created before the gameplay agents were seeded has a room
        // with no Action Manager, and the tape needs one. Idempotent.
        addGameplayAgentsToRoom(state.db, roomId)

        // The world row is re-read because a phase sync or another turn may
        // have moved it on since the request handler read it.
        const taskWorld = getWorld(state.db, worldId)
        if (!taskWorld) return
        await state.orchestrator.handlePlayerAction({
          world: taskWorld,
          roomId,
          action: action.text,
        })
      },
      { name: `trigger_trpg_responses:world=${worldId}` },
    )

    logger.info(`Action submitted for world ${worldId}: ${action.text.slice(0, 50)}...`)

    return c.json({
      status: 'processing',
      message: 'Action received, processing turn...',
      turn: newTurn,
    })
  })

  /**
   * Read from `_state.json`, where `suggest_options` writes them mid-turn. The
   * poll response carries the same list, for suggestions saved after the
   * narration but before the next poll.
   */
  routes.get('/worlds/:world_id/action/suggestions', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)
    return c.json({ suggestions: state.services.rooms.loadSuggestions(world.name) })
  })

  return routes
}
