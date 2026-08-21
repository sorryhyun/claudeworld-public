import { mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Environment for the spawned Claude Code CLI.
 *
 * The TS SDK's `env` option **replaces** the subprocess environment rather than
 * merging into it — unlike the Python SDK, which merges. Passing only the
 * overrides would strip `PATH`, `HOME` and the auth variables and the CLI would
 * fail to start with nothing useful on stderr, so `process.env` is spread first.
 * This is the single most likely mechanical translation error in the migration,
 * which is why every caller goes through this helper instead of building an env
 * object inline.
 */

/** Overrides ported verbatim from `sdk/agent/options_builder.py`. */
const CLAUDE_ENV_OVERRIDES: Record<string, string> = {
  CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK: 'true',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'true',
  DISABLE_TELEMETRY: 'true',
  CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK: 'true',
  // Suppresses the CLI's stock sub-agents so `Task` only sees the definitions
  // this backend supplies.
  CLAUDE_CODE_DISABLE_BUILTIN_AGENTS: 'true',
  // Produces the `input_json_delta` events the narration extractor consumes.
  // Without it, narration cannot stream before the tool call completes.
  CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: 'true',
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
 * Variables that mean "you are running inside a Claude Code harness".
 *
 * Development happens inside Claude Code, so the parent's values are present in
 * `process.env` and would be inherited by the child. The FD-based auth ones are
 * the dangerous set: the descriptor numbers are meaningless in the child, and
 * the CLI exits non-zero rather than falling back to its own credentials.
 * yaar hit this and the scrub is what makes nested execution work at all.
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

/**
 * A deliberately empty working directory for the CLI.
 *
 * The CLI treats its cwd as a project root and will read files it finds there.
 * These agents are playing characters in a game and have no business seeing the
 * repository, so they get an empty scratch directory. Re-created if something
 * removes it mid-process, matching `_get_claude_cwd()` in Python.
 */
export function getClaudeCwd(): string {
  if (claudeCwd === null || !existsSync(claudeCwd)) {
    claudeCwd = join(tmpdir(), 'claude-empty')
    mkdirSync(claudeCwd, { recursive: true })
  }
  return claudeCwd
}
