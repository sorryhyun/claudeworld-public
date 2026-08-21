import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createMessage } from '../../crud/messages'
import type { PlayerService } from '../../services/player-service'
import type { RoomMappingService } from '../../services/room-mapping'
import { formatTemplate } from '../tools/definitions'
import { narrationTool, suggestOptionsTool } from '../tools/gameplay'
import {
  requireAgentId,
  requireRoomId,
  requireWorldName,
  toolSuccess,
  type SdkTool,
  type ToolContext,
} from './context'

/**
 * The tools that produce what the player actually sees.
 * Port of `sdk/handlers/narrative_tools.py`.
 */

export interface NarrativeDeps {
  players: PlayerService
  rooms: RoomMappingService
  /** Called when narration lands, so the turn loop knows the player can act again. */
  onNarrationProduced?: (roomId: number) => void
}

/**
 * Wrap NPC reactions for storage in the narration message's `thinking` column.
 *
 * Reactions are never persisted as messages of their own, so this is the only
 * durable record of them. The frontend looks for these markers to render the
 * reactions in a collapsible under the narration.
 */
export function serializeNpcReactions(
  reactions: ReadonlyArray<{ agentName: string; content: string }>,
): string | null {
  if (reactions.length === 0) return null
  const body = reactions.map((r) => `=== ${r.agentName} ===\n${r.content}`).join('\n\n')
  return `[NPC_REACTIONS]\n${body}\n[/NPC_REACTIONS]`
}

export function createNarrativeTools(
  ctx: ToolContext,
  deps: NarrativeDeps,
): SdkTool[] {
  // Resolved once, at build time rather than call time: a tool whose context is
  // incomplete must not be offered to the model at all, because the model will
  // call it and can do nothing useful with the failure.
  const roomId = requireRoomId(ctx)
  const agentId = requireAgentId(ctx)
  const worldName = requireWorldName(ctx)

  const narration = tool(
    narrationTool.name,
    narrationTool.description,
    narrationTool.inputSchema,
    async (args) => {
      const narrative = args.narrative
      const playerState = deps.players.loadPlayerState(worldName)

      createMessage(ctx.getDb(), roomId, {
        content: narrative,
        role: 'assistant',
        agentId,
        thinking: serializeNpcReactions(ctx.npcReactions ?? []),
        gameTimeSnapshot: playerState?.gameTime ?? null,
      })

      // Load-bearing for turn flow, not just presentation: this is the signal
      // that the turn produced its visible output and input can reopen.
      deps.onNarrationProduced?.(roomId)

      return toolSuccess(narrationTool.response ?? 'Narrative message created and displayed to player.')
    },
  )

  const suggestOptions = tool(
    suggestOptionsTool.name,
    suggestOptionsTool.description,
    suggestOptionsTool.inputSchema,
    async (args) => {
      const { action_1, action_2 } = args
      // Suggestions live in the world's `_state.json`, not the database — the
      // frontend reads them from there alongside the room mapping.
      deps.rooms.saveSuggestions(worldName, [action_1, action_2])
      return toolSuccess(
        formatTemplate(suggestOptionsTool.response ?? '', { action_1, action_2 }),
      )
    },
  )

  return [narration, suggestOptions]
}
