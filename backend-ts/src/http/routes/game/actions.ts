/**
 * Player action routes — port of `backend/routers/game/actions.py`.
 *
 * `POST /worlds/{id}/action` is the only way a player affects the world, and it
 * is deliberately a *fire-and-forget* endpoint: it validates, writes the
 * player's message, starts the turn in the background and answers immediately
 * with `{status: "processing"}`. Everything the agents produce reaches the
 * client through `GET /worlds/{id}/poll`. A turn takes tens of seconds; holding
 * the request open for it would put the whole game behind one HTTP timeout.
 *
 * The same endpoint carries three different flows, chosen in this order:
 *
 * 1. a slash command (`/chat`, `/end`) — dispatched to `./chat-mode`;
 * 2. a message while chat mode is on — also `./chat-mode`;
 * 3. anything else — the gameplay tape.
 *
 * Only the third increments the turn counter or writes to the action history.
 */

import { Hono } from 'hono'

import { getLocation } from '../../../crud/locations'
import { createMessage } from '../../../crud/messages'
import { addActionToHistory, getPlayerState, incrementTurn } from '../../../crud/player-state'
import { addGameplayAgentsToRoom, getWorld, updateWorldLastPlayed } from '../../../crud/worlds'
import { parseSlashCommand } from '../../../domain/slash-commands'
import { getLogger } from '../../../infrastructure/logging/logger'
import { PlayerAction } from '../../../schemas/game'
import { HttpError } from '../../errors'
import type { AppState } from '../../state'
import type { AppEnv } from '../../types'
import { handleChatCommand, handleChatModeAction, handleEndCommand } from './chat-mode'
import { intPathParam, parseBody, requireWorld, startBackground, tryCompressImage } from './shared'

const logger = getLogger('GameRouter.Actions')

export function createActionRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.post('/worlds/:world_id/action', async (c) => {
    const worldId = intPathParam(c, 'world_id')
    // Body before world lookup: FastAPI validates every declared parameter
    // before the handler runs, so a malformed body on a world that does not
    // exist is a 422, not a 404.
    const action = await parseBody(c, PlayerAction)
    const world = requireWorld(state, c, worldId)

    const playerState = getPlayerState(state.db, worldId)
    if (!playerState) throw new HttpError(404, 'Player state not found')

    updateWorldLastPlayed(state.db, worldId)

    // Which room the action lands in depends on the phase, not on the request:
    // during onboarding there is one room for the whole world, and during play
    // there is one per location and only the player's current one is live.
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
      // 200 with an error envelope, not a 4xx: the frontend shows `message` as a
      // system line in the transcript, and a rejected slash command is a game
      // rule rather than a bad request.
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

    // ---- Regular TRPG flow -------------------------------------------------

    // Compressed *before* the first write, not next to the `createMessage` it
    // feeds. Pillow encodes on the calling thread, so Python runs its three
    // writes — history, turn, message — with no suspension point between them;
    // sharp resolves a promise, and an `await` sitting mid-sequence would let a
    // second action for the same world slip its message row in between this
    // one's turn bump and its message. Hoisting the only `await` above the
    // writes restores that block.
    const image = await tryCompressImage(
      action.image_data,
      action.image_media_type,
      `world ${worldId}`,
    )

    // Recorded as "Processing..." and never updated: nothing writes the real
    // outcome back. The history exists to remind the Action Manager what the
    // player has been *attempting*, which the action text alone carries.
    addActionToHistory(state.db, worldId, {
      turn: (playerState.turnCount ?? 0) + 1,
      action: action.text,
      result: 'Processing...',
    })

    const newTurn = incrementTurn(state.db, worldId)

    // Onboarding has no clock, so no snapshot — `player.yaml` may not even carry
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
        // with no Action Manager in it; without this the tape cannot be built
        // and the turn throws. Idempotent, so it runs every turn rather than
        // being conditional on a state nothing tracks.
        addGameplayAgentsToRoom(state.db, roomId)

        // Python opens a fresh DB session here because its request session is
        // already closed. `bun:sqlite` is one synchronous handle with no session
        // lifetime, so `state.db` is used directly — but the world row is still
        // re-read, because a phase sync or another turn may have moved it on.
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
   * The Action Manager's latest suggested next moves.
   *
   * Read straight out of `_state.json`, never the database: `suggest_options`
   * writes them there mid-turn, and the poll response carries the same list for
   * exactly the race this endpoint would otherwise lose — suggestions saved
   * after the narration message but before the next poll.
   */
  routes.get('/worlds/:world_id/action/suggestions', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const world = requireWorld(state, c, worldId)
    return c.json({ suggestions: state.services.rooms.loadSuggestions(world.name) })
  })

  return routes
}
