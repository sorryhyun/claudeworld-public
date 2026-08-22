/**
 * Writes to the `agents/` tree — the filesystem-primary agent config.
 *
 * Ported from `backend/services/agent_config_service.py`.
 *
 * `agents/{name}/*.md` is the source of truth and the database is its cache, so
 * everything here writes the file and lets the next read pick it up. Two things
 * are written: a memory line appended to `recent_events.md` (by the `memorize`
 * tool and by the agent factory), and a profile picture decoded from a data URL
 * (by `update_agent`, which then nulls the database column so the image is
 * served from disk).
 *
 * ## What carries the concurrency guarantee
 *
 * `infrastructure/locking.ts`, and specifically its atomic primitives rather
 * than its lock. Python wraps the append in `file_lock(path, "a")`, but the
 * `flock` that acquires is not what makes the append safe — `O_APPEND` is,
 * because it makes seek-and-write one kernel operation, so two agents writing a
 * memory in the same instant interleave between lines and never within one.
 * {@link safeAppendLine} has that same guarantee, and every method here stays
 * synchronous as a result. `withFileLock` is deliberately not used: it is async,
 * which would force the synchronous CRUD and tool-handler callers to become
 * async, in exchange for a lock that covers read-modify-write sequences neither
 * of these methods performs.
 *
 * ## The MCP cache invalidation does not port
 *
 * Every Python write here ends by calling `get_mcp_registry().invalidate_cache()`
 * so the next turn rebuilds an agent's MCP servers from the changed files. There
 * is no such cache in this port — `sdk/handlers/servers.ts` builds servers per
 * turn on purpose (see its header) — so the hot-reload those calls existed to
 * preserve is unconditional here, and there is nothing to invalidate.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getSettings } from '../config/settings'
import { safeAppendLine } from '../infrastructure/locking'
import { getLogger } from '../infrastructure/logging/logger'
import { parseAgentConfig, type AgentConfigData } from '../sdk/parsing/agent-config'
import type { GameTime } from './player-service'

const logger = getLogger('AgentConfigService')

/**
 * Image subtype (from the data URL) to file extension.
 *
 * **`svg+xml` is unreachable.** The data-URL pattern below captures `\w+`, which
 * excludes `+`, so `data:image/svg+xml;base64,…` never matches at all and the
 * upload is rejected before this map is consulted. Both the pattern and the dead
 * entry are Python's (`agent_config_service.py:157,172`) and are reproduced as
 * written — an SVG avatar is rejected by both backends, and "fixing" only this
 * one would let TypeScript accept an upload Python refuses.
 */
const EXTENSION_BY_IMAGE_TYPE: Record<string, string> = {
  png: '.png',
  jpg: '.jpg',
  jpeg: '.jpg',
  gif: '.gif',
  webp: '.webp',
  'svg+xml': '.svg',
  svg: '.svg',
}

/** Unmatched image subtypes are stored as `.png`, as in Python. */
const DEFAULT_IMAGE_EXTENSION = '.png'

/**
 * `data:image/{subtype};base64,{payload}`, anchored at the start only.
 *
 * No `s` flag, matching Python's default: `.` stops at a newline, so a data URL
 * that was line-wrapped somewhere en route keeps only its first line and decodes
 * to a truncated image in both backends.
 */
const DATA_URL_PATTERN = /^data:image\/(\w+);base64,(.+)/

/** Basename of the profile image, without extension. */
const PROFILE_BASENAME = 'profile'

/**
 * Zero-pad to two digits, the way Python's `f"{hour:02d}"` does.
 *
 * `padStart` alone would silently widen a value above 99; there is no such game
 * time, so this is the same one-liner in both languages.
 */
function pad2(value: number): string {
  return String(Math.trunc(value)).padStart(2, '0')
}

export class AgentConfigService {
  private readonly projectRoot: string

  /**
   * `projectRoot` is an explicit argument rather than a `settings` lookup at
   * every call site so this layer stays testable against a temp directory —
   * same shape as `WorldService`. The `agents/` directory is derived from
   * it, matching Python's `project_root / "agents"`.
   */
  constructor(projectRoot: string = getSettings().paths.projectRoot) {
    this.projectRoot = projectRoot
  }

  private get agentsDir(): string {
    return join(this.projectRoot, 'agents')
  }

  // --------------------------------------------------------------------
  // recent_events.md
  // --------------------------------------------------------------------

  /**
   * Append one memory line to an agent's `recent_events.md`.
   *
   * `configFile` is the agent *folder*, relative to the project root, as stored
   * in the `agents.config_file` column (e.g. `agents/group_슈타게/크리스`). It is
   * a directory despite the name; a path that is not one is refused rather than
   * created, because a bad `config_file` should not scatter agent folders.
   *
   * The line is stamped with in-world time when the caller has it —
   * `- [Day 3, 14:05] …` — and with the UTC calendar date otherwise. The second
   * form only shows up outside a game (`agent_factory.py:278`), and mixing the
   * two in one file is Python's behaviour, not an accident of this port.
   *
   * Every entry is written with a *leading* newline, so entries are separated by
   * a blank line and the first entry in a fresh file starts with one. Python has
   * a second branch that omits it when the file has to be created
   * (`agent_config_service.py:106-116`), but that branch is unreachable: append
   * mode creates the file and `file_lock` has already created the parent, so
   * `FileNotFoundError` cannot be raised there. It is not ported.
   *
   * Returns whether the write happened; the tool handlers treat a failed memory
   * as a soft failure rather than an aborted turn.
   */
  appendToRecentEvents(
    configFile: string | null | undefined,
    memoryEntry: string,
    gameTime?: Partial<GameTime> | null,
  ): boolean {
    if (!configFile) return false

    // Python tests the dict for truthiness, so an *empty* game time falls
    // through to the date stamp rather than rendering as `Day 1, 00:00`.
    const hasGameTime = gameTime != null && Object.keys(gameTime).length > 0
    const formattedEntry = hasGameTime
      ? `- [Day ${gameTime.day ?? 1}, ${pad2(gameTime.hour ?? 0)}:${pad2(gameTime.minute ?? 0)}] ${memoryEntry}`
      : `- [${new Date().toISOString().slice(0, 10)}] ${memoryEntry}`

    const configPath = join(this.projectRoot, configFile)
    if (!isDirectory(configPath)) {
      logger.warning(`Warning: Config path ${configPath} is not a directory`)
      return false
    }

    const recentEventsFile = join(configPath, 'recent_events.md')
    if (!safeAppendLine(recentEventsFile, `\n${formattedEntry}`)) return false

    logger.debug(`Appended memory entry to ${recentEventsFile}`)
    return true
  }

  // --------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------

  /**
   * Parse an agent folder. `null` when the path is empty, missing, or unreadable.
   *
   * The path is resolved here rather than handed to {@link parseAgentConfig} as
   * a relative one, because that function resolves relative paths against the
   * *settings* project root — which is the real repo even when this service was
   * constructed on a temp directory.
   */
  loadAgentConfig(configFile: string | null | undefined): AgentConfigData | null {
    if (!configFile) return null
    return parseAgentConfig(join(this.projectRoot, configFile))
  }

  // --------------------------------------------------------------------
  // profile.*
  // --------------------------------------------------------------------

  /**
   * Decode a `data:image/…;base64,…` URL into `agents/{agentName}/profile.{ext}`.
   *
   * The bytes are written through untouched. There is no WebP conversion on this
   * path in either backend: `utils/images.py` compresses *message* and *world*
   * images, and nothing in the profile-picture path calls it. Re-encoding here
   * would change which file the agent folder ends up holding (`profile.webp`
   * where Python wrote `profile.png`) for no benefit, so it is not done.
   *
   * Any other `profile.*` is deleted first. Without that, uploading a JPEG over
   * a PNG leaves both on disk and the reader picks whichever the extension order
   * in `findProfilePic` reaches first — which is the *old* one, since `.png`
   * precedes `.jpg`.
   *
   * **Grouped agents get the wrong folder.** The target is always
   * `agents/{agentName}/`, never `agents/group_x/{agentName}/`, so a picture
   * uploaded for a grouped agent lands in a new top-level folder the agent
   * loader will not read from. Python does the same (`agent_config_service.py:181-186`)
   * and CRUD passes it a bare `agent.name` with no group to work from; fixing it
   * needs the agent's `config_file`, which is a change of signature and of
   * caller, not of this line.
   */
  saveBase64ProfilePic(agentName: string, base64Data: string): boolean {
    const match = DATA_URL_PATTERN.exec(base64Data)
    const imageType = match?.[1]
    const encodedData = match?.[2]
    if (imageType === undefined || encodedData === undefined) {
      logger.warning(`Invalid base64 data URL format for agent ${agentName}`)
      return false
    }

    const fileExt = EXTENSION_BY_IMAGE_TYPE[imageType.toLowerCase()] ?? DEFAULT_IMAGE_EXTENSION

    try {
      const imageData = Buffer.from(encodedData, 'base64')
      // `Buffer.from` never throws on malformed base64 — it drops what it cannot
      // decode — where Python's `b64decode` raises on bad padding and returns
      // False. An empty result is the one case worth catching: it means the
      // payload decoded to nothing, and writing a zero-byte `profile.png` would
      // leave the agent with a picture that fails to render everywhere.
      if (imageData.length === 0) {
        logger.warning(`Empty image payload for agent ${agentName}`)
        return false
      }

      const agentFolder = join(this.agentsDir, agentName)
      mkdirSync(agentFolder, { recursive: true })

      const profilePath = join(agentFolder, `${PROFILE_BASENAME}${fileExt}`)
      for (const entry of readdirSync(agentFolder)) {
        if (!entry.startsWith(`${PROFILE_BASENAME}.`)) continue
        const oldFile = join(agentFolder, entry)
        if (oldFile !== profilePath) unlinkSync(oldFile)
      }

      writeFileSync(profilePath, imageData)
      logger.info(`Saved profile picture for ${agentName} to ${profilePath}`)
      return true
    } catch (error) {
      logger.error(`Failed to save profile picture for ${agentName}: ${String(error)}`)
      return false
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
