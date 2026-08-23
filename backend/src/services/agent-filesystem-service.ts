/**
 * Character agents living inside one world (`worlds/{name}/agents/`), created at
 * run time by the Character Designer — distinct from the repo-level `agents/`
 * tree, though both share a layout and a parser. A character is never deleted,
 * only archived to `agents/_archived/{name}_{stamp}/`; the leading underscore is
 * what keeps it out of {@link listWorldAgents}.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import { getLogger } from '@/infrastructure/logging/logger'
import { parseAgentConfig, REQUIRED_AGENT_FILES } from '@/sdk/parsing/agent-config'
import { MtimeCache, WorldService } from './world-service'

const logger = getLogger('AgentFilesystemService')

const ARCHIVE_DIR = '_archived'

// `name` and `folderName` currently always hold the same string; consumers
// compare against both, and `name` is where a real display name would go.
export interface WorldAgentDetails {
  name: string
  folderName: string
  inANutshell: string
  /** Absolute path to the profile image, or `null` when there is none. */
  profilePic: string | null
}

// `%Y%m%d_%H%M%S` in UTC — the archive folder's collision suffix.
function utcStamp(when: Date): string {
  const iso = when.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}_${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
}

export class AgentFilesystemService {
  private readonly worlds: WorldService

  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
  }

  private agentsDir(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), 'agents')
  }

  private agentPath(worldName: string, agentName: string): string {
    return join(this.agentsDir(worldName), agentName)
  }

  // Both identity files are written even when empty: a folder holding neither is
  // not an agent, so the character would be in the room roster but no listing.
  createAgent(
    worldName: string,
    agentName: string,
    inANutshell: string,
    characteristics: string,
    profilePicPath?: string | null,
  ): void {
    const agentPath = this.agentPath(worldName, agentName)
    // `recursive` is forgiving of hand-made worlds with no `agents/` directory.
    mkdirSync(agentPath, { recursive: true })

    writeFileSync(join(agentPath, 'in_a_nutshell.md'), inANutshell, 'utf-8')
    writeFileSync(join(agentPath, 'characteristics.md'), characteristics, 'utf-8')

    if (profilePicPath && existsSync(profilePicPath)) {
      copyFileSync(profilePicPath, join(agentPath, `profile${extname(profilePicPath)}`))
    }

    logger.info(`Created agent '${agentName}' in world '${worldName}'`)
  }

  /**
   * Move a character into `agents/_archived/{name}_{stamp}/`; `false` when there
   * was no such character. Two archives of one name inside the same second
   * collide and `renameSync` throws `ENOTEMPTY`, which surfaces as a failed
   * archive — better than a character silently buried in another one's folder.
   */
  archiveAgent(worldName: string, agentName: string): boolean {
    const agentPath = this.agentPath(worldName, agentName)
    if (!existsSync(agentPath)) {
      logger.warning(`Agent '${agentName}' not found in world '${worldName}'`)
      return false
    }

    const archivePath = join(this.agentsDir(worldName), ARCHIVE_DIR)
    mkdirSync(archivePath, { recursive: true })

    const archivedAgentPath = join(archivePath, `${agentName}_${utcStamp(new Date())}`)
    renameSync(agentPath, archivedAgentPath)

    logger.info(`Archived agent '${agentName}' in world '${worldName}' to ${archivedAgentPath}`)
    return true
  }

  /**
   * Folder names of the world's live characters: at least one identity file, no
   * leading `_`. Sorted deliberately — raw directory order is filesystem-
   * dependent, so the model would see a different roster per machine.
   */
  listWorldAgents(worldName: string): string[] {
    const agentsDir = this.agentsDir(worldName)
    if (!existsSync(agentsDir)) return []

    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .filter((name) =>
        REQUIRED_AGENT_FILES.some((file) => existsSync(join(agentsDir, name, file))),
      )
      .sort()
  }

  // Delegated to {@link parseAgentConfig} so there is one implementation of
  // "what an agent folder contains", at the cost of a few discarded reads.
  getAgentDetails(worldName: string, agentName: string): WorldAgentDetails | null {
    const agentPath = this.agentPath(worldName, agentName)
    const config = parseAgentConfig(agentPath)
    if (config === null) return null

    return {
      name: agentName,
      folderName: agentName,
      inANutshell: config.inANutshell ?? '',
      // An absolute path, not a filename: the frontend serves the image from it.
      profilePic: config.profilePic === null ? null : join(agentPath, config.profilePic),
    }
  }

  /** {@link listWorldAgents} resolved to details; vanished folders are dropped. */
  listWorldAgentsWithDetails(worldName: string): WorldAgentDetails[] {
    const details: WorldAgentDetails[] = []
    for (const name of this.listWorldAgents(worldName)) {
      const detail = this.getAgentDetails(worldName, name)
      if (detail !== null) details.push(detail)
    }
    return details
  }
}
