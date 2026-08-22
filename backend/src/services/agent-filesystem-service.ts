/**
 * Character agents that live inside a world — `worlds/{name}/agents/`.
 *
 * Ported from `backend/services/agent_filesystem_service.py`.
 *
 * This is the *world-local* agent tree, distinct from the repo-level `agents/`
 * tree that `AgentConfigService` writes: these folders are created at run
 * time by the Character Designer sub-agent and by the `persist_character_design`
 * tool, and they hold characters that exist only in one world. The two trees
 * share a layout (`in_a_nutshell.md`, `characteristics.md`, `profile.*`) and are
 * parsed by the same code, which is why {@link getAgentDetails} reuses
 * {@link parseAgentConfig} rather than re-reading the files itself.
 *
 * A character is never deleted, only archived: `agents/_archived/{name}_{stamp}/`.
 * The leading underscore is what keeps it out of {@link listWorldAgents}, so the
 * archive convention and the listing filter are one mechanism, not two.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import { getLogger } from '../infrastructure/logging/logger'
import { parseAgentConfig, REQUIRED_AGENT_FILES } from '../sdk/parsing/agent-config'
import { MtimeCache, WorldService } from './world-service'

const logger = getLogger('AgentFilesystemService')

/** Directory holding archived characters, under a world's `agents/`. */
const ARCHIVE_DIR = '_archived'

/**
 * One world character, as the character tools consume it.
 *
 * `name` and `folderName` always hold the same string. Python's docstring
 * promises `name` is a display name with underscores replaced by spaces
 * (`agent_filesystem_service.py:121-122`) but the code returns the folder name
 * for both, and `list_characters` then checks the room roster against *both*
 * fields as if they could differ. Both fields are kept so that consumer logic
 * ports across unchanged, and so the day someone implements the display name
 * there is a field to put it in.
 */
export interface WorldAgentDetails {
  name: string
  folderName: string
  /** Trimmed `in_a_nutshell.md`, or `''` when the file is missing. */
  inANutshell: string
  /** Absolute path to the profile image, or `null` when there is none. */
  profilePic: string | null
}

/**
 * `%Y%m%d_%H%M%S` in UTC — the archive folder's collision suffix.
 *
 * UTC, not local time, because that is what `datetime.utcnow()` gives Python;
 * a local stamp would sort differently against folders the other backend wrote.
 */
function utcStamp(when: Date): string {
  const iso = when.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}_${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
}

export class AgentFilesystemService {
  private readonly worlds: WorldService

  /** Same constructor shape as `LocationStorage`: a worlds dir and a shared cache. */
  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
  }

  private agentsDir(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), 'agents')
  }

  private agentPath(worldName: string, agentName: string): string {
    return join(this.agentsDir(worldName), agentName)
  }

  // --------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------

  /**
   * Write a character's folder: the two identity files, and a copy of a profile
   * picture when the caller has one on disk.
   *
   * Both files are written unconditionally, even empty, because a folder holding
   * neither is not an agent — {@link listWorldAgents} would skip it and the
   * character would exist in the room roster but not in any listing.
   *
   * `profilePicPath` keeps its original extension. It is only ever passed by
   * hand today; the design tools call this with two arguments.
   */
  createAgent(
    worldName: string,
    agentName: string,
    inANutshell: string,
    characteristics: string,
    profilePicPath?: string | null,
  ): void {
    const agentPath = this.agentPath(worldName, agentName)
    // Python uses `mkdir(exist_ok=True)`, which fails when the world has no
    // `agents/` directory. Every world built by `WorldService.createWorld` has
    // one, so `recursive` costs nothing and is forgiving of hand-made worlds —
    // same call as `LocationStorage.createLocation` makes, for the same reason.
    mkdirSync(agentPath, { recursive: true })

    writeFileSync(join(agentPath, 'in_a_nutshell.md'), inANutshell, 'utf-8')
    writeFileSync(join(agentPath, 'characteristics.md'), characteristics, 'utf-8')

    if (profilePicPath && existsSync(profilePicPath)) {
      copyFileSync(profilePicPath, join(agentPath, `profile${extname(profilePicPath)}`))
    }

    logger.info(`Created agent '${agentName}' in world '${worldName}'`)
  }

  /**
   * Move a character into `agents/_archived/{name}_{stamp}/`. `false` when there
   * was no such character.
   *
   * Called when a character dies, departs, or is removed by hand. Archiving
   * rather than deleting keeps the character's memories readable after the fact,
   * and the timestamp suffix is what lets the same name be archived twice.
   *
   * Two characters archived inside the same second collide. Python's
   * `shutil.move` resolves that by moving the second folder *inside* the first,
   * silently burying it; `renameSync` throws `ENOTEMPTY` instead, which
   * propagates to the tool handler as a failed archive. Neither is right, but a
   * loud failure beats a character that vanishes into another one's folder.
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

  // --------------------------------------------------------------------
  // Listing
  // --------------------------------------------------------------------

  /**
   * Folder names of the world's live characters.
   *
   * A folder counts only if it has at least one identity file, which is the same
   * rule `listAvailableConfigs` applies to the repo-level tree — an empty folder
   * left behind by a half-finished creation is not a character. Folders starting
   * with `_` are internal (`_archived`) and never listed.
   *
   * Sorted, where Python returns raw `iterdir()` order. That order is
   * filesystem-dependent, so the same world listed its characters in a different
   * order on two machines and the model saw a different roster ordering each
   * time; `parseAgentConfig`'s port made the same call for the same reason.
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

  /**
   * Read one character's folder. `null` when it does not exist.
   *
   * Delegated to {@link parseAgentConfig}, which reads the same files Python
   * re-reads inline here. It also parses `consolidated_memory.md` and
   * `config.yaml`, which this caller discards — a few extra reads per character
   * on a tool-call path, in exchange for one implementation of "what an agent
   * folder contains" rather than two that can drift.
   *
   * One behavioural difference comes with it: `parseAgentConfig` falls back to
   * *any* image in the folder when none of `profile`/`avatar`/`picture`/`photo`
   * is present, where Python's version here reports no picture at all. It is
   * strictly more permissive, it matches what the rest of the port already does
   * with the repo-level tree, and `profile_pic` has no consumer on this path
   * today — `list_characters` reads only the name and the nutshell.
   */
  getAgentDetails(worldName: string, agentName: string): WorldAgentDetails | null {
    const agentPath = this.agentPath(worldName, agentName)
    const config = parseAgentConfig(agentPath)
    if (config === null) return null

    return {
      name: agentName,
      folderName: agentName,
      inANutshell: config.inANutshell ?? '',
      // Python stores an absolute path here, not a filename; the frontend serves
      // the image from it. `parseAgentConfig` returns the filename, so it is
      // rejoined rather than passed through.
      profilePic: config.profilePic === null ? null : join(agentPath, config.profilePic),
    }
  }

  /** {@link listWorldAgents}, resolved to details. Folders that vanish mid-listing are dropped. */
  listWorldAgentsWithDetails(worldName: string): WorldAgentDetails[] {
    const details: WorldAgentDetails[] = []
    for (const name of this.listWorldAgents(worldName)) {
      const detail = this.getAgentDetails(worldName, name)
      if (detail !== null) details.push(detail)
    }
    return details
  }
}
