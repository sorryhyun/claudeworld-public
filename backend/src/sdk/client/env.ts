import { mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Environment for the spawned Claude Code CLI. The SDK's `env` option
 * **replaces** the subprocess environment rather than merging into it: passing
 * only the overrides strips `PATH`, `HOME` and the auth variables, and the CLI
 * fails to start with nothing useful on stderr. Hence `process.env` first, and
 * every caller through this helper rather than an inline env object.
 */

const CLAUDE_ENV_OVERRIDES: Record<string, string> = {
  CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK: 'true',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'true',
  DISABLE_TELEMETRY: 'true',
  CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK: 'true',
  // Suppresses the CLI's stock sub-agents so `Task` only sees ours.
  CLAUDE_CODE_DISABLE_BUILTIN_AGENTS: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: 'true',
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  // Produces the `input_json_delta` events the narration extractor consumes.
  // Without it, narration cannot stream before the tool call completes.
  CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: 'true',
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
  // A floor under the stateless 2026-07-28 MCP revision `sdk/mcp/` serves;
  // neither works alone. Load-bearing because the endpoint runs
  // `legacy: 'reject'`, so a CLI landing on the 2025-era `initialize` loses every
  // tool at once. Undocumented gates in an unpinned binary: if `Refused legacy
  // protocol era` shows up after an SDK bump, look here first.
  MCP_SDK_GENERATION: 'v2',
  MCP_PROTOCOL_NEGOTIATION: 'auto',
  // Over HTTP the CLI otherwise aborts each tool call at 60s. 120s matches the
  // turn's `STREAMING_IDLE_TIMEOUT_MS`, so a wedged tool and a wedged turn give
  // up at the same point rather than one masking the other.
  MCP_TOOL_TIMEOUT: '120000',
}

/** Enabled only when ENABLE_CLI_TRACING is set; requires a patched CLI. */
const CLI_TRACING_ENV: Record<string, string> = {
  CCDECOMP_PHASE_TRACE: '1',
  CCDECOMP_PHASE_TRACE_FORMAT: 'jsonl',
  CCDECOMP_TELEMETRY_TRACE: '1',
  CCDECOMP_TELEMETRY_DRY_RUN: '1',
  CCDECOMP_TELEMETRY_TRACE_FORMAT: 'jsonl',
}

/**
 * Scrubbed so the child does not inherit the parent harness's identity. The
 * FD-based auth ones are the dangerous set — the descriptor numbers are
 * meaningless in the child and the CLI exits non-zero instead of falling back to
 * its own credentials — which is what makes nested execution work at all.
 */
const PARENT_HARNESS_ENV_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CONTAINER_ID',
  'CLAUDE_CODE_REMOTE',
  'CLAUDECODE',
] as const

export function buildClaudeEnv(options: { cliTracing?: boolean } = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of PARENT_HARNESS_ENV_VARS) delete env[key]
  Object.assign(env, CLAUDE_ENV_OVERRIDES)
  if (options.cliTracing) Object.assign(env, CLI_TRACING_ENV)
  return env
}

let claudeCwd: string | null = null

/** A deliberately empty cwd: the CLI treats its cwd as a project root and reads
 * files it finds there, and agents playing characters have no business seeing the
 * repository. Re-created if something removes it mid-process. */
export function getClaudeCwd(): string {
  if (claudeCwd === null || !existsSync(claudeCwd)) {
    claudeCwd = join(tmpdir(), 'claude-empty')
    mkdirSync(claudeCwd, { recursive: true })
  }
  return claudeCwd
}
