import { getAgent } from '@/crud/agents'
import { createMessage, type MessageWithAgent } from '@/crud/messages'
import type { PlayerService } from '@/services/player-service'
import type { RoomMappingService } from '@/services/room-mapping'
import { formatTemplate } from '@/sdk/tools/definitions'
import { awaitReactionsTool, narrationTool, suggestOptionsTool } from '@/sdk/tools/gameplay'
import { tool, requireAgentId, requireRoomId, requireWorldName, toolSuccess, type SdkTool, type ToolContext } from './context'

// The tools that produce what the player actually sees.

export interface NarrativeDeps {
  players: PlayerService
  rooms: RoomMappingService
  /** Called when narration lands, so the turn loop knows the player can act again. */
  onNarrationProduced?: (roomId: number) => void
  /**
   * Push the saved line to the room's SSE clients.
   *
   * `turn.ts` fires its own `onMessageSaved`, but never for the Action Manager:
   * that agent is hidden, so the turn loop persists nothing and this tool is
   * the only thing that writes what the player reads. Without this the finished
   * narration waits for whenever the next poll lands.
   */
  onNarrationSaved?: (roomId: number, message: MessageWithAgent) => void
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

      const db = ctx.getDb()
      const saved = createMessage(db, roomId, {
        content: narrative,
        role: 'assistant',
        agentId,
        thinking: serializeNpcReactions(ctx.npcReactions ?? []),
        gameTimeSnapshot: playerState?.gameTime ?? null,
      })
      deps.onNarrationSaved?.(roomId, { ...saved, agent: getAgent(db, agentId) })

      // Load-bearing for turn flow: the signal that input can reopen.
      deps.onNarrationProduced?.(roomId)

      return toolSuccess(narrationTool.response ?? 'Narrative message created and displayed to player.')
    },
  )

  // Always offered, in flight or not: tool sets must not vary per turn — the
  // allow-list is baked into the session at `query()` time — so an empty
  // location gets the tool and a sentence saying there was nobody to hear it.
  const awaitReactions = tool(
    awaitReactionsTool.name,
    awaitReactionsTool.description,
    awaitReactionsTool.inputSchema,
    async () => {
      const reactions = (await ctx.awaitNpcReactions?.()) ?? ctx.npcReactions ?? []
      return toolSuccess(
        formatTemplate(awaitReactionsTool.response ?? '{reactions}', {
          reactions: formatReactions(reactions),
        }),
      )
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

  return [narration, awaitReactions, suggestOptions]
}

/**
 * What the Action Manager reads back. Each reaction is reproduced whole — this
 * is the only copy that exists, since a reaction is never persisted as a message
 * — and the closing line is there because a model handed a block of NPC prose
 * with no instruction summarises it instead of quoting it.
 */
function formatReactions(reactions: ReadonlyArray<{ agentName: string; content: string }>): string {
  if (reactions.length === 0) {
    return 'No one else is at this location — nobody reacted. Narrate the scene as the player alone in it.'
  }

  const blocks = reactions.map((r) => `### ${r.agentName}\n${r.content}`)
  return [
    `${String(reactions.length)} character(s) reacted to the player's action:`,
    '',
    ...blocks,
    '',
    'Now call `narration` for this: name each character, quote what they said as spoken ' +
      'dialogue and stage what they did. These lines reach the player only through you.',
  ].join('\n')
}
