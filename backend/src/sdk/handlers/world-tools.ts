import {
  getAllCharactersInWorld,
  getCharactersAtLocation,
  getLocation,
  getLocationByName,
  getLocations,
} from '@/crud/locations'
import { getPlayerState } from '@/crud/player-state'
import type { AgentFilesystemService } from '@/services/agent-filesystem-service'
import type { LocationStorage } from '@/services/location-storage'
import { RoomMappingService } from '@/services/room-mapping'
import {
  formatDiceRoll,
  listCharactersTool,
  listLocationsTool,
  rollDice,
  rollTheDiceTool,
} from '@/sdk/tools/gameplay'
import { resolveTool } from '@/sdk/tools/registry'
import { tool, requireWorldId, requireWorldName, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * Read-only world queries plus the dice. These exist so the Action Manager's
 * system prompt does not have to carry the whole world: rosters and maps are
 * pulled on demand rather than injected into every turn's context.
 */

export interface WorldToolDeps {
  locations: LocationStorage
  /**
   * The character roster on disk. Optional because `ServerDeps.agentFiles` is —
   * without it `list_characters` can only report the characters the database
   * has placed somewhere, which is the narrower answer, not a wrong one.
   */
  agentFiles?: AgentFilesystemService
  /** `_state.json`, the seating chart, for characters with no location row. */
  rooms?: RoomMappingService
  /** Injectable so a test can pin an outcome; production passes `Math.random`. */
  random?: () => number
}

function describeAgent(agent: { name: string; inANutshell: string | null }): string {
  return characterLine(agent.name, agent.inANutshell)
}

function characterLine(name: string, nutshell: string | null): string {
  const text = nutshell?.trim()
  return `- **${name}**: ${text ? text : '(no description)'}`
}

// Folder names, display names and whatever the model typed all fold together.
function foldName(name: string): string {
  return name.replaceAll(' ', '_').toLowerCase()
}

// Descriptions open with a markdown heading; the list view drops it.
function summarize(description: string, maxChars = 100): string {
  const body = description.replace(/^#[^\n]*\n+/, '').trim()
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body
}

export function createWorldTools(
  ctx: ToolContext,
  deps: WorldToolDeps,
): SdkTool[] {
  const worldName = requireWorldName(ctx)
  const worldId = requireWorldId(ctx)

  // Descriptions come through the registry so a `group_config.yaml` override
  // reaches these three the way it reaches every other tool; `null` means the
  // group disabled it and it must not be offered.
  const listLocationsDef = resolveTool(listLocationsTool.name, ctx.groupName)
  const listCharactersDef = resolveTool(listCharactersTool.name, ctx.groupName)
  const rollTheDiceDef = resolveTool(rollTheDiceTool.name, ctx.groupName)

  const currentLocationId = (): number | null =>
    getPlayerState(ctx.getDb(), worldId)?.currentLocationId ?? null

  /**
   * Folded character name → the location label it is seated at in
   * `_state.json`. Built once per call and only when something is missing from
   * the database, since it reads and parses the whole transient state.
   */
  let seating: Map<string, string> | null = null
  const seatingChart = (): Map<string, string> => {
    if (seating) return seating
    seating = new Map()
    if (!deps.rooms) return seating

    for (const [roomKey, mapping] of Object.entries(deps.rooms.getAllRoomMappings(worldName))) {
      const slug = RoomMappingService.roomKeyToLocation(roomKey)
      if (slug === null) continue
      // Resolved through the row so a seated character lands in the same group
      // as a placed one; the slug is the fallback for a location with no row.
      const row = getLocationByName(ctx.getDb(), worldId, slug)
      const label = row ? row.displayName || row.name : slug
      for (const name of mapping.agents) seating.set(foldName(name), label)
    }
    return seating
  }

  const listLocations = tool(
    listLocationsTool.name,
    listLocationsDef?.description ?? listLocationsTool.description,
    listLocationsTool.inputSchema,
    async () => {
      // The filesystem is authoritative for locations; the DB rows are a cache
      // so rooms and messages have something to key on.
      const entries = Object.entries(deps.locations.loadAllLocations(worldName))
      if (entries.length === 0) return toolSuccess('No locations exist in this world yet.')

      const here = currentLocationId()
      const currentName = here === null ? null : (getLocation(ctx.getDb(), here)?.name ?? null)

      const lines = entries.map(([name, config]) => {
        const marker = name === currentName ? ' (current)' : ''
        return `- **${config.displayName}** [${name}]${marker}: ${summarize(config.description)}`
      })
      return toolSuccess(lines.join('\n'))
    },
  )

  const listCharacters = tool(
    listCharactersTool.name,
    listCharactersDef?.description ?? listCharactersTool.description,
    listCharactersTool.inputSchema,
    async (args) => {
      const requested = args.location.trim()

      // Narrowed to one place: presence is room membership and rooms hang off
      // location *rows*, so a name from the model must be resolved to a row.
      if (requested) {
        const match = getLocations(ctx.getDb(), worldId).find(
          (l) =>
            l.name.toLowerCase() === requested.toLowerCase() ||
            l.displayName?.toLowerCase() === requested.toLowerCase(),
        )
        if (!match) return toolSuccess(`No location named "${requested}" exists in this world.`)

        const here = getCharactersAtLocation(ctx.getDb(), match.id, { excludeSystemAgents: true })
        if (here.length === 0) return toolSuccess(`Nobody is at "${requested}".`)
        return toolSuccess(here.map(describeAgent).join('\n'))
      }

      // The default is the *whole world*, not the current scene. Scoping it to
      // the player's location told the Action Manager an empty room meant an
      // empty cast, and it invented a character it already had one location
      // away; the roster is small enough to hand over whole.
      const db = ctx.getDb()
      const groups = new Map<string, string[]>()
      const listed = new Set<string>()

      const place = (label: string, line: string): void => {
        const lines = groups.get(label)
        if (lines) lines.push(line)
        else groups.set(label, [line])
      }

      // Ordered by location id, so the map's insertion order is the world's.
      for (const character of getAllCharactersInWorld(db, worldId, { excludeSystemAgents: true })) {
        listed.add(foldName(character.name))
        place(character.location_name, characterLine(character.name, character.in_a_nutshell))
      }

      // Everything the database did not account for. A character exists the
      // moment its folder does — `persist_character_design` writes the folder
      // and only sometimes a location row, and onboarding writes none at all —
      // so a roster read from the database alone hides exactly the characters
      // the Action Manager is most likely to invent a second copy of.
      const unplaced: string[] = []
      for (const entry of deps.agentFiles?.listWorldAgentsWithDetails(worldName) ?? []) {
        if (listed.has(foldName(entry.name))) continue
        listed.add(foldName(entry.name))

        const displayName = entry.name.replaceAll('_', ' ')
        const line = characterLine(displayName, entry.inANutshell)

        // `_state.json` is the seating chart and outlives a missing location
        // row, so it gets the second look before the character is called adrift.
        const seated = seatingChart().get(foldName(entry.name))
        if (seated) place(seated, line)
        else unplaced.push(line)
      }

      if (groups.size === 0 && unplaced.length === 0) {
        return toolSuccess('No characters exist in this world yet.')
      }

      const here = currentLocationId()
      const hereRow = here === null ? null : getLocation(db, here)
      const currentLabel = hereRow === null ? null : hereRow.displayName || hereRow.name

      const sections = [...groups.entries()].map(([label, lines]) => {
        const marker = label === currentLabel ? ' (current location)' : ''
        return `### ${label}${marker}\n${lines.join('\n')}`
      })

      if (currentLabel !== null && !groups.has(currentLabel)) {
        sections.unshift(`### ${currentLabel} (current location)\n- nobody`)
      }

      if (unplaced.length > 0) {
        sections.push(
          `### Not at any location\n${unplaced.join('\n')}\n` +
            '(These characters exist but are standing nowhere. Bring one into the scene with ' +
            '`move_character` rather than creating them again.)',
        )
      }

      return toolSuccess(sections.join('\n\n'))
    },
  )

  const rollTheDice = tool(
    rollTheDiceTool.name,
    rollTheDiceDef?.description ?? rollTheDiceTool.description,
    rollTheDiceTool.inputSchema,
    // The full result block, not just the bucket name: a bare
    // `nothing_happened` reads as a tool that failed to decide, and gets
    // re-rolled or narrated around.
    async () => toolSuccess(formatDiceRoll(rollDice(deps.random ?? Math.random))),
  )

  const tools: SdkTool[] = []
  if (listLocationsDef) tools.push(listLocations)
  if (listCharactersDef) tools.push(listCharacters)
  if (rollTheDiceDef) tools.push(rollTheDice)
  return tools
}
