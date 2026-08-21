import { getAgentsInRoom } from '../crud/rooms'
import { getCharactersAtLocation, getLocation } from '../crud/locations'
import { getMessagesAfterAgentResponse } from '../crud/messages'
import { getPlayerState } from '../crud/player-state'
import { getRoomAgentSession, updateRoomAgentSession } from '../crud/sessions'
import type { Db } from '../db'
import type { Agent, World } from '../db/schema'
import { buildHooks, SubagentTimings, type HookTelemetry } from '../sdk/agent/hooks'
import type { AgentOptionsInput } from '../sdk/agent/options-builder'
import { TurnRunner, type TurnEvent } from '../sdk/agent/turn-runner'
import type { SessionPool } from '../sdk/client/session-pool'
import { buildServers, type ServerDeps } from '../sdk/handlers/servers'
import type { ToolContext } from '../sdk/handlers/context'
import { parseAgentConfig } from '../sdk/parsing/agent-config'
import { buildSystemPrompt } from '../services/prompt-builder'
import { buildConversationContext } from './conversation-context'
import {
  buildActionManagerSystemPrompt,
  buildActionManagerUserMessage,
  type GameplayServices,
} from './gameplay-context'
import { createGameplayTape } from './tape/gameplay-tape'
import { TapeExecutor, type RespondResult } from './tape/executor'
import type { AgentReaction, ExecutionResult } from './tape/models'

/**
 * Runs one gameplay turn. Port of the path through
 * `orchestration/trpg_orchestrator.py` + `response_generator.py`.
 *
 * The turn is two cells: every NPC at the player's location reacts (hidden,
 * concurrently), then the Action Manager receives those reactions and narrates
 * through its tools. Neither cell persists its agent's prose — the only visible
 * output a turn produces is what the `narration` tool writes.
 */

export interface TurnDeps {
  db: Db
  pool: SessionPool
  services: GameplayServices
  serverDeps: ServerDeps
  projectRoot: string
  useSonnet?: boolean
  onEvent?: (agent: Agent, event: TurnEvent) => void
  onTelemetry?: (event: HookTelemetry) => void
}

export interface RunTurnInput {
  world: World
  roomId: number
  action: string
  signal?: AbortSignal
}

export async function runGameplayTurn(
  deps: TurnDeps,
  input: RunTurnInput,
): Promise<ExecutionResult> {
  const { db } = deps
  const { world } = input
  const playerState = getPlayerState(db, world.id)
  const locationId = playerState?.currentLocationId ?? null
  const location = locationId === null ? null : getLocation(db, locationId)

  const roomAgents = getAgentsInRoom(db, input.roomId)
  const actionManager = roomAgents.find((a) => a.name === 'Action_Manager') ?? null
  const npcs = locationId === null ? [] : getCharactersAtLocation(db, locationId)

  const tape = createGameplayTape(actionManager?.id ?? null, npcs.map((n) => n.id))
  if (!tape) {
    throw new Error(
      `Room ${input.roomId} has no Action_Manager; a gameplay turn cannot be built. ` +
        'Python fell through to a generic handler here, which produced output that was not a game turn.',
    )
  }

  const byId = new Map<number, Agent>()
  for (const agent of [...npcs, ...(actionManager ? [actionManager] : [])]) byId.set(agent.id, agent)

  const runner = new TurnRunner(deps.pool)
  const timings = new SubagentTimings()

  const executor = new TapeExecutor({
    isPaused: () => false,
    respond: async ({ agentId, userMessage, hidden, npcReactions, signal }): Promise<RespondResult> => {
      const agent = byId.get(agentId)
      if (!agent) return { responded: false, responseText: '', agentName: `Agent ${agentId}` }

      const isAm = agent.name === 'Action_Manager'
      const built = buildAgentTurn(deps, {
        world,
        agent,
        roomId: input.roomId,
        locationName: location?.name ?? null,
        userMessage,
        npcReactions,
        isActionManager: isAm,
        timings,
      })

      let responseText = ''
      let responded = false
      for await (const event of runner.run({
        roomId: input.roomId,
        agentId: agent.id,
        agentName: agent.name,
        content: built.message,
        options: built.options,
        hidden,
        signal,
      })) {
        deps.onEvent?.(agent, event)
        if (event.type === 'stream_end') {
          // Persisted before the next turn runs: if the new id is not written
          // back, the next turn resumes a stale session and silently forks the
          // conversation.
          if (event.sessionId && event.sessionId !== built.resume) {
            updateRoomAgentSession(db, input.roomId, agent.id, event.sessionId)
          }
          if (event.error) throw new Error(`${agent.name}: ${event.error}`)
          responseText = event.responseText ?? ''
          responded = !event.skipped && responseText.length > 0
        }
      }

      return { responded, responseText, agentName: agent.name }
    },
  })

  return executor.execute(tape, { userMessage: input.action, signal: input.signal })
}

interface BuildTurnInput {
  world: World
  agent: Agent
  roomId: number
  locationName: string | null
  userMessage: string
  npcReactions: AgentReaction[] | undefined
  isActionManager: boolean
  timings: SubagentTimings
}

/** Assembles one agent's prompt, tools and message for a single turn. */
function buildAgentTurn(
  deps: TurnDeps,
  input: BuildTurnInput,
): { options: AgentOptionsInput; message: string; resume: string | undefined } {
  const { db } = deps
  const { agent, world } = input

  // Filesystem-primary: the DB columns are a cache, and the config on disk is
  // re-read every turn so an edit to a character file takes effect immediately.
  const config = agent.configFile ? parseAgentConfig(agent.configFile) : null
  const systemPromptBase = config
    ? buildSystemPrompt(agent.name, config)
    : agent.systemPrompt

  const resume = getRoomAgentSession(db, input.roomId, agent.id) ?? undefined

  const ctx: ToolContext = {
    agentName: agent.name,
    agentId: agent.id,
    configFile: agent.configFile ?? undefined,
    groupName: agent.group ?? undefined,
    roomId: input.roomId,
    worldName: world.name,
    worldId: world.id,
    longTermMemoryIndex: config?.longTermMemoryIndex ?? {},
    npcReactions: input.npcReactions,
    getDb: () => db,
  }

  const servers = buildServers(ctx, deps.serverDeps, {
    role: input.isActionManager ? 'action_manager' : 'character',
    configDir: agent.configFile
      ? `${deps.projectRoot}/${agent.configFile}`.replace(/\/+/g, '/')
      : undefined,
  })

  let systemPrompt = systemPromptBase
  let message: string

  if (input.isActionManager) {
    const contextInput = {
      worldName: world.name,
      userName: world.userName,
      language: world.language,
      currentLocation: input.locationName,
    }
    systemPrompt += `\n\n${buildActionManagerSystemPrompt(deps.services, contextInput)}`
    message = buildActionManagerUserMessage(deps.services, {
      ...contextInput,
      playerAction: input.userMessage,
      agentName: agent.name,
      npcReactions: input.npcReactions,
    })
  } else {
    // NPCs are not handed the action directly. They read it out of the room's
    // messages, where it was persisted before the turn started — which is what
    // makes an NPC's view of the scene identical to any other observer's.
    const messages = getMessagesAfterAgentResponse(db, input.roomId, agent.id, 120)
    message = buildConversationContext({
      messages: messages.map((m) => ({
        id: m.id,
        content: m.content,
        role: m.role,
        agentId: m.agentId,
        agentName: m.agent?.name ?? null,
        participantType: m.participantType,
        participantName: m.participantName,
      })),
      agentId: agent.id,
      agentName: agent.name,
      worldUserName: world.userName,
      worldLanguage: world.language,
      includeResponseInstruction: true,
      keepOnlyLatestActionManager: true,
      keepOnlyLatestUser: true,
    })
  }

  const anthropicCalls: string[] = []
  const hooks = buildHooks(
    {
      agentName: agent.name,
      roomId: input.roomId,
      anthropicCalls: { push: (s) => anthropicCalls.push(s) },
      onEvent: deps.onTelemetry,
    },
    input.timings,
  )

  return {
    options: {
      systemPrompt,
      mcpServers: servers.mcpServers,
      toolNames: servers.toolNames,
      hooks,
      resume,
      useSonnet: deps.useSonnet,
    },
    message,
    resume,
  }
}
