import { tool } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addCharacterToLocation, getLocationByName } from '../../crud/locations'
import { addAgentToRoom } from '../../crud/rooms'
import { getWorld } from '../../crud/worlds'
import type { PlayerService } from '../../services/player-service'
import { RoomMappingService } from '../../services/room-mapping'
import {
  createComprehensiveCharacterTool,
  implantConsolidatedMemoryTool,
} from '../tools/character-design'
import { getLogger } from '../../infrastructure/logging/logger'
import type { AgentFactory } from '../../services/agent-factory'
import type { AgentFilesystemService } from '../../services/agent-filesystem-service'
import type { WorldService } from '../../services/world-service'
import {
  requireWorldId,
  requireWorldName,
  toolError,
  toolSuccess,
  type SdkTool,
  type ToolContext,
} from './context'

/**
 * Deep character creation for onboarding.
 * Port of `sdk/handlers/character_design_tools.py`.
 *
 * These two are a pair and are meant to be called in order: the first writes
 * the character's files and places them, the second fills
 * `consolidated_memory.md`, which is what the `recall` tool later reads. A
 * character created without the second call has a backstory in its
 * `characteristics.md` and no memories to draw on, which reads at the table as
 * an NPC who cannot remember anything about their own history.
 *
 * **These tools cannot be overridden or disabled from a group config.** They go
 * through no registry lookup because Python's `TOOL_GROUPS` omits
 * `character_design` entirely, so `get_tool_description` cannot see them and
 * `character_design_tools.py` passes literal strings. See
 * `tools/registry.ts::CHARACTER_DESIGN_GROUP`.
 */

const logger = getLogger('CharacterDesignTools')

export interface CharacterDesignDeps {
  agentFiles: AgentFilesystemService
  agentFactory: AgentFactory
  players: PlayerService
  rooms: RoomMappingService
  /** Only for resolving the agent folder path — `agentPath` is service-private. */
  worlds: WorldService
}

export function createCharacterDesignTools(
  ctx: ToolContext,
  deps: CharacterDesignDeps,
): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const worldId = requireWorldId(ctx)

  const createCharacter = tool(
    createComprehensiveCharacterTool.name,
    createComprehensiveCharacterTool.description,
    createComprehensiveCharacterTool.inputSchema,
    async (args) => {
      try {
        const db = ctx.getDb()
        const agentName = args.name.replaceAll(' ', '_')

        const inANutshell = `${args.name} is a ${args.role}.`
        let characteristics = `## Role\n${args.role}\n\n## Appearance\n${args.appearance}\n\n## Personality\n${args.personality}\n\n## Backstory\n${args.backstory}\n\n## Initial Disposition\n${args.initial_disposition}`
        if (args.secret) characteristics += `\n\n## Hidden Detail\n${args.secret}`

        deps.agentFiles.createAgent(worldName, agentName, inANutshell, characteristics)

        const whichLocation = args.which_location || 'current'
        const isCurrent = whichLocation.toLowerCase() === 'current'
        const currentLocation = deps.players.loadPlayerState(worldName)?.currentLocation || 'unknown'

        let locationDisplay = 'current location'
        let targetLocation = isCurrent ? null : getLocationByName(db, worldId, whichLocation)

        if (!isCurrent && targetLocation) {
          const roomKey = RoomMappingService.locationToRoomKey(targetLocation.name)
          if (targetLocation.roomId) {
            deps.rooms.ensureRoomMappingExists(worldName, roomKey, targetLocation.roomId, [])
          }
          deps.rooms.addAgentToRoom(worldName, roomKey, agentName)
          // The *folder* name, not `display_name` — this is the one place the
          // two character-creation tools disagree, and `persist_character_design`
          // is the one that shows the display name.
          locationDisplay = targetLocation.name
        } else {
          targetLocation = null
          deps.rooms.addAgentToRoom(
            worldName,
            RoomMappingService.locationToRoomKey(currentLocation),
            agentName,
          )
        }

        const newAgent = deps.agentFactory.createFromConfig(db, {
          name: agentName,
          configFile: `worlds/${worldName}/agents/${agentName}`,
          group: null,
        })

        if (isCurrent) {
          const world = getWorld(db, worldId)
          const isOnboardingRoom =
            world !== null && ctx.roomId !== undefined && world.onboardingRoomId === ctx.roomId
          if (!isOnboardingRoom && ctx.roomId !== undefined) {
            addAgentToRoom(db, ctx.roomId, newAgent.id)
          }
        } else if (targetLocation) {
          addCharacterToLocation(db, newAgent.id, targetLocation.id)
        }

        const memoryNote =
          args.initial_memories && args.initial_memories.length > 0
            ? `\n\n**Note:** Call \`implant_consolidated_memory\` next to add ${args.initial_memories.length} initial memories.`
            : ''

        return toolSuccess(
          `**Comprehensive Character Created:**\n\n` +
            `**Basic Info:**\n` +
            `- Name: ${args.name}\n` +
            `- Role: ${args.role}\n` +
            `- Location: ${locationDisplay}\n` +
            `- Disposition: ${args.initial_disposition}\n\n` +
            `**Profile:**\n` +
            `- Appearance: ${args.appearance.length} chars\n` +
            `- Personality: ${args.personality.length} chars\n` +
            `- Backstory: ${args.backstory.length} chars\n` +
            `- Secret: ${args.secret ? 'Yes' : 'None'}\n\n` +
            `**Files Created:**\n` +
            `- \`in_a_nutshell.md\` - Brief identity\n` +
            `- \`characteristics.md\` - Full profile with backstory${memoryNote}`,
        )
      } catch (error) {
        logger.error(`create_comprehensive_character error: ${String(error)}`)
        return toolError(`Error creating comprehensive character: ${String(error)}`)
      }
    },
  )

  const implantMemory = tool(
    implantConsolidatedMemoryTool.name,
    implantConsolidatedMemoryTool.description,
    implantConsolidatedMemoryTool.inputSchema,
    async (args) => {
      try {
        const agentName = args.character_name.replaceAll(' ', '_')
        const agentPath = join(deps.worlds.getWorldPath(worldName), 'agents', agentName)

        if (!existsSync(agentPath)) {
          return toolError(
            `Error: Character '${args.character_name}' not found in world. ` +
              `Create the character first using create_comprehensive_character.`,
          )
        }

        const memoryFile = join(agentPath, 'consolidated_memory.md')
        const fileExisted = existsSync(memoryFile)

        const parts: string[] = []
        if (args.mode === 'append' && fileExisted) {
          const existing = readFileSync(memoryFile, 'utf-8').trim()
          if (existing) parts.push(existing)
        }
        for (const memory of args.memories) {
          // `## [subtitle]` exactly — `memory.ts`'s parser keys the long-term
          // memory index off the bracketed form, and a heading written without
          // the brackets is invisible to `recall`.
          parts.push(`## [${memory.subtitle}]\n${memory.content}`)
        }

        const finalContent = parts.join('\n\n')
        writeFileSync(memoryFile, finalContent, 'utf-8')

        const operationText = args.mode === 'append' ? 'added' : 'set'
        // Python re-tests `memory_file.exists()` *after* writing, so this branch
        // is taken on an overwrite of a fresh file too; the count is the total in
        // the file either way, which is what the label claims.
        const totalMemories =
          args.mode === 'append' && fileExisted
            ? (finalContent.match(/## \[/g)?.length ?? 0)
            : args.memories.length

        let text =
          `**Consolidated Memories Implanted:**\n\n` +
          `**Character:** ${args.character_name}\n` +
          `**Operation:** ${args.mode}\n` +
          `**Memories ${operationText}:** ${args.memories.length}\n` +
          `**Total memories in file:** ${totalMemories}\n\n` +
          `**Memory Subtitles:**\n`
        args.memories.forEach((memory, index) => {
          text += `${index + 1}. [${memory.subtitle}]\n`
        })
        text +=
          `\n**File:** \`consolidated_memory.md\`\n` +
          `**Format:** Memories stored with \`## [subtitle]\` headers\n\n` +
          `The character can now recall these memories using the \`recall\` tool.`

        return toolSuccess(text)
      } catch (error) {
        logger.error(`implant_consolidated_memory error: ${String(error)}`)
        return toolError(`Error implanting memories: ${String(error)}`)
      }
    },
  )

  return [createCharacter, implantMemory]
}
