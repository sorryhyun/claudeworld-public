/**
 * Chat mode: a side conversation with the NPCs at the player's location, with
 * no Action Manager, no narration, no turn counter and no stat changes. Not a
 * router — `/chat` and `/end` arrive as slash commands inside a normal action
 * body, and `actions.ts` dispatches here. The status is always 200, failures
 * included; the frontend renders those as a system line.
 *
 * The separation mechanism is `messages.chat_session_id`, set on chat-mode
 * messages and NULL on gameplay ones. `/end` hands the transcript to a
 * Chat_Summarizer and feeds its summary back into the tape as a synthetic
 * player action, which is why it can answer `processing`.
 */

import { eq } from 'drizzle-orm'

import { getRoomAgentSession, updateRoomAgentSession } from '@/crud/sessions'
import { createMessage, getChatSessionMessages, getRecentMessages } from '@/crud/messages'
import { enterChatMode, exitChatMode } from '@/crud/player-state'
import { addGameplayAgentsToRoom, getWorld } from '@/crud/worlds'
import type { Db } from '@/db'
import { agents, type Agent, type PlayerState, type World } from '@/db/schema'
import { isChatSummarizer } from '@/domain/agent'
import { getSettings } from '@/config/settings'
import { getLogger } from '@/infrastructure/logging/logger'
import type { AgentOptionsInput } from '@/sdk/agent/options-builder'
import { buildAgentOptions, optionsFingerprint } from '@/sdk/agent/options-builder'
import { TurnRunner } from '@/sdk/agent/turn-runner'
import { parseAgentConfig } from '@/sdk/parsing/agent-config'
import { buildSystemPrompt } from '@/services/prompt-builder'
import type { AppState } from '@/http/state'
import { startBackground, tryCompressImage } from './shared'

const logger = getLogger('ChatModeRoutes')

/** Every chat-mode handler answers 200 with one of these. */
export interface ChatModeResult {
  status: string
  message: string
}

// The start marker — the id of the room's newest message, or `0` — is where the
// frontend resumes the gameplay transcript, so it must be captured *before* the
// "[Chat mode started...]" message is written.
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

  // Tagged with the session id: hidden from the poll, but part of the
  // conversation the summarizer reads.
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

export interface ChatModeActionInput {
  worldId: number
  playerState: PlayerState
  roomId: number
  text: string
  world: World
  imageData?: string | null
  imageMediaType?: string | null
}

// Store the message, then let the NPCs answer. No action history, no turn
// increment, no game-time snapshot: chat mode does not advance the game.
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

/**
 * Exit chat mode, summarizing unless there was no conversation. The interaction
 * check runs *before* the exit, which clears the `chat_session_id` it needs. A
 * session holding only the "[Chat mode started...]" line exits silently.
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

  // No `chat_session_id`: tagging it would pull the closing line into the
  // transcript the summarizer is already reading.
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

// By pattern, not exact name: the folder may be `Chat_Summarizer`,
// `chat summarizer` or `ChatSummarizer`.
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

function chatSummarizerOptions(state: AppState, summarizer: Agent, roomId: number): AgentOptionsInput {
  const config = summarizer.configFile ? parseAgentConfig(summarizer.configFile) : null
  const systemPrompt = config
    ? buildSystemPrompt(summarizer.name, config)
    : summarizer.systemPrompt

  return {
    systemPrompt,
    // No tools: the summarizer only produces prose, and the gameplay tools would
    // let a summary mutate the world it is describing.
    mcpServers: {},
    toolNames: [],
    resume: getRoomAgentSession(state.db, roomId, summarizer.id) ?? undefined,
    useSonnet: getSettings().useSonnet,
  }
}

// Pure latency work: `/end` otherwise waits on a cold subprocess start.
// Failures are swallowed — the session is then opened on demand.
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
        // Written back here too, or the next `/end` resumes a stale session.
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
 * Summarize the finished chat session and feed it back into gameplay. Three
 * orderings are load-bearing: gameplay agents are re-added first (a location
 * seeded before they existed has no Action Manager for the turn below); the
 * "sub-agent busy" indicator is set only once the transcript is known non-empty;
 * and it is cleared *before* the gameplay turn. With no summarizer available the
 * last six exchanges are pasted in verbatim.
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
