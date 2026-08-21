import { createSdkMcpServer, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { LocationStorage } from '../../services/location-storage'
import type { PlayerService } from '../../services/player-service'
import type { RoomMappingService } from '../../services/room-mapping'
import { qualifiedToolName } from '../tools/definitions'
import { createActionTools, type ActionDeps } from './action-tools'
import { createNarrativeTools, type NarrativeDeps } from './narrative-tools'
import { createWorldTools } from './world-tools'
import type { ToolContext } from './context'

/**
 * Assembles the in-process MCP servers for one agent's turn.
 * Port of `sdk/handlers/servers.py` + `sdk/client/mcp_registry.py`.
 *
 * Servers are built per turn, not cached. Python cached them under a hash that
 * deliberately excluded the DB session and the NPC reactions, so a cached server
 * closed over a session that had since been closed and over the *previous*
 * turn's reactions — the narration tool could file last turn's NPC responses
 * against this turn's message. Rebuilding is cheap (these are closures, not
 * connections) and removes the whole class of bug.
 */

export const SERVER_NAMES = {
  action: 'action',
  actionManager: 'action_manager',
} as const

export interface BuiltServers {
  mcpServers: Record<string, McpServerConfig>
  /** Fully-qualified names for the options builder's `tools`/`allowedTools`. */
  toolNames: string[]
}

export interface ServerDeps {
  players: PlayerService
  rooms: RoomMappingService
  locations: LocationStorage
  onNarrationProduced?: NarrativeDeps['onNarrationProduced']
  invalidateAgentConfig?: ActionDeps['invalidateAgentConfig']
  random?: () => number
}

export interface BuildServersOptions {
  /**
   * Does this agent run the turn, or play a character in it?
   *
   * The Action Manager gets the narration and world tools and is denied the
   * character tools — Python discarded the `action` group for system agents,
   * because an agent that narrates the scene has no `recent_events.md` of its
   * own to write to.
   */
  role: 'action_manager' | 'character'
  /** Absolute path to the agent's config directory; required for characters. */
  configDir?: string
  gameTimeLabel?: ActionDeps['gameTimeLabel']
}

export function buildServers(
  ctx: ToolContext,
  deps: ServerDeps,
  options: BuildServersOptions,
): BuiltServers {
  const mcpServers: Record<string, McpServerConfig> = {}
  const toolNames: string[] = []

  if (options.role === 'action_manager') {
    const tools = [
      ...createNarrativeTools(ctx, {
        players: deps.players,
        rooms: deps.rooms,
        onNarrationProduced: deps.onNarrationProduced,
      }),
      ...createWorldTools(ctx, { locations: deps.locations, random: deps.random }),
    ]
    mcpServers[SERVER_NAMES.actionManager] = createSdkMcpServer({
      name: SERVER_NAMES.actionManager,
      version: '1.0.0',
      tools,
    })
    toolNames.push(...tools.map((t) => qualifiedToolName(SERVER_NAMES.actionManager, t.name)))
  } else {
    if (!options.configDir) {
      throw new Error(`Character agent "${ctx.agentName}" has no config directory`)
    }
    const tools = createActionTools(ctx, {
      configDir: options.configDir,
      gameTimeLabel: options.gameTimeLabel,
      invalidateAgentConfig: deps.invalidateAgentConfig,
    })
    mcpServers[SERVER_NAMES.action] = createSdkMcpServer({
      name: SERVER_NAMES.action,
      version: '1.0.0',
      tools,
    })
    toolNames.push(...tools.map((t) => qualifiedToolName(SERVER_NAMES.action, t.name)))
  }

  return { mcpServers, toolNames }
}
