/**
 * Polling — port of `backend/routers/game/polling.py`.
 *
 * `GET /worlds/{id}/poll` is the endpoint the entire frontend lives on: it runs
 * every two seconds per open world and is the only way messages, stats, the
 * phase, the clock and the suggestion buttons reach the client. There is no
 * websocket and no SSE on this path.
 *
 * It is also the subtlest module in the game surface, because it is not a read.
 * Four things happen here that mutate state, and each one exists because the
 * agent side of the app writes to the *filesystem* and something has to notice:
 *
 * 1. **Phase sync.** `world.yaml` is the source of truth for a world's phase.
 *    The onboarding `complete` tool flips it there, and this is the request that
 *    copies it onto the row — which is what makes the "Enter World" button
 *    appear.
 * 2. **Player-state sync.** When onboarding finishes, the World Seed Generator
 *    has written `player.yaml` with stats, an inventory and a starting location,
 *    but the database knows none of it. The first poll after the transition
 *    imports all three, creating the starting location's row from disk if the
 *    seed generator invented it.
 * 3. **The arrival message.** Immediately after that import, this endpoint
 *    writes the "<player> arrives at <place>" system line into the starting
 *    room. It is a real message, in the transcript, and it is also
 *    4. **the first turn** — replayed as the action a background task hands to
 *    the Action Manager, which is how a brand-new world produces its opening
 *    scene without the player typing anything.
 *
 * Steps 2-4 are one-shot by construction: they run only while the phase is
 * `active` and the row still has no `current_location_id`, and step 2 is what
 * fills that in.
 */

import { Hono } from 'hono'
import { z } from 'zod'

import { getAgentsCached } from '../../../crud/cached'
import { getLocation } from '../../../crud/locations'
import {
  createMessage,
  getMessages,
  getMessagesExcludingChat,
  getMessagesSince,
  type MessageWithAgent,
} from '../../../crud/messages'
import { getPlayerState } from '../../../crud/player-state'
import { getWorld, updateWorld } from '../../../crud/worlds'
import type { Location, World, WorldPhase } from '../../../db/schema'
import { isActionManager } from '../../../domain/agent'
import { toLangKey } from '../../../domain/enums'
import { getArrivalMessage } from '../../../domain/localization'
import { getLogger } from '../../../infrastructure/logging/logger'
import { parseJsonColumn } from '../../../schemas/common'
import { PersistenceManager } from '../../../services/persistence-manager'
import type { AppState } from '../../state'
import type { AppEnv } from '../../types'
import {
  boolQueryParam,
  deferBackground,
  intPathParam,
  intQueryParam,
  requireWorld,
  toPollMessage,
  worldsDirOf,
  type PollMessage,
} from './shared'

const logger = getLogger('GameRouter.Polling')

/** The `state` block of the poll response. Read field-for-field by `usePolling`. */
interface PollState {
  stats: Record<string, unknown>
  inventory_count: number
  turn_count: number
  phase: WorldPhase
  /** Set by the onboarding `complete` tool; drives the "Enter World" button. */
  pending_phase: string | null
  is_chat_mode: boolean
  /** Where the transcript resumes after chat mode; see `./chat-mode`. */
  chat_mode_start_message_id: number | null
  game_time: { hour: number; minute: number; day: number } | null
}

interface PollResponseBody {
  messages: PollMessage[]
  state: PollState | null
  location?: { id: number; name: string }
  suggestions?: string[]
}

export function createPollingRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/worlds/:world_id/poll', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const sinceMessageId = intQueryParam(c, 'since_message_id')
    /**
     * Keeps the client on the onboarding room after the phase has already
     * flipped to `active`. The transition happens mid-conversation, and without
     * this the interview's last few lines would vanish from under the player the
     * instant the seed generator finished.
     */
    const pollOnboarding = boolQueryParam(c, 'poll_onboarding', false)

    let world = requireWorld(state, c, worldId)

    // ---- 1. Filesystem → database sync ------------------------------------
    //
    // A near-copy of `worlds.ts::syncWorldFromFs`, kept separate for the reason
    // Python keeps it separate: the new phase is needed *before* the write, to
    // route this very request. Calling the shared helper and re-reading the row
    // would work but would hide that dependency.
    const fsConfig = state.services.worlds.loadWorldConfig(world.name)
    let currentPhase: WorldPhase = world.phase ?? 'onboarding'

    if (fsConfig) {
      const updates: Parameters<typeof updateWorld>[2] = {}
      let changed = false

      if (fsConfig.phase !== world.phase) {
        logger.info(
          `Phase mismatch for world ${world.name}: DB=${String(world.phase)}, FS=${fsConfig.phase}. Syncing.`,
        )
        currentPhase = asWorldPhase(fsConfig.phase)
        updates.phase = currentPhase
        changed = true
      }
      if (fsConfig.userName && fsConfig.userName !== world.userName) {
        logger.info(
          `user_name mismatch for world ${world.name}: DB=${String(world.userName)}, FS=${fsConfig.userName}. Syncing.`,
        )
        updates.userName = fsConfig.userName
        changed = true
      }
      if (fsConfig.genre && fsConfig.genre !== world.genre) {
        logger.info(
          `genre mismatch for world ${world.name}: DB=${String(world.genre)}, FS=${fsConfig.genre}. Syncing.`,
        )
        updates.genre = fsConfig.genre
        changed = true
      }
      if (fsConfig.theme && fsConfig.theme !== world.theme) {
        logger.info(
          `theme mismatch for world ${world.name}: DB=${String(world.theme)}, FS=${fsConfig.theme}. Syncing.`,
        )
        updates.theme = fsConfig.theme
        changed = true
      }

      if (changed) {
        updateWorld(state.db, worldId, updates)
        world = getWorld(state.db, worldId)!
      }
    }

    let playerState = getPlayerState(state.db, worldId)

    // ---- 2. Which room is this poll about? --------------------------------
    let targetRoomId: number | null = null
    let location: Location | null = null

    if ((pollOnboarding || currentPhase === 'onboarding') && world.onboardingRoomId) {
      targetRoomId = world.onboardingRoomId
    } else if (currentPhase === 'active' && !pollOnboarding) {
      // The one-shot post-onboarding import. `current_location_id` being null
      // while the world is already active is the precise signature of "the seed
      // generator finished and nothing has adopted its output yet".
      if (playerState && !playerState.currentLocationId) {
        const fsState = state.services.players.loadPlayerState(world.name)
        if (fsState?.currentLocation) {
          logger.info(`Syncing player state from filesystem for world '${world.name}'`)
          new PersistenceManager(
            state.db,
            worldId,
            world.name,
            worldsDirOf(state),
          ).syncPlayerStateFromFilesystem()
          playerState = getPlayerState(state.db, worldId)

          if (playerState?.currentLocationId) {
            const arrivalLocation = getLocation(state.db, playerState.currentLocationId)
            if (arrivalLocation?.roomId) {
              const locationName = arrivalLocation.displayName || arrivalLocation.name
              const language = toLangKey(world.language)
              const userName = world.userName || (language === 'ko' ? '여행자' : 'The traveler')
              const arrivalContent = getArrivalMessage(userName, locationName, language)

              createMessage(state.db, arrivalLocation.roomId, {
                content: arrivalContent,
                role: 'user',
                participantType: 'system',
                participantName: 'System',
              })
              logger.info(`Sent arrival message for '${userName}' at '${locationName}'`)

              const sceneRoomId = arrivalLocation.roomId
              deferBackground(
                async () => {
                  const taskWorld = getWorld(state.db, worldId)
                  if (!taskWorld) return
                  await state.orchestrator.handlePlayerAction({
                    world: taskWorld,
                    roomId: sceneRoomId,
                    action: arrivalContent,
                  })
                },
                { name: `poll_initial_scene:world=${worldId}` },
              )
              logger.info('Polling: Triggered initial scene generation after phase transition')
            }
          }
        }
      }

      if (playerState?.currentLocationId) {
        const current = getLocation(state.db, playerState.currentLocationId)
        if (current?.roomId) {
          location = current
          targetRoomId = current.roomId
        }
      }
    }

    // No room means there is nothing to show yet — an active world whose
    // starting location has not been adopted, or an onboarding world with no
    // room. The client keeps polling; this is not an error.
    if (!targetRoomId) {
      return c.json<PollResponseBody>({ messages: [], state: null })
    }

    // ---- 3. Messages ------------------------------------------------------
    //
    // Chat mode and gameplay share a room; `chat_session_id` partitions them.
    // Which half this poll wants depends on the mode the *player* is in, except
    // during onboarding, where there is no chat mode and everything is shown.
    const isChatMode = playerState?.isChatMode ?? false

    let messages: MessageWithAgent[]
    if (sinceMessageId) {
      messages = getMessagesSince(state.db, targetRoomId, sinceMessageId, 50)
      if (!isChatMode && !pollOnboarding) {
        messages = messages.filter((m) => m.chatSessionId === null)
      }
    } else if (isChatMode || pollOnboarding) {
      messages = getMessages(state.db, targetRoomId)
    } else {
      messages = getMessagesExcludingChat(state.db, targetRoomId)
    }

    // System messages are the game talking to itself — onboarding triggers,
    // chat-mode markers, the arrival line the Action Manager answers. The player
    // sees the answer, not the prompt.
    const visible = messages.filter((m) => m.participantType !== 'system')

    const fsState = state.services.players.loadPlayerState(world.name)
    const gameTime = fsState?.gameTime
      ? {
          hour: fsState.gameTime.hour ?? 8,
          minute: fsState.gameTime.minute ?? 0,
          day: fsState.gameTime.day ?? 1,
        }
      : null

    const response: PollResponseBody = {
      messages: visible.map(toPollMessage),
      state: {
        stats: parseJsonColumn(playerState?.stats ?? null, z.record(z.string(), z.unknown())) ?? {},
        inventory_count:
          parseJsonColumn(playerState?.inventory ?? null, z.unknown().array())?.length ?? 0,
        turn_count: playerState?.turnCount ?? 0,
        // The synced phase, not the row's — the row may have been read before
        // the write above landed.
        phase: currentPhase,
        pending_phase: fsConfig?.pendingPhase ?? null,
        is_chat_mode: playerState?.isChatMode ?? false,
        chat_mode_start_message_id: playerState?.chatModeStartMessageId ?? null,
        game_time: gameTime,
      },
    }

    // Absent during onboarding rather than null: the key itself is only added
    // when a location is in play, and the frontend distinguishes the two.
    if (location) {
      response.location = { id: location.id, name: location.displayName || location.name }
    }

    // Always sent, even unchanged. `suggest_options` can write these *after* the
    // narration message is persisted but before the next poll, so a client that
    // fetched them only when messages arrived would miss the ones belonging to
    // the turn it just rendered.
    response.suggestions = state.services.rooms.loadSuggestions(world.name)

    return c.json(response)
  })

  /**
   * Who is currently thinking, and what they have produced so far.
   *
   * Polled alongside `/poll` to render the typing indicators. Three kinds of row
   * can appear:
   *
   * - **real agents** with a live session in the room;
   * - **the World Seed Generator** (`id: -1`), which does tens of seconds of work
   *   during onboarding's `complete` tool without owning a room agent;
   * - **a Task sub-agent** (`id: -2`), same situation mid-turn.
   *
   * The two negative ids are virtual and Python's; the frontend keys rows by id
   * and would collapse them into one another if they shared a value.
   *
   * **Gap: `thinking_text` and `response_text` are always empty.** Python reads
   * them from `AgentManager.get_streaming_state_for_room`, a per-room registry of
   * partially-streamed responses. The TypeScript SDK layer keeps that state on
   * the turn instead of on a manager (see `sdk/agent/turn-runner.ts`), and
   * nothing publishes it per room yet, so the indicator shows *that* an agent is
   * working but not what it has written. `has_narrated` — the flag that actually
   * unblocks the player's input — is fully wired.
   */
  routes.get('/worlds/:world_id/chatting-agents', (c) => {
    const worldId = intPathParam(c, 'world_id')
    const pollOnboarding = boolQueryParam(c, 'poll_onboarding', false)
    const world = requireWorld(state, c, worldId)

    const targetRoomId = chattingAgentsRoom(state, world, pollOnboarding)
    if (!targetRoomId) return c.json({ chatting_agents: [] })

    const chattingAgentIds = state.orchestrator.getChattingAgents(targetRoomId)
    const chattingAgents: Record<string, unknown>[] = []

    if (chattingAgentIds.length > 0) {
      const byId = new Map(getAgentsCached(state.db, targetRoomId).map((a) => [a.id, a]))

      for (const agentId of chattingAgentIds) {
        const agent = byId.get(agentId)
        if (!agent) continue

        const info: Record<string, unknown> = {
          id: agent.id,
          name: agent.name,
          // The Action Manager is a narrator, not a character: showing its
          // avatar would put a face on the prose.
          profile_pic: isActionManager(agent.name) ? null : agent.profilePic,
          thinking_text: '',
          response_text: '',
        }
        if (isActionManager(agent.name)) {
          info.has_narrated = state.orchestrator.hasNarrationProduced(targetRoomId)
        }
        chattingAgents.push(info)
      }
    }

    const seedStatus = state.orchestrator.getSeedGenerationStatus(targetRoomId)
    if (seedStatus) {
      chattingAgents.push({
        id: -1,
        name: seedStatus.name || 'World Seed Generator',
        profile_pic: null,
        thinking_text: seedStatus.thinkingText || 'Creating your world...',
        response_text: seedStatus.responseText,
      })
    }

    const subAgentStatus = state.orchestrator.getSubAgentStatus(targetRoomId)
    if (subAgentStatus) {
      chattingAgents.push({
        id: -2,
        name: subAgentStatus.name || 'Processing',
        profile_pic: null,
        thinking_text: subAgentStatus.thinkingText || 'Processing...',
        response_text: subAgentStatus.responseText,
      })
    }

    return c.json({ chatting_agents: chattingAgents })
  })

  return routes
}

/**
 * Which room `/chatting-agents` reports on.
 *
 * Deliberately *not* the same selection as `/poll`: this one reads the row's
 * phase rather than the filesystem's, and it has no player-state sync. Both are
 * Python's, and the difference is harmless — a phase that has flipped on disk
 * but not in the database means one poll cycle of indicators against the old
 * room, and the next `/poll` fixes the row.
 */
function chattingAgentsRoom(state: AppState, world: World, pollOnboarding: boolean): number | null {
  if ((pollOnboarding || world.phase === 'onboarding') && world.onboardingRoomId) {
    return world.onboardingRoomId
  }
  if (pollOnboarding) return null

  const playerState = getPlayerState(state.db, world.id)
  if (!playerState?.currentLocationId) return null
  return getLocation(state.db, playerState.currentLocationId)?.roomId ?? null
}

/** `world.yaml` is hand-editable; anything unrecognised reads as onboarding. */
function asWorldPhase(phase: string): WorldPhase {
  return phase === 'active' || phase === 'ended' ? phase : 'onboarding'
}
