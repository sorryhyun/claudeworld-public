/**
 * First module of the standalone executable — the entry `bun build --compile`
 * is pointed at.
 *
 * Three things have to happen before any server module *loads*, not merely
 * before it runs, which is why `main.ts` is reached through a dynamic import at
 * the bottom: static imports are hoisted and evaluated first, so a statically
 * imported `main.ts` would pull in `config/settings.ts` — and with it the
 * project paths and the `.env` read — before the seed files or the `.env`
 * existed at all.
 *
 *   1. Unpack the seed data beside the binary, so `agents/` and
 *      `config/` are on disk where the loaders expect them.
 *   2. Run the `.env` wizard if this is a first launch.
 *   3. Start the server, and hold the process open on the signal handlers
 *      `main.ts` installs for itself under `bun run`.
 */

import { BUNDLED_VERSION } from '../config/bundled'
import { resolveProjectRoot } from '../config/paths'
import { ensureEnvConfigured } from '../scripts/setup-env'
import { unpackSeed } from './assets'

// `resolveProjectRoot` returns the executable's own directory here, so this is
// the folder the user dropped the binary in — .env, claudeworld.db, agents/ and
// worlds/ all live beside it, which is what makes an install portable and an
// upgrade a matter of replacing one file.
const projectRoot = resolveProjectRoot()

const seeded = unpackSeed(projectRoot, BUNDLED_VERSION)
if (seeded.relocated.length > 0) {
  console.log(`Moved ${seeded.relocated.length} file(s) to their new home under config/`)
}
if (seeded.created.length > 0) {
  console.log(`Unpacked ${seeded.created.length} file(s) into ${projectRoot}`)
}
if (seeded.updated.length > 0) {
  console.log(`Updated ${seeded.updated.length} unmodified file(s) to this release`)
}
if (seeded.preserved.length > 0) {
  console.log(`Kept your edits to ${seeded.preserved.length} file(s): ${seeded.preserved.join(', ')}`)
}

if (!(await ensureEnvConfigured(projectRoot))) {
  console.error('ClaudeWorld is not configured, and there is no console to ask on.')
  console.error(`Run this executable from a terminal once to set a password, or write ${projectRoot}/.env by hand.`)
  process.exit(1)
}

const { startServer } = await import('../main')
const { stop } = await startServer()

const shutdown = (): void => {
  void stop().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
