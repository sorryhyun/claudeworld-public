/**
 * Writes to the `agents/` tree — the filesystem-primary agent config, of which
 * the database is only a cache. Concurrency rests on {@link safeAppendLine}'s
 * `O_APPEND`: two agents writing a memory in the same instant interleave between
 * lines, never within one, which keeps every method here synchronous. Async
 * `withFileLock` would force the callers async for a lock covering
 * read-modify-write sequences neither method performs.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getSettings } from '../config/settings'
import { safeAppendLine } from '../infrastructure/locking'
import { getLogger } from '../infrastructure/logging/logger'
import { parseAgentConfig, type AgentConfigData } from '../sdk/parsing/agent-config'
import type { GameTime } from './player-service'

const logger = getLogger('AgentConfigService')

// `svg+xml` is unreachable: the pattern below captures `\w+`, so such an
// upload is rejected before this map is consulted.
const EXTENSION_BY_IMAGE_TYPE: Record<string, string> = {
  png: '.png',
  jpg: '.jpg',
  jpeg: '.jpg',
  gif: '.gif',
  webp: '.webp',
  'svg+xml': '.svg',
  svg: '.svg',
}

const DEFAULT_IMAGE_EXTENSION = '.png'

// `data:image/{subtype};base64,{payload}`. No `s` flag, so a line-wrapped data
// URL keeps only its first line and decodes to a truncated image.
const DATA_URL_PATTERN = /^data:image\/(\w+);base64,(.+)/

const PROFILE_BASENAME = 'profile'

function pad2(value: number): string {
  return String(Math.trunc(value)).padStart(2, '0')
}

export class AgentConfigService {
  private readonly projectRoot: string

  // An argument rather than a `settings` lookup, so this stays testable against
  // a temp directory — same shape as `WorldService`.
  constructor(projectRoot: string = getSettings().paths.projectRoot) {
    this.projectRoot = projectRoot
  }

  private get agentsDir(): string {
    return join(this.projectRoot, 'agents')
  }

  /**
   * Append one memory line to an agent's `recent_events.md`. `configFile` is the
   * agent *folder* relative to the project root; a non-directory is refused
   * rather than created, so a bad `config_file` cannot scatter agent folders.
   */
  appendToRecentEvents(
    configFile: string | null | undefined,
    memoryEntry: string,
    gameTime?: Partial<GameTime> | null,
  ): boolean {
    if (!configFile) return false

    // An *empty* game time falls through to the date stamp rather than
    // rendering as `Day 1, 00:00`.
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

  /**
   * Parse an agent folder, or `null`. The path is resolved here rather than
   * passed relative, because {@link parseAgentConfig} would resolve it against
   * the *settings* project root, not this service's.
   */
  loadAgentConfig(configFile: string | null | undefined): AgentConfigData | null {
    if (!configFile) return null
    return parseAgentConfig(join(this.projectRoot, configFile))
  }

  /**
   * Decode a `data:image/…;base64,…` URL into `agents/{agentName}/profile.{ext}`,
   * untouched — no WebP conversion here. Any other `profile.*` is deleted first,
   * or a JPEG over a PNG leaves both and `findProfilePic` serves the *old* one.
   *
   * **Known bug: grouped agents get the wrong folder** — always
   * `agents/{agentName}/`, never `agents/group_x/{agentName}/`, so the picture
   * lands where the agent loader will not read it. Fixing it needs the agent's
   * `config_file`, a change of signature and of caller.
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
      // `Buffer.from` never throws on malformed base64, so an empty result is
      // the only signal the payload was junk.
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
