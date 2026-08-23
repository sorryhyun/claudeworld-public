import { createMessage } from '@/crud/messages'
import type { PlayerService } from '@/services/player-service'
import type { RoomMappingService } from '@/services/room-mapping'
import { formatTemplate } from '@/sdk/tools/definitions'
import { narrationTool, suggestOptionsTool } from '@/sdk/tools/gameplay'
import { tool, requireAgentId, requireRoomId, requireWorldName, toolSuccess, type SdkTool, type ToolContext } from './context'

// The tools that produce what the player actually sees.

export interface NarrativeDeps {
  players: PlayerService
  rooms: RoomMappingService
  /** Called when narration lands, so the turn loop knows the player can act again. */
  onNarrationProduced?: (roomId: number) => void
}

/**
 * Wrap NPC reactions for the narration message's `thinking` column — the only
 * durable record of them, since reactions are never persisted as messages. The
 * frontend keys on these markers to render the collapsible.
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
  // Resolved at build time, not call time: a tool whose context is incomplete
  // must not be offered to the model at all.
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

      // Load-bearing for turn flow: the signal that input can reopen.
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
      // Suggestions live in the world's `_state.json`, not the database.
      deps.rooms.saveSuggestions(worldName, [action_1, action_2])
      return toolSuccess(
        formatTemplate(suggestOptionsTool.response ?? '', { action_1, action_2 }),
      )
    },
  )

  return [narration, suggestOptions]
}
