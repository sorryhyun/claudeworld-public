/**
 * Test preload, referenced by `bunfig.toml`.
 *
 * Pins the project root before any test module resolves paths, so the suite
 * reads the repo's real `agents/` and `backend/sdk/config/` trees regardless of
 * the cwd `bun test` was invoked from.
 *
 * Nothing else is stubbed here on purpose: settings parsing is exercised
 * through `createSettings(env)` with an explicit env map, so the developer's
 * own `.env` cannot leak into assertions.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { resolveProjectRoot, PROJECT_ROOT_ENV_VAR } from '../../config/paths'
import { setLogSink } from '../../infrastructure/logging/logger'

process.env[PROJECT_ROOT_ENV_VAR] ??= resolveProjectRoot({})

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
