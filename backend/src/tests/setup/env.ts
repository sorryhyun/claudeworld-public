/**
 * Test preload, referenced by `bunfig.toml`.
 *
 * Pins the project root before any test module resolves paths, so the suite
 * reads the repo's real `agents/` and `config/` trees regardless of
 * the cwd `bun test` was invoked from.
 *
 * Also neutralises `<projectRoot>/.env`, so the suite gives the same answer on
 * a machine that has run `make setup` as on CI, which has no such file. See
 * `unloadDotEnvFromProcessEnv` below.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { resolveProjectRoot, PROJECT_ROOT_ENV_VAR } from '../../config/paths'
import { parseDotEnv, SKIP_DOTENV_ENV_VAR } from '../../config/settings'
import { setLogSink } from '../../infrastructure/logging/logger'

const projectRoot = resolveProjectRoot({})
process.env[PROJECT_ROOT_ENV_VAR] ??= projectRoot

/**
 * Make the suite run as if no `.env` existed.
 *
 * Most settings assertions go through `createSettings(env)` with an explicit
 * map, but a handful legitimately exercise the `getSettings()` singleton — and
 * that one resolves the developer's `.env`. Whether a run was green therefore
 * depended on whether `make setup` had been run and on what it wrote: a `.env`
 * carrying `GUIDELINES_FILE=…` repoints `paths.guidelinesConfigPath` at a YAML
 * that does not exist and takes six tests down, on a commit that is green on
 * CI, which never has a `.env`. The absent case is the one CI and a fresh clone
 * see, so it is the one pinned here; a test wanting specific settings passes
 * them in.
 *
 * `.env` reaches the process through two independent doors and both have to be
 * shut:
 *
 * 1. `loadDotEnv()` reads `<projectRoot>/.env` itself, from any cwd. The knob
 *    below turns that read into a no-op.
 * 2. **Bun auto-loads `.env` from the current directory** into `process.env`
 *    before any of our code runs — which is also why the same commit behaved
 *    differently depending on where `bun test` was launched from: the root run
 *    picked the file up, a run from `backend/` did not. There is no flag to
 *    switch that off from `bunfig.toml`, so the entries are removed again
 *    below, matched by value so a variable genuinely exported in the shell
 *    survives.
 */
process.env[SKIP_DOTENV_ENV_VAR] ??= '1'

function unloadDotEnvFromProcessEnv(): void {
  for (const dir of new Set([projectRoot, process.cwd()])) {
    const path = join(dir, '.env')
    if (!existsSync(path)) continue

    let entries: Record<string, string>
    try {
      entries = parseDotEnv(readFileSync(path, 'utf-8'))
    } catch {
      continue // unreadable — nothing was auto-loaded from it either
    }

    for (const [key, value] of Object.entries(entries)) {
      if (process.env[key] === value) delete process.env[key]
    }
  }
}

unloadDotEnvFromProcessEnv()

/**
 * Point `os.tmpdir()` at a RAM-backed filesystem for the duration of the run.
 *
 * Nearly every suite here builds a real SQLite database under `mkdtempSync(join(
 * tmpdir(), …))` in `beforeEach`, and SQLite fsyncs at each statement boundary
 * while creating a schema. On a disk-backed `/tmp` that is ~10ms per fsync and
 * ~40 fsyncs per fixture database, so the schema DDL alone cost ~430ms *per
 * test* — `game-routes.test.ts` spent 25s of its 26s waiting on the disk with
 * the CPU idle. On tmpfs the fsync is a no-op and the same file runs in under a
 * second.
 *
 * This is a pure I/O substitution: the tests still create the same files with
 * the same code, so nothing about what they assert changes. Where there is no
 * tmpfs (macOS, Windows) the default temp directory is left alone rather than
 * guessed at.
 *
 * Set `CW_TEST_NO_TMPFS=1` to opt out — useful when a test is suspected of
 * depending on real disk behaviour, or when `/dev/shm` is too small for it.
 */
function useTmpfsForTempFiles(): void {
  if (process.env.CW_TEST_NO_TMPFS) return
  if (process.env.TMPDIR) return // an explicit choice by the developer wins
  if (!existsSync('/dev/shm')) return

  let root: string
  try {
    root = mkdtempSync(join('/dev/shm', 'claudeworld-tests-'))
  } catch {
    return // read-only, full, or otherwise unusable — the disk still works
  }

  process.env.TMPDIR = root
  // Suites remove their own temp trees; this is the run-scoped parent, which
  // would otherwise sit in RAM until reboot.
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
}

useTmpfsForTempFiles()

/**
 * Discard log output.
 *
 * Much of the suite exercises failure paths on purpose — a malformed bcrypt
 * hash, an expired token, a missing config file — and each one logs at ERROR.
 * Left on, the real output is buried in expected errors and a genuinely
 * unexpected one stops standing out. Tests that care about log output install
 * their own sink with `setLogSink`, which returns a restore function.
 */
setLogSink(() => {})
