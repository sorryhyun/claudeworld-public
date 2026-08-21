/**
 * Filesystem layout of the ClaudeWorld project.
 *
 * Ported from `backend/core/settings.py` (the `project_root` / `backend_dir` /
 * `*_config_path` properties).
 *
 * Two deliberate divergences from the Python original:
 *
 * 1. Python branches on `sys.frozen` / `sys._MEIPASS` because PyInstaller
 *    unpacks the bundle into a temp dir at runtime. Bun has no equivalent —
 *    a compiled `bun build --compile` binary embeds modules, not the `agents/`
 *    and `backend/sdk/config/` trees, which are *user-editable data* here
 *    (hot-reloaded on every agent response). So instead of detecting a frozen
 *    mode we take an explicit override, `CLAUDEWORLD_ROOT`, and otherwise
 *    discover the root by walking up from this module.
 *
 * 2. `backendDir` still points at the *Python* tree (`<root>/backend`), not at
 *    `backend-ts`. The YAML config files (`guidelines_3rd.yaml`,
 *    `localization.yaml`, …) are not being moved as part of the port, and both
 *    backends must read the same files or prompts silently diverge.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Env var that pins the project root, bypassing directory discovery. */
export const PROJECT_ROOT_ENV_VAR = 'CLAUDEWORLD_ROOT'

/** Default value of the `GUIDELINES_FILE` setting (basename, no extension). */
export const DEFAULT_GUIDELINES_FILE = 'guidelines_3rd'

export interface ProjectPaths {
  /** Repository root — the directory holding `agents/`, `backend/`, `worlds/`. */
  readonly projectRoot: string
  /** The *Python* backend package, source of the YAML config tree. */
  readonly backendDir: string
  /** Agent definition folders (`agents/<name>/`, `agents/group_<g>/<name>/`). */
  readonly agentsDir: string
  /** User-created world data. */
  readonly worldsDir: string
  /** `backend/sdk/config` — the SDK YAML config directory. */
  readonly configDir: string
  /** `<configDir>/<guidelinesFile>.yaml` */
  readonly guidelinesConfigPath: string
  /** `<configDir>/localization.yaml` */
  readonly localizationConfigPath: string
  /** `<configDir>/lore_guidelines.yaml` */
  readonly loreGuidelinesConfigPath: string
  /** `<configDir>/conversation_context.yaml` */
  readonly conversationContextConfigPath: string
  /** `backend/infrastructure/logging/debug.yaml` — note: *not* under configDir. */
  readonly debugConfigPath: string
}

/** Marker entries that identify the repository root during discovery. */
const ROOT_MARKERS = ['agents', 'backend'] as const

function looksLikeProjectRoot(candidate: string): boolean {
  return ROOT_MARKERS.every((marker) => existsSync(join(candidate, marker)))
}

/**
 * Locate the project root.
 *
 * Order: `CLAUDEWORLD_ROOT` → walk up from this module looking for a directory
 * that contains both `agents/` and `backend/` → `<backend-ts>/..`.
 *
 * The walk is what makes `bun test` work from any cwd; the env var is what
 * makes a relocated/installed deployment work, where this file may sit outside
 * the repo entirely.
 */
export function resolveProjectRoot(env: Record<string, string | undefined> = process.env): string {
  const override = env[PROJECT_ROOT_ENV_VAR]
  if (override) return resolve(override)

  let current = import.meta.dir
  // Bounded by reaching the filesystem root, where dirname() is a fixed point.
  for (;;) {
    if (looksLikeProjectRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  // src/config/ -> src/ -> backend-ts/ -> repo root
  return resolve(import.meta.dir, '..', '..', '..')
}

export interface CreateProjectPathsOptions {
  /** Explicit root; skips discovery. */
  projectRoot?: string
  /** Basename of the guidelines YAML, without extension. */
  guidelinesFile?: string
  /** Env used for root discovery when `projectRoot` is omitted. */
  env?: Record<string, string | undefined>
}

export function createProjectPaths(options: CreateProjectPathsOptions = {}): ProjectPaths {
  const projectRoot = options.projectRoot
    ? resolve(options.projectRoot)
    : resolveProjectRoot(options.env)
  const guidelinesFile = options.guidelinesFile || DEFAULT_GUIDELINES_FILE

  const backendDir = join(projectRoot, 'backend')
  const configDir = join(backendDir, 'sdk', 'config')

  return {
    projectRoot,
    backendDir,
    agentsDir: join(projectRoot, 'agents'),
    // Python puts worlds/ next to the .exe when frozen; with no frozen mode
    // here it is always project-relative.
    worldsDir: join(projectRoot, 'worlds'),
    configDir,
    guidelinesConfigPath: join(configDir, `${guidelinesFile}.yaml`),
    localizationConfigPath: join(configDir, 'localization.yaml'),
    loreGuidelinesConfigPath: join(configDir, 'lore_guidelines.yaml'),
    conversationContextConfigPath: join(configDir, 'conversation_context.yaml'),
    debugConfigPath: join(backendDir, 'infrastructure', 'logging', 'debug.yaml'),
  }
}
