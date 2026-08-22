/**
 * YAML configuration loading. The cache *is* the hot-reload mechanism: every
 * read stats the file and reloads when the mtime moved, so a config edit takes
 * effect on the next agent response. A plain memo silently breaks that.
 */

import { readFileSync, statSync } from 'node:fs'
import { YAML } from 'bun'

import { getSettings } from '../../config/settings'
import { getLogger } from '../../infrastructure/logging/logger'

const logger = getLogger('YamlConfig')

export type YamlConfig = Record<string, unknown>

interface CacheEntry {
  mtimeMs: number
  config: YamlConfig
}

const configCache = new Map<string, CacheEntry>()

/** Mtime in ms, or 0 when the file is missing. */
function getFileMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Never throws: a missing or malformed file warns and yields `{}`, because this
 * sits on the request path and a bad edit should degrade one prompt, not the
 * server. No file lock — nothing in this process writes these files.
 */
export function loadYamlFile(filePath: string): YamlConfig {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    logger.warning(`Configuration file not found: ${filePath}`)
    return {}
  }

  try {
    const parsed: unknown = YAML.parse(raw)
    if (parsed === null || parsed === undefined) return {}
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warning(`Expected a mapping at top level of ${filePath}`)
      return {}
    }
    return parsed as YamlConfig
  } catch (error) {
    logger.error(`Error loading YAML file ${filePath}: ${String(error)}`)
    return {}
  }
}

/** Load `filePath`, reusing the cached parse while the file's mtime is unchanged. */
export function getCachedConfig(filePath: string, forceReload = false): YamlConfig {
  const currentMtime = getFileMtime(filePath)

  if (!forceReload) {
    const cached = configCache.get(filePath)
    if (cached && cached.mtimeMs === currentMtime) return cached.config
  }

  const config = loadYamlFile(filePath)
  configCache.set(filePath, { mtimeMs: currentMtime, config })
  return config
}

/** Drop every cached parse. */
export function clearConfigCache(): void {
  configCache.clear()
}

export function getGuidelinesConfig(): YamlConfig {
  return getCachedConfig(getSettings().paths.guidelinesConfigPath)
}

export function getLocalizationConfig(): YamlConfig {
  return getCachedConfig(getSettings().paths.localizationConfigPath)
}

export function getLoreGuidelinesConfig(): YamlConfig {
  return getCachedConfig(getSettings().paths.loreGuidelinesConfigPath)
}

export function getConversationContextConfig(): YamlConfig {
  return getCachedConfig(getSettings().paths.conversationContextConfigPath)
}

/** `DEBUG_AGENTS` overrides `debug.enabled` on a copy, never in the cache. */
export function getDebugConfig(env: Record<string, string | undefined> = process.env): YamlConfig {
  const config = getCachedConfig(getSettings().paths.debugConfigPath)
  const debugSection = config.debug

  if (debugSection && typeof debugSection === 'object' && !Array.isArray(debugSection)) {
    const raw = (env.DEBUG_AGENTS ?? '').toLowerCase()
    if (raw === 'true' || raw === 'false') {
      return {
        ...config,
        debug: { ...(debugSection as Record<string, unknown>), enabled: raw === 'true' },
      }
    }
  }

  return config
}
