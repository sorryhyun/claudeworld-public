/**
 * Centralized application settings. Real process env wins over `.env` file
 * values, and `.env` is read from the *project root*, not from `backend/`.
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
import { getLogger } from '@/infrastructure/logging/logger'

const logger = getLogger('Settings')

export type EnvRecord = Record<string, string | undefined>

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

// Only the literal "true" is true — "1", "yes" and "on" are not. See
// {@link isGuestLoginEnabled} for the one place that accepts a wider set.
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
  // "" collapses to null so consumers do not have to test both.
  return raw === undefined || raw === '' ? null : raw
}

// `KEY=value`, optional `export ` prefix, `#` comments, single- or
// double-quoted values; escapes expand only inside double quotes.
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

// Makes {@link loadDotEnv} behave as if the file were absent. Set by the test
// preload: without it the suite depends on whatever `make setup` wrote, and
// diverges from CI, which has no `.env`.
export const SKIP_DOTENV_ENV_VAR = 'CW_TEST_NO_DOTENV'

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

export interface Settings {
  readonly apiKeyHash: string | null
  readonly jwtSecret: string | null
  readonly guestPasswordHash: string | null
  readonly enableGuestLogin: boolean

  readonly userName: string

  /** Raw comma-separated `PRIORITY_AGENTS` value; see {@link getPriorityAgentNames}. */
  readonly priorityAgents: string

  readonly frontendUrl: string | null
  readonly vercelUrl: string | null

  /** Basename of the guidelines YAML, without extension. */
  readonly guidelinesFile: string

  readonly useSonnet: boolean
  readonly debugAgents: boolean

  readonly maxConcurrentRooms: number

  readonly enableCliTracing: boolean
  readonly cliTraceOutput: string | null

  readonly imageWebpQuality: number
  readonly imageConvertToWebp: boolean

  /** Direct API key; when null the SDK falls back to Claude Code auth. */
  readonly claudeApiKey: string | null

  /** Raw `DATABASE_URL`; translating it to a SQLite path is the db layer's job. */
  readonly databaseUrl: string

  readonly paths: ProjectPaths
}

export const DEFAULT_DATABASE_URL = 'postgresql+asyncpg://postgres:postgres@localhost:5432/claudeworld'

// Pure — no `.env` reading, no caching — so tests can parse in isolation.
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

// A `$VAR` reference as Bun's own dotenv loader recognises it. Deliberately
// looser than a shell's: Bun expands `$2b` and `$12`, which a shell would not.
const BUN_ENV_REFERENCE = /\$\{[^}]*\}|\$[A-Za-z0-9_]+/g

/**
 * Undo Bun's `.env` expansion where it destroyed a value.
 *
 * Bun auto-loads `.env` **from the current directory** and expands `$VAR` inside
 * it, undefined variables becoming the empty string. A bcrypt hash is
 * `$2b$12$<salt><digest>`, so any run whose cwd is the directory holding the
 * `.env` — the standalone executable's install folder, or `bun
 * backend/src/main.ts` from the repo root — finds a *shredded* `API_KEY_HASH` in
 * `process.env`, and every login fails with "Invalid password". (`make dev` runs
 * from `backend/`, which has no `.env`, which is why this never showed up
 * there.) `parseDotEnv` reads the same file correctly.
 *
 * The repair is deliberately narrow: a file value is restored only when the
 * process value is *exactly* what Bun's expansion would have produced from it
 * with every reference undefined. A genuine shell override survives, because it
 * will not match that.
 */
export function restoreExpandedDotEnv(fileEnv: Record<string, string>, processEnv: EnvRecord): EnvRecord {
  const repaired: EnvRecord = {}
  for (const [key, fileValue] of Object.entries(fileEnv)) {
    if (!fileValue.includes('$')) continue
    const processValue = processEnv[key]
    if (processValue === undefined || processValue === fileValue) continue
    if (fileValue.replace(BUN_ENV_REFERENCE, '') === processValue) repaired[key] = fileValue
  }
  return repaired
}

// Three passes: find the root so `<root>/.env` can be read, layer its values
// *underneath* the process env, then put back the ones Bun's loader expanded on
// its way into that process env.
export function getSettings(): Settings {
  if (cachedSettings === null) {
    const projectRoot = resolveProjectRoot()
    const fileEnv = loadDotEnv(projectRoot)
    const repaired = restoreExpandedDotEnv(fileEnv, process.env)
    // Written back into `process.env`, not merely into the record below:
    // `auth/config.ts` layers the raw environment *over* these settings, so a
    // shredded `API_KEY_HASH` left in place there would win the repair.
    for (const [key, value] of Object.entries(repaired)) process.env[key] = value
    cachedSettings = createSettings({ ...fileEnv, ...process.env })
  }
  return cachedSettings
}

export function resetSettings(): void {
  cachedSettings = null
}

export function getPriorityAgentNames(settings: Settings = getSettings()): string[] {
  if (!settings.priorityAgents) return []
  return settings.priorityAgents
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

// Accepts the wider `{1,true,yes,on}` set than `settings.enableGuestLogin`
// does; prefer this over the raw field.
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

  // Interfaces, not DNS: synchronous, and Wi-Fi + Ethernet both get an entry.
  try {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family !== 'IPv4' || address.internal) continue
        origins.push(`http://${address.address}:5173`, `http://${address.address}:5174`)
      }
    }
  } catch {
    // CORS should never block startup.
  }

  return origins
}
