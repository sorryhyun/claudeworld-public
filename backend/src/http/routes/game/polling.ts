/**
 * `GET /worlds/{id}/poll` — the endpoint the whole frontend lives on, running
 * every two seconds per open world.
 *
 * It is not a read. Because the agent side of the app writes to the
 * *filesystem*, this request also syncs the phase off `world.json` (what makes
 * the "Enter World" button appear), imports the seed generator's `player.json`,
 * writes the "<player> arrives at <place>" line and replays it to the Action
 * Manager as the world's first turn. All but the phase sync are one-shot: they
 * run only while the phase is `active` and the row has no
 * `current_location_id`, which the import fills in.
 */

import { Hono } from 'hono'
import { z } from 'zod'

import { getAgentsCached } from '@/crud/cached'
import { getLocation } from '@/crud/locations'
import {
  countAssistantMessages,
  createMessage,
  getMessages,
  getMessagesExcludingChat,
  getMessagesSince,
  type MessageWithAgent,
} from '@/crud/messages'
import { getPlayerState } from '@/crud/player-state'
import { getWorld, updateWorld } from '@/crud/worlds'
import type { Location, World, WorldPhase } from '@/db/schema'
import { isActionManager } from '@/domain/agent'
import { toLangKey } from '@/domain/enums'
import { getArrivalMessage } from '@/domain/localization'
import { getLogger } from '@/infrastructure/logging/logger'
import { parseJsonColumn } from '@/schemas/common'
import { PersistenceManager } from '@/services/persistence-manager'
import type { AppState } from '@/http/state'
import type { AppEnv } from '@/http/types'
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

/** The `state` block of the poll response, read field-for-field by `usePolling`. */
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
    // Keeps the client on the onboarding room after the phase flips to
    // `active`, so the interview's last lines do not vanish.
    const pollOnboarding = boolQueryParam(c, 'poll_onboarding', false)

    let world = requireWorld(state, c, worldId)

    // A near-copy of `worlds.ts::syncWorldFromFs`, separate because the new
    // phase is needed *before* the write, to route this very request.
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

    let targetRoomId: number | null = null
    let location: Location | null = null

    if ((pollOnboarding || currentPhase === 'onboarding') && world.onboardingRoomId) {
      targetRoomId = world.onboardingRoomId
    } else if (currentPhase === 'active' && !pollOnboarding) {
      // A null `current_location_id` on an already-active world means the seed
      // generator finished and nothing has adopted its output yet.
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
          recoverStalledOpening(state, world, current, current.roomId, playerState.turnCount ?? 0)
        }
      }
    }

    // No room means nothing to show yet. The client keeps polling; not an error.
    if (!targetRoomId) {
      return c.json<PollResponseBody>({ messages: [], state: null })
    }

    // `chat_session_id` partitions the shared room; which half this poll wants
    // depends on the player's mode, except in onboarding, which shows all.
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

    // System messages are the game talking to itself; the player sees answers.
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
   * Typing indicators: real agents with a live session, plus two virtual ids
   * owning no room agent — the World Seed Generator (`-1`) and a Task sub-agent
   * (`-2`), which must differ because the frontend keys rows by id.
   *
   * **Gap: `thinking_text` and `response_text` are always empty.** They need a
   * per-room registry of partially-streamed responses; the SDK layer keeps that
   * on the turn instead. `has_narrated`, which unblocks input, is wired.
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
          // The Action Manager narrates; an avatar would put a face on the prose.
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
 * How stale an unanswered arrival line has to be before the opening counts as
 * dead rather than slow. Comfortably past the ~40s an opening turn takes, and
 * it is what makes the check safe against a turn that has been handed to
 * `deferBackground` but has not registered with the orchestrator yet — that
 * gap is a macrotask, this is two minutes.
 */
const OPENING_STALL_MS = 120_000

/**
 * Restart an opening scene that died before it narrated.
 *
 * `POST /worlds/{id}/enter` writes the arrival line and hands the first turn to
 * a background task with nothing behind it: a backend that stops in the ~40s
 * before the `narration` tool call — a watch reload, a Ctrl+C, a thrown turn —
 * leaves the room holding only that arrival message, which this endpoint
 * filters out as a system line. The player is then looking at an empty world
 * with no way back but a reset.
 *
 * Cheap checks first: this runs on every poll of every active world, and the
 * message count query is reached only by a world that has taken no turn and has
 * nothing running.
 */
function recoverStalledOpening(
  state: AppState,
  world: World,
  location: Location,
  roomId: number,
  turnCount: number,
): void {
  if (turnCount !== 0) return
  if (state.orchestrator.isBusy(roomId)) return
  if (countAssistantMessages(state.db, roomId) > 0) return

  // No arrival line means no turn was ever started for this room — a world mid
  // seed generation, not a stalled opening. Starting one here would narrate an
  // arrival the game has not staged yet.
  const arrival = getMessages(state.db, roomId).find(
    (message) => message.participantType === 'system',
  )
  if (!arrival) return

  const age = arrival.timestamp ? Date.now() - arrival.timestamp.getTime() : 0
  if (age < OPENING_STALL_MS) return

  // One restart per room per process: a turn that keeps ending without
  // narrating must not be relaunched by every poll two seconds later. A reset
  // mints a new room, so a deliberate retry always gets a fresh claim.
  if (!state.orchestrator.claimOpeningRestart(roomId)) return

  logger.warning(
    `Opening scene for '${world.name}' never produced narration (room ${roomId}); restarting it`,
  )

  deferBackground(
    async () => {
      const taskWorld = getWorld(state.db, world.id)
      if (!taskWorld) return
      await state.orchestrator.handlePlayerAction({
        world: taskWorld,
        roomId,
        action: arrival.content,
      })
    },
    { name: `recover_opening:world=${world.id}` },
  )
  logger.info(`Polling: Restarted the opening scene at '${location.name}'`)
}

/**
 * Deliberately *not* `/poll`'s room selection: the row's phase, not the
 * filesystem's, and no player-state sync. A phase flipped on disk but not in the
 * DB costs one cycle of indicators against the old room.
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

/** `world.json` is hand-editable; anything unrecognised reads as onboarding. */
function asWorldPhase(phase: string): WorldPhase {
  return phase === 'active' || phase === 'ended' ? phase : 'onboarding'
}
