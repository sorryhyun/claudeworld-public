/**
 * Chat mode — port of `backend/routers/game/chat_mode.py`.
 *
 * Not a router. `/chat` and `/end` arrive as *slash commands inside a normal
 * action body*, so `actions.ts` parses them and dispatches here; these three
 * handlers return the same `{status, message}` dicts Python's do, and the HTTP
 * status is always 200 — including for the failure cases, which the frontend
 * renders as a system line rather than an error toast.
 *
 * ## What chat mode is
 *
 * A side conversation with the NPCs at the player's location, with no Action
 * Manager, no narration, no turn counter and no stat changes. It shares the
 * location's room and its `messages` table; the entire separation mechanism is
 * `messages.chat_session_id`, which is set on every message written while chat
 * mode is on and NULL on every gameplay message.
 *
 * Leaving chat mode is the interesting half. The conversation has to re-enter
 * the game's causality, so `/end` hands the transcript to a Chat_Summarizer
 * agent and feeds its summary back into the gameplay tape as a synthetic player
 * action. That is what {@link summarizeAndContinue} does, and it is why `/end`
 * answers `processing` rather than `chat_mode_ended` when there was anything to
 * summarize.
 */

import { eq } from 'drizzle-orm'

import { getRoomAgentSession, updateRoomAgentSession } from '../../../crud/sessions'
import { createMessage, getChatSessionMessages, getRecentMessages } from '../../../crud/messages'
import { enterChatMode, exitChatMode } from '../../../crud/player-state'
import { addGameplayAgentsToRoom, getWorld } from '../../../crud/worlds'
import type { Db } from '../../../db'
import { agents, type Agent, type PlayerState, type World } from '../../../db/schema'
import { isChatSummarizer } from '../../../domain/agent'
import { getSettings } from '../../../config/settings'
import { getLogger } from '../../../infrastructure/logging/logger'
import type { AgentOptionsInput } from '../../../sdk/agent/options-builder'
import { buildAgentOptions, optionsFingerprint } from '../../../sdk/agent/options-builder'
import { TurnRunner } from '../../../sdk/agent/turn-runner'
import { parseAgentConfig } from '../../../sdk/parsing/agent-config'
import { buildSystemPrompt } from '../../../services/prompt-builder'
import type { AppState } from '../../state'
import { startBackground, tryCompressImage } from './shared'

const logger = getLogger('ChatModeRoutes')

/** Every chat-mode handler answers 200 with one of these. */
export interface ChatModeResult {
  status: string
  message: string
}

// =============================================================================
// /chat
// =============================================================================

/**
 * Enter chat mode.
 *
 * The start marker is the id of the room's newest message, or `0` for an empty
 * room. The frontend reads it back out of the poll response as the point to
 * resume the gameplay transcript from once chat mode ends, so it must be
 * captured *before* the "[Chat mode started...]" system message is written.
 */
export function handleChatCommand(
  state: AppState,
  worldId: number,
  playerState: PlayerState,
  roomId: number,
): ChatModeResult {
  if (playerState.isChatMode) {
    return {
      status: 'already_in_chat_mode',
      message: 'You are already in chat mode. Type /end to return to gameplay.',
    }
  }

  const recent = getRecentMessages(state.db, roomId, 1)
  const startMessageId = recent[recent.length - 1]?.id ?? 0

  const chatSessionId = enterChatMode(state.db, worldId, startMessageId)
  if (chatSessionId === null) {
    return { status: 'error', message: 'Failed to enter chat mode.' }
  }

  // Tagged with the session id like every other chat-mode message: it is hidden
  // from the poll (system messages are filtered out) but it *is* part of the
  // conversation the summarizer reads, which is why it is stored at all.
  createMessage(state.db, roomId, {
    content:
      '[Chat mode started. You can now freely converse with NPCs. Type /end to return to gameplay.]',
    role: 'user',
    participantType: 'system',
    participantName: 'System',
    chatSessionId,
  })

  startBackground(() => warmChatSummarizer(state, roomId), {
    name: `warm_chat_summarizer:room=${roomId}`,
  })

  logger.info(
    `Entered chat mode for world ${worldId}, start_message_id=${startMessageId}, ` +
      `chat_session_id=${chatSessionId}`,
  )

  return {
    status: 'chat_mode_started',
    message: 'Chat mode started. You can now freely converse with NPCs. Type /end to return to gameplay.',
  }
}

// =============================================================================
// A message while chat mode is on
// =============================================================================

export interface ChatModeActionInput {
  worldId: number
  playerState: PlayerState
  roomId: number
  text: string
  world: World
  imageData?: string | null
  imageMediaType?: string | null
}

/**
 * Handle a player message in chat mode: store it, then let the NPCs answer.
 *
 * Note what is *not* here compared to the gameplay path in `actions.ts` — no
 * `add_action_to_history`, no `increment_turn`, no game-time snapshot. Chat mode
 * does not advance the game, which is the whole reason it exists.
 */
export async function handleChatModeAction(
  state: AppState,
  input: ChatModeActionInput,
): Promise<ChatModeResult> {
  const chatSessionId = input.playerState.chatSessionId

  const image = await tryCompressImage(
    input.imageData,
    input.imageMediaType,
    `chat mode in world ${input.worldId}`,
  )

  createMessage(state.db, input.roomId, {
    content: input.text,
    role: 'user',
    participantType: 'user',
    chatSessionId,
    imageData: image.imageData,
    imageMediaType: image.imageMediaType,
  })

  startBackground(
    async () => {
      await state.orchestrator.handleChatMessage({
        world: input.world,
        roomId: input.roomId,
        action: input.text,
        chatSessionId,
      })
    },
    { name: `trigger_chat_responses:world=${input.worldId}` },
  )

  logger.info(`Chat mode message submitted for world ${input.worldId}: ${input.text.slice(0, 50)}...`)

  return { status: 'processing', message: 'Message received, NPCs are responding...' }
}

// =============================================================================
// /end
// =============================================================================

/**
 * Exit chat mode, summarizing the conversation unless there was none.
 *
 * The "was there an interaction" check runs *before* the exit, because
 * `exitChatMode` clears `chat_session_id` and the check needs it. A session
 * containing only the "[Chat mode started...]" system line exits silently — no
 * summary, no gameplay turn, no visible trace — so that a mistyped `/chat`
 * followed by `/end` does not cost the player a narration.
 */
export function handleEndCommand(
  state: AppState,
  worldId: number,
  playerState: PlayerState,
  roomId: number,
  world: World,
): ChatModeResult {
  if (!playerState.isChatMode) {
    return { status: 'not_in_chat_mode', message: 'You are not in chat mode.' }
  }

  const chatSessionId = playerState.chatSessionId
  let hasChatInteraction = false
  if (chatSessionId) {
    hasChatInteraction = getChatSessionMessages(state.db, roomId, chatSessionId, 10).some(
      (m) => m.participantType !== 'system',
    )
  }

  const exitResult = exitChatMode(state.db, worldId)
  if (exitResult === null) {
    return { status: 'error', message: 'Failed to exit chat mode.' }
  }

  if (!hasChatInteraction) {
    logger.info(`Exited chat mode for world ${worldId} with no interaction, skipping summarizer`)
    return { status: 'chat_mode_ended', message: 'Exited chat mode.' }
  }

  // No `chat_session_id` on this one: the session is over, and tagging it would
  // pull the closing line into the transcript the summarizer is already reading.
  createMessage(state.db, roomId, {
    content: '[Chat mode ended. Returning to gameplay...]',
    role: 'user',
    participantType: 'system',
    participantName: 'System',
  })

  const returnedSessionId = exitResult.chatSessionId
  if (returnedSessionId !== null) {
    startBackground(
      () =>
        summarizeAndContinue(state, {
          worldId,
          roomId,
          chatSessionId: returnedSessionId,
          userName: world.userName || 'The player',
        }),
      { name: `summarize_and_continue:world=${worldId}` },
    )
  }

  logger.info(`Exited chat mode for world ${worldId}, summarizing conversation...`)
  return { status: 'processing', message: 'Returning to gameplay...' }
}

// =============================================================================
// Chat_Summarizer
// =============================================================================

/**
 * The Chat_Summarizer agent row.
 *
 * Looked up by *pattern* across the gameplay group rather than by exact name,
 * because the folder on disk may be `Chat_Summarizer`, `chat summarizer` or
 * `ChatSummarizer` depending on who created it — `isChatSummarizer` owns that
 * spelling tolerance.
 */
function getChatSummarizerAgent(db: Db): Agent | null {
  const found = db
    .select()
    .from(agents)
    .where(eq(agents.group, 'gameplay'))
    .all()
    .find((agent) => isChatSummarizer(agent.name))

  if (!found) logger.warning('Chat_Summarizer agent not found in database')
  return found ?? null
}

/** The summarizer's options, shared by the warm path and the real invocation. */
function chatSummarizerOptions(state: AppState, summarizer: Agent, roomId: number): AgentOptionsInput {
  const config = summarizer.configFile ? parseAgentConfig(summarizer.configFile) : null
  const systemPrompt = config
    ? buildSystemPrompt(summarizer.name, config)
    : summarizer.systemPrompt

  return {
    systemPrompt,
    // No tools at all — Python passes `[]` as the tool list here. The
    // summarizer's only job is to produce prose, and giving it the gameplay
    // tools would let a summary mutate the world it is describing.
    mcpServers: {},
    toolNames: [],
    resume: getRoomAgentSession(state.db, roomId, summarizer.id) ?? undefined,
    useSonnet: getSettings().useSonnet,
  }
}

/**
 * Open the summarizer's SDK session while the player is still chatting.
 *
 * Pure latency work: `/end` is the one command that makes the player wait on a
 * cold subprocess start, and entering chat mode is a free moment to pay for it.
 * Every failure is swallowed — a session that could not be warmed is opened on
 * demand instead.
 */
async function warmChatSummarizer(state: AppState, roomId: number): Promise<void> {
  try {
    const summarizer = getChatSummarizerAgent(state.db)
    if (!summarizer) {
      logger.warning('Cannot warm Chat_Summarizer: agent not found')
      return
    }

    const input = chatSummarizerOptions(state, summarizer, roomId)
    await state.pool.acquire(
      { roomId, agentId: summarizer.id },
      buildAgentOptions(input),
      optionsFingerprint(input),
    )
    logger.info(`Chat_Summarizer client warmed for room ${roomId}`)
  } catch (error) {
    logger.warning(`Failed to warm Chat_Summarizer client: ${String(error)}`)
  }
}

/** Run the summarizer over a transcript. `null` when it is unavailable. */
async function generateAiSummary(
  state: AppState,
  roomId: number,
  conversationText: string,
  participants: Set<string>,
): Promise<string | null> {
  const summarizer = getChatSummarizerAgent(state.db)
  if (!summarizer) return null

  try {
    const options = chatSummarizerOptions(state, summarizer, roomId)
    const participantList = participants.size > 0 ? [...participants].join(', ') : 'NPCs'
    const userMessage = `Please summarize the following conversation between the player and ${participantList}.

## Conversation Transcript
${conversationText}

## Instructions
Create a concise 2-4 sentence summary focusing on:
- Key topics discussed
- Important information exchanged
- Any agreements or outcomes
- Relationship changes (if any)

Write in past tense, third person (e.g., "The player discussed...", "They agreed...").`

    let responseText = ''
    for await (const event of new TurnRunner(state.pool).run({
      roomId,
      agentId: summarizer.id,
      agentName: summarizer.name,
      content: userMessage,
      options,
      hidden: true,
    })) {
      if (event.type === 'content_delta') {
        responseText += event.delta
      } else if (event.type === 'stream_end') {
        // The session id has to be written back even here, or the next `/end`
        // resumes a session this turn has already moved past.
        if (event.sessionId && event.sessionId !== options.resume) {
          updateRoomAgentSession(state.db, roomId, summarizer.id, event.sessionId)
        }
        if (event.responseText) responseText = event.responseText
      }
    }

    logger.info(`Chat_Summarizer generated summary: ${responseText.slice(0, 100)}...`)
    return responseText.trim() || null
  } catch (error) {
    logger.exception('Error generating AI summary', error)
    return null
  }
}

interface SummarizeInput {
  worldId: number
  roomId: number
  chatSessionId: number
  userName: string
}

/**
 * Summarize the finished chat session and feed it back into gameplay.
 *
 * Three ordering details are Python's and are load-bearing:
 *
 * - **The room's gameplay agents are re-added first.** A location created
 *   before the gameplay agents were seeded has a room with no Action Manager,
 *   and the turn at the end of this function would then have nothing to run.
 * - **The "sub-agent busy" indicator is set only after the transcript is known
 *   to be non-empty.** Setting it earlier would show the player a spinner for a
 *   summarizer that is about to decide it has nothing to do.
 * - **The indicator is cleared before the gameplay turn starts**, not after, so
 *   the Action Manager's own row replaces it rather than stacking beneath it.
 *
 * When the summarizer is unavailable the last six exchanges are pasted in
 * verbatim instead. That fallback is deliberately crude: the Action Manager
 * needs *something* describing what just happened, and raw dialogue is a worse
 * prompt than a summary but a far better one than silence.
 */
async function summarizeAndContinue(state: AppState, input: SummarizeInput): Promise<void> {
  const { roomId, worldId } = input

  try {
    addGameplayAgentsToRoom(state.db, roomId)

    const messages = getChatSessionMessages(state.db, roomId, input.chatSessionId, 100)
    if (messages.length === 0) {
      logger.info(`No messages to summarize for world ${worldId}, skipping summarizer`)
      return
    }

    const conversation: string[] = []
    const participants = new Set<string>()
    for (const message of messages) {
      if (message.participantType === 'system') continue
      if (message.role === 'user') {
        conversation.push(`${message.participantName || input.userName}: ${message.content}`)
      } else {
        const name = message.agent?.name ?? 'Unknown'
        conversation.push(`${name}: ${message.content}`)
        if (message.agent?.name) participants.add(message.agent.name)
      }
    }

    if (conversation.length === 0) {
      logger.info(`No conversation content to summarize for world ${worldId}, skipping summarizer`)
      return
    }

    state.orchestrator.setSubAgentActive(roomId, 'Chat_Summarizer', 'Summarizing conversation...')

    const aiSummary = await generateAiSummary(state, roomId, conversation.join('\n'), participants)

    const summaryText =
      aiSummary ??
      `[End of conversation with ${participants.size > 0 ? [...participants].join(', ') : 'NPCs'}]\n` +
        `Recent exchanges:\n${conversation.slice(-6).join('\n')}`

    logger.info(`Chat mode ended, passing to gameplay: ${summaryText.slice(0, 100)}...`)

    state.orchestrator.setSubAgentInactive(roomId)

    const world = getWorld(state.db, worldId)
    if (world) {
      await state.orchestrator.handlePlayerAction({
        world,
        roomId,
        action: `[Conversation Summary] ${summaryText}`,
      })
    }
  } catch (error) {
    logger.exception('Error in summarize_and_continue', error)
  } finally {
    state.orchestrator.setSubAgentInactive(roomId)
  }
}
