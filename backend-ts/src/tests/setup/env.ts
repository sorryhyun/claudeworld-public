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

import { resolveProjectRoot, PROJECT_ROOT_ENV_VAR } from '../../config/paths'
import { setLogSink } from '../../infrastructure/logging/logger'

process.env[PROJECT_ROOT_ENV_VAR] ??= resolveProjectRoot({})

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
