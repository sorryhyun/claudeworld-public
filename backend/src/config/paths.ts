/**
 * Filesystem layout of the ClaudeWorld project.
 *
 * `agents/`, `worlds/` and `backend/sdk/config/` are *user-editable data*, not
 * bundled code: agent folders and the prompt YAML are hot-reloaded on every
 * agent response, and worlds are written at runtime. A `bun build --compile`
 * binary embeds modules, not those trees, so instead of a frozen-mode branch we
 * take an explicit override, `CLAUDEWORLD_ROOT`, and otherwise discover the
 * root by walking up from this module.
 *
 * `backendDir` is this package. The prompt YAML used to live in the retired
 * Python tree and be read across from here; it moved into `backend/sdk/config/`
 * when that tree was deleted, which is why the config directory sits beside
 * `src/` rather than inside it.
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
  /** The backend package — root of the YAML config tree. */
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
 * that contains both `agents/` and `backend/` → `<backend>/..`.
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

  // src/config/ -> src/ -> backend/ -> repo root
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
    worldsDir: join(projectRoot, 'worlds'),
    configDir,
    guidelinesConfigPath: join(configDir, `${guidelinesFile}.yaml`),
    localizationConfigPath: join(configDir, 'localization.yaml'),
    loreGuidelinesConfigPath: join(configDir, 'lore_guidelines.yaml'),
    conversationContextConfigPath: join(configDir, 'conversation_context.yaml'),
    debugConfigPath: join(backendDir, 'infrastructure', 'logging', 'debug.yaml'),
  }
}
