/**
 * Port of `backend/tests/unit/test_locking.py`.
 *
 * The Python tests are mostly about its platform-compatibility layer (does
 * `msvcrt` exist, does a Windows read skip the lock). Those have no counterpart
 * here. What carries over is the part that was ever the actual guarantee: a
 * reader never observes a half-written file, a failed write leaves the original
 * alone, and a crash cannot leave a temp file that matches the config globs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { atomicWrite, safeAppendLine, safeReadFile, withFileLock } from '../infrastructure/locking'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cw-locking-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('safeReadFile', () => {
  test('reads real content', () => {
    const path = join(workDir, 'notes.md')
    writeFileSync(path, 'hello')

    expect(safeReadFile(path)).toBe('hello')
  })

  test('distinguishes a missing file from an empty one', () => {
    const missing = join(workDir, 'absent.md')
    const empty = join(workDir, 'empty.md')
    writeFileSync(empty, '')

    expect(safeReadFile(missing)).toBeNull()
    expect(safeReadFile(empty)).toBe('')
  })

  test('an unreadable file raises instead of reporting empty content', () => {
    const path = join(workDir, 'secret.md')
    writeFileSync(path, 'content')
    chmodSync(path, 0o000)

    try {
      expect(() => safeReadFile(path)).toThrow()
    } finally {
      chmodSync(path, 0o644)
    }
  })
})

describe('atomicWrite', () => {
  test('replaces the file contents', () => {
    const path = join(workDir, 'config.yaml')
    writeFileSync(path, 'old')

    atomicWrite(path, 'new')

    expect(readFileSync(path, 'utf-8')).toBe('new')
  })

  test('creates parent directories', () => {
    const path = join(workDir, 'agents', 'frieren', 'recent_events.md')

    atomicWrite(path, 'entry')

    expect(readFileSync(path, 'utf-8')).toBe('entry')
  })

  test('leaves no temp file behind on success', () => {
    const path = join(workDir, 'config.yaml')
    atomicWrite(path, 'content')

    expect(readdirSync(workDir)).toEqual(['config.yaml'])
  })

  test('replaces the file rather than truncating it in place', () => {
    // The property locking cannot provide: `open(path, 'w')` truncates before
    // any lock could be taken, so a concurrent reader would see an empty file.
    // A changed inode is the observable evidence that the new content arrived
    // via rename — the old file was never opened for writing at all.
    const path = join(workDir, 'config.yaml')
    writeFileSync(path, 'original')
    const before = statSync(path).ino

    atomicWrite(path, 'replacement')

    expect(statSync(path).ino).not.toBe(before)
    expect(readFileSync(path, 'utf-8')).toBe('replacement')
  })

  test('a failed write leaves the original intact and no temp file', () => {
    const path = join(workDir, 'config.yaml')
    writeFileSync(path, 'original')

    expect(() => {
      atomicWrite(path, undefined as unknown as string)
    }).toThrow()

    expect(readFileSync(path, 'utf-8')).toBe('original')
    expect(readdirSync(workDir)).toEqual(['config.yaml'])
  })

  test('preserves the existing permissions', () => {
    const path = join(workDir, 'config.yaml')
    writeFileSync(path, 'original')
    chmodSync(path, 0o640)

    atomicWrite(path, 'replacement')

    expect(statSync(path).mode & 0o777).toBe(0o640)
  })

  test('a new file is not left world-readable by accident', () => {
    const path = join(workDir, 'fresh.yaml')

    atomicWrite(path, 'content')

    // mkstemp-equivalent semantics: 0600 when there is no existing mode to keep.
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('safeAppendLine', () => {
  test('adds the trailing newline when the caller omits it', () => {
    const path = join(workDir, 'recent_events.md')

    expect(safeAppendLine(path, '- [Day 1, 09:00] woke up')).toBe(true)
    expect(safeAppendLine(path, '- [Day 1, 10:00] left\n')).toBe(true)

    expect(readFileSync(path, 'utf-8')).toBe(
      '- [Day 1, 09:00] woke up\n- [Day 1, 10:00] left\n',
    )
  })

  test('creates the file and its parent directory', () => {
    const path = join(workDir, 'agents', 'frieren', 'recent_events.md')

    expect(safeAppendLine(path, 'first')).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('first\n')
  })

  test('reports failure rather than throwing', () => {
    // A directory where a file should be: the append cannot succeed, and the
    // tool handler that calls this treats it as a soft failure.
    const path = join(workDir, 'a-directory')
    atomicWrite(join(path, 'child'), 'x')

    expect(safeAppendLine(path, 'line')).toBe(false)
  })

  test('concurrent appenders all land', async () => {
    const path = join(workDir, 'recent_events.md')
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)

    await Promise.all(lines.map(async (line) => safeAppendLine(path, line)))

    const written = readFileSync(path, 'utf-8').trimEnd().split('\n')
    expect(written.sort()).toEqual([...lines].sort())
  })
})

describe('withFileLock', () => {
  test('runs the callback and returns its value', async () => {
    const path = join(workDir, 'target.md')
    writeFileSync(path, 'content')

    expect(await withFileLock(path, () => 'result')).toBe('result')
  })

  test('creates the target so a lock can be taken on a file that does not exist yet', async () => {
    const path = join(workDir, 'not-yet.md')

    await withFileLock(path, () => undefined)

    expect(existsSync(path)).toBe(true)
  })

  test('serialises read-modify-write sequences', async () => {
    const path = join(workDir, 'counter.txt')
    writeFileSync(path, '0')

    const increment = () =>
      withFileLock(path, async () => {
        const current = Number(readFileSync(path, 'utf-8'))
        // Yield inside the critical section: without the lock, every caller
        // would read the same value here and the writes would collapse.
        await Bun.sleep(1)
        writeFileSync(path, String(current + 1))
      })

    await Promise.all([increment(), increment(), increment(), increment(), increment()])

    expect(readFileSync(path, 'utf-8')).toBe('5')
  })

  test('releases the lock when the callback throws', async () => {
    const path = join(workDir, 'target.md')
    writeFileSync(path, 'content')

    await expect(
      withFileLock(path, () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // A leaked lock would make this hang until the stale timeout.
    expect(await withFileLock(path, () => 'ok')).toBe('ok')
  })
})
