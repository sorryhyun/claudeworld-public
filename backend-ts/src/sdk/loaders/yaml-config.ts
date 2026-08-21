/**
 * YAML configuration loading with mtime-keyed hot reload.
 *
 * Ported from `backend/sdk/loaders/cache.py` and `yaml_loaders.py`.
 *
 * The cache *is* the hot-reload mechanism: every read stats the file and
 * reloads when the mtime moved, so editing `guidelines_3rd.yaml` takes effect
 * on the next agent response with no restart. Keep the stat — dropping it in
 * favour of a plain memo would silently break that contract.
 */

import { readFileSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

import { getSettings } from '../../config/settings'
import { getLogger } from '../../infrastructure/logging/logger'

const logger = getLogger('YamlConfig')

export type YamlConfig = Record<string, unknown>

interface CacheEntry {
  mtimeMs: number
  config: YamlConfig
}

const configCache = new Map<string, CacheEntry>()

/** Mtime in ms, or 0 when the file is missing (matching Python's 0.0). */
function getFileMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Read and parse a YAML file. Never throws: a missing or malformed file warns
 * and yields `{}`, because config loading sits on the request path and a bad
 * edit should degrade one prompt, not take down the server.
 *
 * Python wraps the read in `file_lock` to avoid observing a half-written file.
 * There is no writer for these files inside this process, and a concurrent
 * external write is caught by the parse failure below, so the lock is dropped.
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
    const parsed: unknown = parseYaml(raw)
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

// ============================================================================
// Named config files
// ============================================================================

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

/**
 * Debug config, with `DEBUG_AGENTS` overriding `debug.enabled`.
 *
 * Python mutates the cached dict in place, so the override leaks into every
 * later reader even after the env changes. We copy the affected level instead.
 */
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
