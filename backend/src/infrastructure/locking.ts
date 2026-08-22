/**
 * Safe concurrent writes to the filesystem-primary config tree: two agents
 * writing `recent_events.md` at once must not corrupt it, and a reader must
 * never observe a half-written file. Locking is not what provides that. These
 * two properties are:
 *
 * - **Truncating writes are atomic.** Content goes to a temp file in the same
 *   directory which then *replaces* the target, so a reader sees the old file or
 *   the new one, never an empty one. A lock cannot provide this, because opening
 *   a file for writing truncates it before any lock can be taken.
 * - **Appends are atomic.** `O_APPEND` makes the seek-and-write one kernel
 *   operation, so two appenders interleave between lines, never within one.
 *
 * `proper-lockfile` covers what is left: read-modify-write sequences, where a
 * caller must exclude other *processes* across several operations. It is
 * advisory and directory-based (`<path>.lock`), not `flock`.
 */

import { constants } from 'node:fs'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, basename } from 'node:path'

import lockfile from 'proper-lockfile'

import { getLogger } from './logging/logger'

const logger = getLogger('FileLocking')

function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath)
  if (parent) mkdirSync(parent, { recursive: true })
}

/**
 * Write `content` to `filePath` atomically. The temp file takes a `.tmp` suffix
 * rather than the target's extension, because these directories are scanned
 * with `*.md`/`*.yaml` globs and a temp file left by a crash must not match. It
 * is unlinked on failure, so a throwing write leaves the original untouched.
 */
export function atomicWrite(filePath: string, content: string): void {
  ensureParentDir(filePath)

  const directory = dirname(filePath) || '.'
  const tempPath = join(
    directory,
    `.${basename(filePath)}-${process.pid.toString(36)}${Date.now().toString(36)}.tmp`,
  )

  let fd: number | null = null
  try {
    // 'wx' fails rather than clobbering, so two writers cannot pick the same
    // temp path and hand each other half a file.
    fd = openSync(tempPath, 'wx', 0o600)
    writeSync(fd, content, null, 'utf-8')
    // fsync before rename: rename is atomic with respect to *visibility*, not
    // durability. Without this a crash can leave the entry pointing at a file
    // whose contents never reached disk.
    fsyncSync(fd)
    closeSync(fd)
    fd = null

    // mkstemp-equivalent creates 0600; keep whatever the target already had.
    try {
      chmodSync(tempPath, statSync(filePath).mode & 0o777)
    } catch {
      // New file — 0600 is a fine default.
    }

    renameSync(tempPath, filePath)
    logger.debug(`Atomically wrote ${filePath}`)
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Already closed or never opened cleanly; the unlink below is what matters.
      }
    }
    try {
      unlinkSync(tempPath)
    } catch {
      // Never created, or already gone.
    }
    throw error
  }
}

/** Adds the trailing newline if omitted. Reports failure rather than throwing:
 * the tool-handler path treats a failed memory write as soft. */
export function safeAppendLine(filePath: string, line: string): boolean {
  try {
    ensureParentDir(filePath)
    appendFileSync(filePath, line.endsWith('\n') ? line : `${line}\n`, 'utf-8')
    return true
  } catch (error) {
    logger.error(`Error appending to ${filePath}: ${String(error)}`)
    return false
  }
}

/** Distinguishes "missing" (null) from "empty" (`''`); unreadable throws. Agent
 * config files are optional, so an absent one is normal and a broken one is a
 * bug worth surfacing. */
export function safeReadFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  return readFileSync(filePath, 'utf-8')
}

export interface FileLockOptions {
  /** Total time to keep retrying before giving up. Default 5s. */
  timeoutMs?: number
  /**
   * Treat a lock that cannot be acquired as a warning and run anyway — on
   * filesystems that refuse locking (older NFS, some FUSE mounts) a missing
   * lock is better than a failed read.
   */
  proceedUnlocked?: boolean
}

/**
 * Run `fn` holding an exclusive advisory lock on `filePath`. For
 * read-modify-write sequences only — a plain append or whole-file rewrite is
 * already atomic and needs no lock. The file is created if absent, because
 * `proper-lockfile` resolves the target before locking.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T> | T,
  { timeoutMs = 5000, proceedUnlocked = true }: FileLockOptions = {},
): Promise<T> {
  ensureParentDir(filePath)
  if (!existsSync(filePath)) {
    try {
      closeSync(openSync(filePath, constants.O_CREAT | constants.O_RDWR, 0o644))
    } catch {
      // Racing creator won; the lock below still works.
    }
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(filePath, {
      // Stale locks from a killed process must not wedge the server forever.
      stale: Math.max(timeoutMs * 2, 10_000),
      retries: { retries: 10, minTimeout: 20, maxTimeout: Math.max(timeoutMs / 4, 100) },
    })
  } catch (error) {
    if (!proceedUnlocked) throw error
    logger.warning(`Could not lock ${filePath}, proceeding unlocked: ${String(error)}`)
  }

  try {
    return await fn()
  } finally {
    if (release) {
      try {
        await release()
      } catch (error) {
        logger.warning(`Error releasing file lock on ${filePath}: ${String(error)}`)
      }
    }
  }
}
