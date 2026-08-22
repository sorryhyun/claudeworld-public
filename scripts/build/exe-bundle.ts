#!/usr/bin/env bun
/**
 * Build the standalone ClaudeWorld executable.
 *
 *     bun scripts/build/exe-bundle.ts --target windows
 *     bun scripts/build/exe-bundle.ts --target linux --arch arm64
 *
 * One file, no runtime, no Python: `bun build --compile` links the backend, the
 * built frontend and the seed data trees into a single binary. What it *cannot*
 * carry is the `claude` CLI — that is a ~330MB native binary per platform — so
 * the exe uses whatever Claude Code the user has installed. See
 * `backend/src/sdk/client/cli-path.ts`.
 *
 * The two embedded trees are described in `backend/src/exe/assets.ts`; this
 * script's only job is to stage them under the basenames that file expects,
 * because `--asset <path>` names its entries after `basename(path)` and the
 * source directories are named the wrong things (`dist`, `config`).
 *
 * Symlink for the frontend — `--asset` follows one handed to it directly — and
 * real copies for the seed tree, which has to nest (`--asset` does *not* follow
 * a symlink it meets while walking a directory, and the whole seed tree is a
 * quarter of a megabyte).
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { EMBEDDED_ASSET_DIRS } from '../../backend/src/exe/assets'

const rootDir = join(import.meta.dir, '..', '..')

// ── Arguments ────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getArg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index === -1 || index + 1 >= args.length ? undefined : args[index + 1]
}

const target = getArg('target') ?? 'linux'
const arch = getArg('arch') ?? 'x64'

const BUN_TARGETS: Record<string, string> = {
  'windows-x64': 'bun-windows-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'macos-x64': 'bun-darwin-x64',
  'macos-arm64': 'bun-darwin-arm64',
}

const key = `${target}-${arch}`
const bunTarget = BUN_TARGETS[key]
if (!bunTarget) {
  console.error(`Unknown target/arch "${key}". Valid: ${Object.keys(BUN_TARGETS).join(', ')}`)
  process.exit(1)
}

const outfile = join(rootDir, 'dist', target === 'windows' ? 'ClaudeWorld.exe' : 'claudeworld')

// ── What goes in ─────────────────────────────────────────────────────

/**
 * Every file the running app reads off disk that is not written by the user.
 * Sources are repo-relative; destinations are relative to the directory the
 * binary is run from, which is what `resolveProjectRoot()` returns there — so
 * the layout beside the exe mirrors the repository, and every path in
 * `config/paths.ts` resolves without a single special case.
 */
const SEED_ENTRIES: ReadonlyArray<{ from: string; to: string }> = [
  // Character definitions and their memory files. Written to at runtime.
  { from: 'agents', to: 'agents' },
  // Prompt YAML — hot-reloaded on mtime, and meant to be edited.
  { from: 'config', to: 'config' },
  // `readMigrationFiles` reads these off the real filesystem; see
  // `db/migrate.ts#migrationsFolder`.
  { from: 'backend/drizzle', to: 'backend/drizzle' },
  // `/readme?lang=` serves these from the project root.
  { from: 'docs/en_readme.md', to: 'en_readme.md' },
  { from: 'docs/ko_readme.md', to: 'ko_readme.md' },
  { from: 'docs/jp_readme.md', to: 'jp_readme.md' },
]

function countFiles(dir: string): number {
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1
  }
  return n
}

const frontendDist = join(rootDir, 'frontend', 'dist')
if (!existsSync(join(frontendDist, 'index.html'))) {
  console.error(`No built frontend at ${frontendDist} — run "bun run build" first.`)
  process.exit(1)
}
console.log(`Embedding ${countFiles(frontendDist)} frontend files...`)

// ── Stage ────────────────────────────────────────────────────────────

const stagingDir = join(rootDir, 'dist', '.exe-assets')
rmSync(stagingDir, { recursive: true, force: true })
mkdirSync(stagingDir, { recursive: true })

const frontendLink = join(stagingDir, EMBEDDED_ASSET_DIRS.frontend)
symlinkSync(frontendDist, frontendLink, 'dir')

const seedDir = join(stagingDir, EMBEDDED_ASSET_DIRS.seed)
for (const { from, to } of SEED_ENTRIES) {
  const source = join(rootDir, from)
  if (!existsSync(source)) {
    // A missing seed source is a binary that boots and then fails on its first
    // turn with a missing agent config — fail here, where the cause is visible.
    console.error(`Seed source missing: ${from}`)
    process.exit(1)
  }
  const destination = join(seedDir, to)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true })
}
console.log(`Embedding ${countFiles(seedDir)} seed files...`)

// ── Build ────────────────────────────────────────────────────────────

// The binary has to carry its own version string: beside the exe there is no
// package.json to read, since the project root there is wherever the user put it.
const version = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')).version as string

const buildArgs = [
  'build',
  relative(rootDir, join(rootDir, 'backend', 'src', 'exe', 'entry.ts')),
  '--compile',
  `--target=${bunTarget}`,
  `--outfile=${relative(rootDir, outfile)}`,
  '--asset',
  relative(rootDir, frontendLink),
  '--asset',
  relative(rootDir, seedDir),
  // argv rather than a shell string: the version define's value is a *JS string
  // literal*, quotes included, and sh and cmd.exe would each strip them
  // differently.
  '--define',
  '__CLAUDEWORLD_BUNDLED=true',
  '--define',
  `__CLAUDEWORLD_VERSION=${JSON.stringify(version)}`,
]

console.log(`Building ${key} → ${relative(rootDir, outfile)}`)

try {
  execFileSync('bun', buildArgs, { cwd: rootDir, stdio: 'inherit' })
} finally {
  // Leaving it would put a symlink to frontend/dist inside dist/, which the
  // release step archives.
  rmSync(stagingDir, { recursive: true, force: true })
}

const size = Bun.file(outfile).size
console.log(`\nBuilt ${relative(rootDir, outfile)} (${(size / 1024 / 1024).toFixed(1)} MB)`)
