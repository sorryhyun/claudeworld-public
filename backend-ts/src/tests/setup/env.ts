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

process.env[PROJECT_ROOT_ENV_VAR] ??= resolveProjectRoot({})
