/**
 * The agent surface. Hono matches in registration order, so the order of the
 * routes below is load-bearing: `GET /agents/configs` must be registered before
 * `GET /agents/:agent_id`, or "configs" parses as an agent id and the config
 * picker 422s. The same hazard `/worlds/importable` has.
 */

import { Hono } from 'hono'

import {
  createAgent,
  getAllAgents,
  getAgent as getAgentRow,
  updateAgent,
} from '../../../crud/agents'
import { getOrCreateDirectRoom } from '../../../crud/rooms'
import type { Agent } from '../../../db/schema'
import { getLogger } from '../../../infrastructure/logging/logger'
import { AgentCreate, AgentUpdate, toAgent } from '../../../schemas/agents'
import { toRoom } from '../../../schemas/rooms'
import { listAvailableConfigs } from '../../../sdk/parsing/agent-config'
import { buildSystemPrompt } from '../../../services/prompt-builder'
import { assertRoomAccess } from '../../access-control'
import { HttpError } from '../../../domain/errors'
import { requireAdmin } from '../../middleware/auth'
import { identityOf, type AppState } from '../../state'
import type { AppEnv } from '../../types'
import { intPathParam, parseBody } from '../game/shared'
import { serveProfilePic } from './profile-pic'

const logger = getLogger('AgentRouter')

function agentNotFound(): HttpError {
  return new HttpError(404, 'Agent not found')
}

export function createAgentRoutes(state: AppState): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.patch('/agents/:agent_id', requireAdmin, async (c) => {
    const agentId = intPathParam(c, 'agent_id')
    const body = await parseBody(c, AgentUpdate)

    const agent = updateAgent(state.db, agentId, {
      profilePic: body.profile_pic,
      inANutshell: body.in_a_nutshell,
      characteristics: body.characteristics,
      recentEvents: body.recent_events,
    })
    if (agent === null) throw agentNotFound()
    return c.json(toAgent(agent))
  })

  routes.post('/agents/:agent_id/reload', requireAdmin, (c) => {
    const agentId = intPathParam(c, 'agent_id')
    try {
      const agent = state.agentFactory.reloadFromConfig(state.db, agentId)
      if (agent === null) throw agentNotFound()
      return c.json(toAgent(agent))
    } catch (error) {
      if (error instanceof HttpError) throw error
      // A rejected config is a 400; anything else is a real 500.
      if (error instanceof Error && !(error instanceof TypeError)) {
        throw new HttpError(400, error.message)
      }
      throw error
    }
  })

  // Must stay ahead of `GET /agents/:agent_id`, which would otherwise match
  // "configs" and reject it as a non-integer id.
  routes.get('/agents/configs', (c) => c.json({ configs: listAvailableConfigs() }))

  routes.get('/agents/:agent_name/profile-pic', (c) =>
    serveProfilePic(c, state.projectRoot, c.req.param('agent_name') ?? ''),
  )

  routes.get('/agents', (c) => c.json(getAllAgents(state.db).map(toAgent)))

  routes.post('/agents', async (c) => {
    const body = await parseBody(c, AgentCreate)

    // A `config_file` loads the markdown off disk through the factory (which
    // merges group settings); the inline form builds from the fields given.
    const agent = body.config_file
      ? state.agentFactory.createFromConfig(state.db, {
          name: body.name,
          configFile: body.config_file,
          group: body.group,
          providedConfig: {
            inANutshell: body.in_a_nutshell ?? undefined,
            characteristics: body.characteristics ?? undefined,
            recentEvents: body.recent_events ?? undefined,
            profilePic: body.profile_pic ?? undefined,
          },
        })
      : createInlineAgent(state, body)

    logger.info(`Agent created: ${agent.name} (id ${agent.id})`)
    return c.json(toAgent(agent))
  })

  routes.get('/agents/:agent_id', (c) => {
    const agent = getAgentRow(state.db, intPathParam(c, 'agent_id'))
    if (agent === null) throw agentNotFound()
    return c.json(toAgent(agent))
  })

  routes.delete('/agents/:agent_id', requireAdmin, async (c) => {
    const agentId = intPathParam(c, 'agent_id')
    const deleted = await state.agents.deleteAgentWithCleanup(state.db, agentId)
    if (!deleted) throw agentNotFound()
    return c.json({ message: 'Agent deleted successfully' })
  })

  // The ownership check after the lookup is not redundant: the row could
  // already exist under a different owner if the caller's role changed.
  routes.get('/agents/:agent_id/direct-room', (c) => {
    const agentId = intPathParam(c, 'agent_id')
    const identity = identityOf(c)
    const ownerId = identity.role === 'admin' ? 'admin' : identity.userId

    const room = getOrCreateDirectRoom(state.db, agentId, ownerId)
    if (room === null) throw agentNotFound()

    assertRoomAccess(identity, room.ownerId)
    return c.json(toRoom(room))
  })

  return routes
}

/**
 * Create an agent from inline markdown. The system prompt is built here, never
 * accepted from the client: letting a caller supply it would be a way to give
 * an agent instructions its character files do not show.
 */
function createInlineAgent(state: AppState, body: AgentCreate): Agent {
  const systemPrompt = buildSystemPrompt(body.name, {
    inANutshell: body.in_a_nutshell ?? '',
    characteristics: body.characteristics ?? '',
    recentEvents: body.recent_events ?? '',
    // Empty: long-term memory lives in `consolidated_memory.md`, which only
    // the config-folder path has.
    longTermMemorySubtitles: null,
  })

  return createAgent(state.db, {
    name: body.name,
    systemPrompt,
    profilePic: body.profile_pic,
    inANutshell: body.in_a_nutshell,
    characteristics: body.characteristics,
    recentEvents: body.recent_events,
    group: body.group,
    // Explicitly null: a row claiming a config folder it was not built from
    // would be silently overwritten by the next filesystem sync.
    configFile: null,
    interruptEveryTurn: body.interrupt_every_turn,
    priority: body.priority,
  })
}
