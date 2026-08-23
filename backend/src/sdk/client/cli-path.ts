/**
 * Locating the `claude` binary the SDK spawns.
 *
 * A repo run needs none of this: the SDK resolves its own platform package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`) out of `node_modules`,
 * and that copy is version-matched to the pinned SDK — which is exactly what
 * `bun run spike` asserts against. Leave it alone there.
 *
 * The compiled executable has no `node_modules` to resolve, and the binary in
 * question is ~330MB, so embedding it is not on the table either (that is *per
 * platform*, against a 60MB exe). The binary therefore uses whatever Claude Code
 * the user already has installed, and `install.ps1` / `install.sh` are what
 * check for it. `CLAUDE_CODE_PATH` overrides in both shapes, for the case where
 * it is installed somewhere none of this looks.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { IS_BUNDLED_EXE } from '@/config/bundled'

/** Env var naming the binary outright. Honoured in every run shape. */
export const CLAUDE_CODE_PATH_ENV_VAR = 'CLAUDE_CODE_PATH'

function candidates(env: Record<string, string | undefined>, execDir: string): string[] {
  // No extension on Windows would be spawned as a script by the SDK's
  // `isNativeBinary` check, which keys off exactly this suffix.
  const ext = process.platform === 'win32' ? '.exe' : ''
  const out: string[] = []

  // Beside the executable first: an install that ships its own copy means it,
  // and a machine-wide one on PATH must not silently win over it.
  if (execDir) out.push(join(execDir, `claude${ext}`))

  // Where the official Claude Code installer puts it, on every platform.
  const home = env.USERPROFILE || env.HOME
  if (home) out.push(join(home, '.local', 'bin', `claude${ext}`))

  return out
}

/**
 * Absolute path to the `claude` binary, or null to let the SDK resolve its own.
 *
 * @param env Read rather than assumed, so a test can drive it.
 * @param execDir Directory of the running executable; `''` skips that candidate.
 */
export function resolveClaudeExecutable(
  env: Record<string, string | undefined> = process.env,
  execDir: string = IS_BUNDLED_EXE ? dirname(process.execPath) : '',
): string | null {
  const override = env[CLAUDE_CODE_PATH_ENV_VAR]?.trim()
  if (override) return existsSync(override) ? override : null

  // Outside the binary the SDK's own copy is the right one — and the only one
  // guaranteed to match the pinned version.
  if (!IS_BUNDLED_EXE) return null

  for (const candidate of candidates(env, execDir)) {
    if (existsSync(candidate)) return candidate
  }

  // Last: whatever `claude` PATH resolves to. `Bun.which` returns the real
  // binary, not a shell alias, so the SDK can spawn it directly.
  return Bun.which('claude')
}
