import { tool } from '@anthropic-ai/claude-agent-sdk'
import { getCharactersAtLocation, getLocation, getLocations } from '../../crud/locations'
import { getPlayerState } from '../../crud/player-state'
import type { LocationStorage } from '../../services/location-storage'
import { listCharactersTool, listLocationsTool, rollDice, rollTheDiceTool } from '../tools/gameplay'
import { requireWorldId, requireWorldName, toolSuccess, type SdkTool, type ToolContext } from './context'

/**
 * Read-only world queries plus the dice.
 *
 * Ports the pilot's slice of `sdk/handlers/location_tools.py`,
 * `character_tools.py` and `mechanics_tools.py`. These exist so the Action
 * Manager's system prompt does not have to carry the whole world: rosters and
 * maps are pulled on demand rather than injected into every turn's context.
 */

export interface WorldToolDeps {
  locations: LocationStorage
  /** Injectable so a test can pin an outcome; production passes `Math.random`. */
  random?: () => number
}

/** Descriptions in `description.md` open with a markdown heading; the list view drops it. */
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

  const currentLocationId = (): number | null =>
    getPlayerState(ctx.getDb(), worldId)?.currentLocationId ?? null

  const listLocations = tool(
    listLocationsTool.name,
    listLocationsTool.description,
    listLocationsTool.inputSchema,
    async () => {
      // The filesystem is authoritative for locations; the DB rows are a cache
      // that exists so rooms and messages have something to key on.
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
    listCharactersTool.description,
    listCharactersTool.inputSchema,
    async (args) => {
      const requested = args.location.trim()

      let locationId: number | null
      if (requested) {
        // Presence is room membership, and rooms hang off location *rows*, so a
        // name from the model has to be resolved back to a row before it can be
        // asked who is standing there.
        const match = getLocations(ctx.getDb(), worldId).find(
          (l) =>
            l.name.toLowerCase() === requested.toLowerCase() ||
            l.displayName?.toLowerCase() === requested.toLowerCase(),
        )
        if (!match) return toolSuccess(`No location named "${requested}" exists in this world.`)
        locationId = match.id
      } else {
        locationId = currentLocationId()
      }

      if (locationId === null) return toolSuccess('The player is not at any location.')

      const characters = getCharactersAtLocation(ctx.getDb(), locationId, { excludeSystemAgents: true })
      if (characters.length === 0) return toolSuccess('There is nobody else here.')

      return toolSuccess(
        characters.map((c) => `- **${c.name}**: ${c.inANutshell ?? '(no description)'}`).join('\n'),
      )
    },
  )

  const rollTheDice = tool(
    rollTheDiceTool.name,
    rollTheDiceTool.description,
    rollTheDiceTool.inputSchema,
    async () => toolSuccess(rollDice(deps.random ?? Math.random)),
  )

  return [listLocations, listCharacters, rollTheDice]
}
