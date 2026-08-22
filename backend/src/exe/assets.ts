/**
 * What the single-file executable carries inside it, and how the running binary
 * gets at it again.
 *
 * `bun build --compile --asset <dir>` embeds a directory tree, keying each file
 * on its path *under that directory's own basename*: `--asset staging/frontend`
 * yields `frontend/index.html`, `frontend/assets/main-abc.js`. Those basenames
 * are the entire contract between `scripts/build/exe-bundle.ts` and this file,
 * which is why both read them from {@link EMBEDDED_ASSET_DIRS} instead of each
 * spelling them out.
 *
 * The two trees are handled differently on purpose:
 *
 * - **frontend** is served straight out of the binary. It is build output, the
 *   filenames are fingerprinted, and nobody edits it — unpacking it would only
 *   leave 13MB of stale hashed bundles behind after every upgrade.
 * - **seed** is unpacked next to the executable, because `agents/` and
 *   `config/` are the files the app *reads at runtime, hot-reloads
 *   on mtime, and lets the user edit*. The whole design (see
 *   `../../CLAUDE.md`, "Filesystem-Primary Architecture") is that those live on
 *   disk; embedding them read-only would break agent memory writes.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Directory basenames the build embeds under, and therefore the prefixes on
 * `Bun.embeddedFiles` names at runtime. Change one here and the build follows.
 */
export const EMBEDDED_ASSET_DIRS = {
  /** `frontend/dist` — the built SPA, served from inside the binary. */
  frontend: 'frontend',
  /** The user-editable data trees, unpacked beside the executable on startup. */
  seed: 'seed',
} as const

/**
 * Root of the executable's virtual filesystem.
 *
 * Everything compiled into the binary — this module included — reports the
 * mount as its `import.meta.dir`, and an embedded file's `name` is relative to
 * exactly that, so `` `${EMBEDDED_ROOT}/${name}` `` is a path `Bun.file()`
 * opens. Read off `import.meta.dir` with no POSIX literal beside it: the mount
 * is `/$bunfs/root` on Unix but `B:\~BUN\root` on Windows, and hardcoding
 * either is how a Windows binary ends up 404-ing its own frontend.
 */
const EMBEDDED_ROOT = import.meta.dir

/** Every embedded file under `prefix/`, keyed by the rest of its path. */
function embeddedUnder(prefix: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const file of Bun.embeddedFiles) {
    const name = (file as File).name
    if (!name.startsWith(`${prefix}/`)) continue
    out[name.slice(prefix.length + 1)] = `${EMBEDDED_ROOT}/${name}`
  }
  return out
}

/**
 * The embedded frontend as `{ '/index.html': <readable path> }`, or null when
 * nothing was embedded — which is every run outside the binary, since
 * `Bun.embeddedFiles` is empty there. Keys are rooted URL paths because that is
 * what the static middleware looks up.
 */
export function embeddedFrontend(): Record<string, string> | null {
  const files = embeddedUnder(EMBEDDED_ASSET_DIRS.frontend)
  const names = Object.keys(files)
  if (names.length === 0) return null

  const out: Record<string, string> = {}
  for (const name of names) out[`/${name}`] = files[name] as string
  return out
}

// ── The seed manifest ────────────────────────────────────────────────

/**
 * Records which seed files the binary wrote and what they contained. Without
 * it an upgrade has only two options, both wrong: overwrite everything (losing
 * the agents and prompts the user edited — the thing `install.sh` goes out of
 * its way to preserve) or overwrite nothing (pinning every install to the
 * prompts shipped by whichever release happened to be the first one).
 *
 * With it, a file whose current hash still matches what we last wrote is known
 * to be untouched and can be refreshed; anything else is the user's.
 */
const SEED_MANIFEST = '.claudeworld-seed.json'

export interface SeedManifest {
  version: string | null
  /** Relative path → sha256 of the content this binary's predecessor wrote. */
  files: Record<string, string>
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function readManifest(root: string): SeedManifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, SEED_MANIFEST), 'utf-8'))
    if (parsed && typeof parsed === 'object' && 'files' in parsed) {
      const files = (parsed as { files: unknown }).files
      if (files && typeof files === 'object') {
        return { version: null, files: files as Record<string, string> }
      }
    }
  } catch {
    // No manifest, or an unreadable one: treat every existing file as the
    // user's. Losing the ability to refresh is the safe direction to fail.
  }
  return { version: null, files: {} }
}

// Written through a temp file and renamed: a half-written manifest would claim
// hashes for files it does not describe, and the next upgrade would trust it.
function writeManifest(root: string, manifest: SeedManifest): void {
  const target = join(root, SEED_MANIFEST)
  const temp = `${target}.tmp.${process.pid}`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  renameSync(temp, target)
}

// ── Relocation ───────────────────────────────────────────────────────

/**
 * Seed data that changed location between releases.
 *
 * Everything here keys on paths relative to the install root — the files
 * {@link unpackSeed} writes, and the manifest entries recording them. A release
 * that renames a path therefore presents it with two unrelated things: an
 * unknown file nothing shipped (left beside the exe forever, in a directory no
 * loader reads) and a brand-new one (created from this release's copy). A user
 * who had edited the old file would keep it somewhere inert and silently get
 * the default prompts back.
 *
 * Moving the file *and* carrying its recorded hash to the new key closes that.
 * {@link decideSeedAction} then sees the user's copy at the new path with the
 * right `recorded` beside it and rules on it exactly as it would have if the
 * file had never moved.
 */
const SEED_MOVES: ReadonlyArray<{ from: string; to: string; directory: boolean }> = [
  // Earlier releases kept the prompt YAML inside the backend workspace, and
  // debug.yaml in a tree that held nothing else at all. Both are data.
  { from: 'backend/sdk/config', to: 'config', directory: true },
  { from: 'backend/infrastructure/logging/debug.yaml', to: 'config/debug.yaml', directory: false },
]

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of filesUnder(join(dir, entry.name))) out.push(`${entry.name}/${nested}`)
    } else {
      out.push(entry.name)
    }
  }
  return out
}

/** Drop `dir` and every parent the removal leaves empty, stopping above `root`. */
function pruneEmpty(dir: string, root: string): void {
  let current = dir
  while (current.startsWith(root) && current !== root) {
    // rmdir refuses a non-empty directory, which is exactly the stop condition.
    try {
      rmdirSync(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

/**
 * Apply {@link SEED_MOVES} to the install at `root`, adding the carried-over
 * hashes to `previous` in place. Returns the new paths, for the startup log.
 *
 * A move is skipped when the destination already exists: either the install has
 * been through this once, or the user put something there themselves. Stale
 * *old* manifest keys need no cleaning — {@link unpackSeed} rebuilds the
 * manifest from what this binary actually ships, so they simply stop being
 * written.
 */
export function relocateSeed(root: string, previous: SeedManifest): string[] {
  const moved: string[] = []

  for (const { from, to, directory } of SEED_MOVES) {
    const source = join(root, from)
    if (!existsSync(source)) continue

    for (const name of directory ? filesUnder(source) : [null]) {
      const oldPath = name === null ? from : `${from}/${name}`
      const newPath = name === null ? to : `${to}/${name}`
      const target = join(root, newPath)
      if (existsSync(target)) continue

      mkdirSync(dirname(target), { recursive: true })
      renameSync(join(root, oldPath), target)
      const recorded = previous.files[oldPath]
      if (recorded !== undefined) previous.files[newPath] = recorded
      moved.push(newPath)
    }

    pruneEmpty(directory ? source : dirname(source), root)
  }

  return moved
}

// ── Unpacking ────────────────────────────────────────────────────────

/** What {@link unpackSeed} does with one file, decided per file. */
export type SeedAction = 'create' | 'update' | 'preserve' | 'identical'

/**
 * The upgrade rule, isolated from the filesystem so it can be reasoned about.
 *
 * @param current  sha256 of the file on disk, or null when it is not there
 * @param recorded sha256 the manifest says this binary's predecessor wrote
 * @param shipped  sha256 of the copy inside this binary
 */
export function decideSeedAction(
  current: string | null,
  recorded: string | undefined,
  shipped: string,
): SeedAction {
  if (current === null) return 'create'
  if (current === shipped) return 'identical'
  // Untouched since we wrote it: safe to move to this release's copy.
  if (current === recorded) return 'update'
  // Edited, or older than the manifest. Either way it is the user's.
  return 'preserve'
}

export interface UnpackResult {
  /** Files carried over from a path an earlier release shipped them at. */
  readonly relocated: string[]
  /** Files created because they were not there at all. */
  readonly created: string[]
  /** Files replaced because they still matched what a previous run wrote. */
  readonly updated: string[]
  /** Files left alone because the user had changed them. */
  readonly preserved: string[]
}

/**
 * Materialise the seed tree under `root`, preserving user edits.
 *
 * A no-op outside the executable: `Bun.embeddedFiles` is empty in a repo run,
 * so there is nothing to unpack and nothing is written.
 *
 * @param version Stamped into the manifest; purely informational.
 */
export function unpackSeed(root: string, version: string | null = null): UnpackResult {
  const seeds = embeddedUnder(EMBEDDED_ASSET_DIRS.seed)
  const result: UnpackResult = { relocated: [], created: [], updated: [], preserved: [] }
  const names = Object.keys(seeds)
  if (names.length === 0) return result

  const previous = readManifest(root)
  // Before anything is compared: a file that moved has to be found where this
  // release looks for it, or every rule below misreads it as missing.
  result.relocated.push(...relocateSeed(root, previous))
  const next: SeedManifest = { version, files: {} }

  for (const name of names.sort()) {
    const embedded = readFileSync(seeds[name] as string)
    const hash = sha256(embedded)
    next.files[name] = hash

    const target = join(root, name)
    const current = existsSync(target) ? sha256(readFileSync(target)) : null

    switch (decideSeedAction(current, previous.files[name], hash)) {
      case 'create':
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, embedded)
        result.created.push(name)
        break
      case 'update':
        writeFileSync(target, embedded)
        result.updated.push(name)
        break
      case 'preserve':
        result.preserved.push(name)
        break
      case 'identical':
        break
    }
  }

  writeManifest(root, next)
  return result
}
