import { getConversationContextConfig } from '@/sdk/loaders/yaml-config'
import { formatWithParticles } from '@/lib/korean'
import type { LocationStorage } from '@/services/location-storage'
import type { PlayerService } from '@/services/player-service'
import type { RoomMappingService } from '@/services/room-mapping'
import type { WorldService } from '@/services/world-service'
import type { AgentReaction } from './tape/models'
import { toLangKey } from '@/domain/enums'

/**
 * Builds what the Action Manager sees, read from the filesystem rather than the
 * database. The inventory and the character roster are deliberately absent: the
 * Action Manager pulls those on demand through `list_inventory` and
 * `list_characters` rather than carrying them in context every turn.
 */

export interface GameplayServices {
  worlds: WorldService
  players: PlayerService
  locations: LocationStorage
  rooms: RoomMappingService
}

export interface ActionManagerContextInput {
  worldName: string
  userName: string | null
  language: string | null
  /** Location slug, e.g. `old_mill`. */
  currentLocation: string | null
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function buildActionManagerSystemPrompt(
  services: GameplayServices,
  input: ActionManagerContextInput,
): string {
  const { worldName } = input
  const parts: string[] = []

  if (input.userName) {
    parts.push(`# Protagonist: ${input.userName}`, '')
  }

  const player = services.players.loadPlayerState(worldName)
  const time = player?.gameTime ?? { hour: 8, minute: 0, day: 1 }
  parts.push(`# Current Time: ${pad2(time.hour)}:${pad2(time.minute)}, Day ${time.day}`, '')

  const lore = services.worlds.loadLore(worldName)
  if (lore) parts.push('# World Lore', '', lore.trim(), '')

  const history = services.worlds.loadHistory(worldName)
  if (history) parts.push('# World History', '', history.trim(), '')

  const location = input.currentLocation
    ? services.locations.loadLocation(worldName, input.currentLocation)
    : null

  parts.push('# Current Location', '', `**${location?.displayName ?? 'Unknown'}**`)
  if (location?.description) parts.push('', location.description.trim())
  if (location?.adjacent.length) parts.push('', `Adjacent locations: ${location.adjacent.join(', ')}`)
  parts.push('')

  const stats = player?.stats ?? {}
  if (Object.keys(stats).length > 0) {
    parts.push('# Player Stats', '')
    for (const [name, value] of Object.entries(stats)) parts.push(`- ${name}: ${String(value)}`)
    parts.push('')
  }

  return parts.join('\n')
}

export interface ActionManagerMessageInput extends ActionManagerContextInput {
  playerAction: string
  agentName: string
  npcReactions?: AgentReaction[]
  /** NPCs started alongside this turn and still speaking. Mutually exclusive
   * with {@link npcReactions}: reactions already in hand are pasted in, ones
   * still in flight are announced and fetched with `await_reactions`. */
  pendingReactionNames?: string[]
}

export function buildActionManagerUserMessage(
  services: GameplayServices,
  input: ActionManagerMessageInput,
): string {
  const location = input.currentLocation
    ? services.locations.loadLocation(input.worldName, input.currentLocation)
    : null
  const locationName = location?.name ?? 'Unknown'

  const parts: string[] = ['<user_reaction>', input.playerAction, '</user_reaction>', '']

  if (input.npcReactions?.length) {
    parts.push('<npc_reactions>')
    parts.push("The following NPCs at this location have reacted to the player's action:", '')
    for (const reaction of input.npcReactions) {
      parts.push(`### ${reaction.agentName}`, reaction.content, '')
    }
    parts.push('</npc_reactions>', '')
    parts.push(
      'Voice these NPCs in your narration: name each one, quote what they said as spoken ' +
        'dialogue and stage what they did. Nothing they said reaches the player except ' +
        'through you.',
      '',
    )
  } else if (input.pendingReactionNames?.length) {
    // The NPCs were started at the same moment this turn was, so the reactions
    // do not exist yet. Announcing who is speaking is what makes the first
    // narration possible: it can set the scene with the right cast before a
    // single reaction has come back.
    parts.push('<npc_reactions status="in_flight">')
    parts.push(
      `${input.pendingReactionNames.join(', ')} — present at this location — are reacting to ` +
        "the player's action right now, at the same time as you.",
      '',
      'Narrate the action itself first: the player is watching a blank screen until your ' +
        'first `narration` lands, and it does not have to wait for them. Then call ' +
        '`await_reactions` to collect what they said, and call `narration` again to voice ' +
        'it — quoted dialogue, attributed by name.',
      '',
      'Settle the reactions with `await_reactions` before `travel`: leaving a location ' +
        'while its characters are still speaking cuts them off mid-sentence.',
    )
    parts.push('</npc_reactions>', '')
  }

  // Read-and-clear: this is one-shot continuity written by the `travel` tool so
  // the first turn at a new location knows how the player got there. Reading it
  // twice would repeat the arrival in the narration.
  const arrival = services.rooms.loadAndClearArrivalContext(input.worldName)
  if (arrival) {
    parts.push(
      '[Arrival Context - for continuity from previous location]',
      `Player's triggering action: ${arrival.triggeringAction ?? ''}`,
      `From location: ${arrival.fromLocation ?? ''}`,
      'Arrival narration shown to player:',
      `"${arrival.previousNarration ?? ''}"`,
      'Note: Check if essential NPCs should be present at this location.',
      '[End of arrival context]',
      '',
    )
  }

  parts.push(`[Current location: ${locationName}]`)
  const base = parts.join('\n')

  const instruction = responseInstruction('response_AM', input.language)
  if (!instruction) return base
  // Korean particle agreement: the instruction embeds `{agent_name:은는}`, whose
  // correct form depends on whether the name ends in a consonant.
  return `${base}\n${formatWithParticles(instruction.trim(), { agent_name: input.agentName })}`
}

/**
 * The per-language line that primes the model's thinking block. It reads oddly
 * out of context because it is seeding the first thinking token, so the SDK's
 * thinking process engages and the UI has something to show.
 */
export function responseInstruction(
  key: 'response_AM' | 'response_agent' | 'response_OM',
  language: string | null | undefined,
): string {
  const config = getConversationContextConfig()
  const section = (config.conversation_context ?? {}) as Record<string, unknown>
  const byLanguage = section[key]
  if (typeof byLanguage !== 'object' || byLanguage === null) return ''
  const value = (byLanguage as Record<string, unknown>)[toLangKey(language)]
  return typeof value === 'string' ? value : ''
}
