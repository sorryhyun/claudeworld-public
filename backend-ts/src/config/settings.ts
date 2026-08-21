/**
 * Centralized application settings.
 *
 * Ported from `backend/core/settings.py` (pydantic `BaseSettings`). Env var
 * names are unchanged so a single `.env` drives both backends.
 *
 * Layering matches pydantic-settings: real process env wins over `.env` file
 * values, and `.env` is read from the *project root*, not from `backend-ts/`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

import {
  createProjectPaths,
  DEFAULT_GUIDELINES_FILE,
  resolveProjectRoot,
  type ProjectPaths,
} from './paths'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('Settings')

export type EnvRecord = Record<string, string | undefined>

// ============================================================================
// Application Constants
// ============================================================================

/** Used when no system prompt can be loaded from the guidelines YAML. */
export const DEFAULT_FALLBACK_PROMPT = 'You are a helpful AI assistant.'

/** Rendered when an agent invokes the `skip` tool. */
export const SKIP_MESSAGE_TEXT = '(무시함)'

/** Character-facing MCP tool names, grouped. */
export const AGENT_TOOL_NAMES_BY_GROUP = {
  action: {
    skip: 'mcp__action__skip',
    memorize: 'mcp__action__memorize',
    recall: 'mcp__action__recall',
  },
  character: {
    memory_select: 'mcp__character__character_identity',
  },
  guidelines: {
    anthropic: 'mcp__guidelines__anthropic',
  },
} as const satisfies Record<string, Record<string, string>>

/** Flattened view of {@link AGENT_TOOL_NAMES_BY_GROUP}, for legacy call sites. */
export const AGENT_TOOL_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(AGENT_TOOL_NAMES_BY_GROUP).flatMap((group) => Object.entries(group)),
)

// ============================================================================
// Parsing helpers
// ============================================================================

/**
 * Pydantic's validators here are all `v.lower() == "true"`, so any other value
 * — including "1", "yes", "on" — is false. Reproduced exactly; see
 * {@link isGuestLoginEnabled} for the one place that accepts a wider set.
 */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  return raw.trim().toLowerCase() === 'true'
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function optional(raw: string | undefined): string | null {
  // pydantic treats an unset var and an empty string differently, but every
  // consumer of these fields does a truthiness check, so collapsing "" to null
  // keeps downstream code from having to test both.
  return raw === undefined || raw === '' ? null : raw
}

// ============================================================================
// .env file
// ============================================================================

/**
 * Minimal dotenv parser: `KEY=value`, optional `export ` prefix, `#` comments,
 * single- or double-quoted values (escapes only expanded inside double quotes,
 * matching python-dotenv).
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue

    const key = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = withoutExport.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"')
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    } else {
      // Unquoted values run to an unescaped inline comment.
      const comment = value.search(/\s#/)
      if (comment !== -1) value = value.slice(0, comment).trimEnd()
    }

    result[key] = value
  }

  return result
}

/**
 * Env var that makes {@link loadDotEnv} behave as if the file were absent.
 *
 * Set by the test preload (`src/tests/setup/env.ts`). Without it the suite's
 * result depends on whether the developer has run `make setup` and on what
 * that wrote: a `.env` carrying `GUIDELINES_FILE=…` redirects
 * `settings.paths.guidelinesConfigPath` at a YAML that does not exist, and the
 * six tests that read the real `guidelines_3rd.yaml` fail against a tree that
 * is green on CI, where no `.env` is ever written. Pinning the *absent* case is
 * what makes the two agree, since that is the case CI and a fresh clone have.
 */
export const SKIP_DOTENV_ENV_VAR = 'CW_TEST_NO_DOTENV'

/** Read `<projectRoot>/.env`, returning `{}` when absent or unreadable. */
export function loadDotEnv(projectRoot: string): Record<string, string> {
  if (process.env[SKIP_DOTENV_ENV_VAR]) return {}
  const envPath = join(projectRoot, '.env')
  if (!existsSync(envPath)) return {}
  try {
    return parseDotEnv(readFileSync(envPath, 'utf-8'))
  } catch (error) {
    logger.warning(`Failed to read ${envPath}: ${String(error)}`)
    return {}
  }
}

// ============================================================================
// Settings
// ============================================================================

export interface Settings {
  // Authentication
  readonly apiKeyHash: string | null
  readonly jwtSecret: string | null
  readonly guestPasswordHash: string | null
  readonly enableGuestLogin: boolean

  // User configuration
  readonly userName: string

  /** Raw comma-separated `PRIORITY_AGENTS` value; see {@link getPriorityAgentNames}. */
  readonly priorityAgents: string

  // CORS
  readonly frontendUrl: string | null
  readonly vercelUrl: string | null

  /** Basename of the guidelines YAML, without extension. */
  readonly guidelinesFile: string

  // Model / debug
  readonly useSonnet: boolean
  readonly debugAgents: boolean

  // Background scheduler
  readonly maxConcurrentRooms: number

  // CLI tracing
  readonly enableCliTracing: boolean
  readonly cliTraceOutput: string | null

  // Image pipeline (Python reads these ad hoc in utils/images.py)
  readonly imageWebpQuality: number
  readonly imageConvertToWebp: boolean

  /** Direct API key; when null the SDK falls back to Claude Code auth. */
  readonly claudeApiKey: string | null

  /**
   * Raw `DATABASE_URL`. Kept verbatim (including the SQLAlchemy driver prefix)
   * because translating it to a SQLite file path is the db layer's job.
   */
  readonly databaseUrl: string

  readonly paths: ProjectPaths
}

/** Python's `connection.py` default; unchanged so both backends agree. */
export const DEFAULT_DATABASE_URL = 'postgresql+asyncpg://postgres:postgres@localhost:5432/claudeworld'

/**
 * Build a Settings object from an explicit env map.
 *
 * Pure and side-effect free — no `.env` reading, no caching — so tests can
 * exercise parsing without the developer's real environment leaking in.
 */
export function createSettings(env: EnvRecord = process.env): Settings {
  const guidelinesFile = env.GUIDELINES_FILE || DEFAULT_GUIDELINES_FILE

  return {
    apiKeyHash: optional(env.API_KEY_HASH),
    jwtSecret: optional(env.JWT_SECRET),
    guestPasswordHash: optional(env.GUEST_PASSWORD_HASH),
    enableGuestLogin: parseBool(env.ENABLE_GUEST_LOGIN, true),

    userName: env.USER_NAME || 'User',
    priorityAgents: env.PRIORITY_AGENTS ?? '',

    frontendUrl: optional(env.FRONTEND_URL),
    vercelUrl: optional(env.VERCEL_URL),

    guidelinesFile,

    useSonnet: parseBool(env.USE_SONNET, false),
    debugAgents: parseBool(env.DEBUG_AGENTS, false),

    maxConcurrentRooms: parseInteger(env.MAX_CONCURRENT_ROOMS, 5),

    enableCliTracing: parseBool(env.ENABLE_CLI_TRACING, false),
    cliTraceOutput: optional(env.CLI_TRACE_OUTPUT),

    imageWebpQuality: parseInteger(env.IMAGE_WEBP_QUALITY, 85),
    imageConvertToWebp: parseBool(env.IMAGE_CONVERT_TO_WEBP, true),

    claudeApiKey: optional(env.CLAUDE_API_KEY),
    databaseUrl: env.DATABASE_URL || DEFAULT_DATABASE_URL,

    paths: createProjectPaths({ guidelinesFile, env }),
  }
}

let cachedSettings: Settings | null = null

/**
 * Settings singleton, resolved on first use.
 *
 * Mirrors Python's two-pass `get_settings()`: the root is discovered first so
 * that `<root>/.env` can be located, then the file's values are layered
 * *underneath* the process env.
 */
export function getSettings(): Settings {
  if (cachedSettings === null) {
    const projectRoot = resolveProjectRoot()
    const merged: EnvRecord = { ...loadDotEnv(projectRoot), ...process.env }
    cachedSettings = createSettings(merged)
  }
  return cachedSettings
}

/** Drop the singleton so the next {@link getSettings} re-reads the environment. */
export function resetSettings(): void {
  cachedSettings = null
}

// ============================================================================
// Derived accessors
// ============================================================================

/** Split `PRIORITY_AGENTS` into trimmed, non-empty agent names. */
export function getPriorityAgentNames(settings: Settings = getSettings()): string[] {
  if (!settings.priorityAgents) return []
  return settings.priorityAgents
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

/**
 * Whether guest login is enabled.
 *
 * `infrastructure/auth.py` re-reads `ENABLE_GUEST_LOGIN` directly and accepts
 * the wider `{1,true,yes,on}` set, so a `.env` saying `ENABLE_GUEST_LOGIN=1`
 * enables guests there while `settings.enableGuestLogin` reports false. This
 * function is the auth-path behaviour; prefer it over the raw field.
 */
export function isGuestLoginEnabled(
  env: EnvRecord = process.env,
  settings: Settings = getSettings(),
): boolean {
  const raw = env.ENABLE_GUEST_LOGIN
  if (raw !== undefined) {
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
  }
  return settings.enableGuestLogin
}

/** Allowed CORS origins: localhost, configured URLs, and this host's LAN IPs. */
export function getCorsOrigins(settings: Settings = getSettings()): string[] {
  const origins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
  ]

  if (settings.frontendUrl) origins.push(settings.frontendUrl)
  if (settings.vercelUrl) origins.push(`https://${settings.vercelUrl}`)

  // Python resolves the hostname via DNS and gets back a single address; here
  // we enumerate the interfaces directly, which is both synchronous and more
  // complete (a laptop on Wi-Fi + Ethernet gets both).
  try {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family !== 'IPv4' || address.internal) continue
        origins.push(`http://${address.address}:5173`, `http://${address.address}:5174`)
      }
    }
  } catch {
    // Matches Python's bare `except: pass` — CORS should never block startup.
  }

  return origins
}
