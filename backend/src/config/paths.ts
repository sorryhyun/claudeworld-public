/**
 * Filesystem layout of the ClaudeWorld project. `agents/`, `worlds/` and
 * `backend/sdk/config/` are *user-editable data*, not bundled code, and a
 * `bun build --compile` binary embeds modules rather than those trees — so the
 * root comes from a `CLAUDEWORLD_ROOT` override or from walking up from here.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Env var that pins the project root, bypassing directory discovery. */
export const PROJECT_ROOT_ENV_VAR = 'CLAUDEWORLD_ROOT'

/** Default `GUIDELINES_FILE` (basename, no extension). */
export const DEFAULT_GUIDELINES_FILE = 'guidelines_3rd'

export interface ProjectPaths {
  /** Repository root — the directory holding `agents/`, `backend/`, `worlds/`. */
  readonly projectRoot: string
  readonly backendDir: string
  readonly agentsDir: string
  readonly worldsDir: string
  readonly configDir: string
  readonly guidelinesConfigPath: string
  readonly localizationConfigPath: string
  readonly loreGuidelinesConfigPath: string
  readonly conversationContextConfigPath: string
  /** `backend/infrastructure/logging/debug.yaml` — *not* under configDir. */
  readonly debugConfigPath: string
}

const ROOT_MARKERS = ['agents', 'backend'] as const

function looksLikeProjectRoot(candidate: string): boolean {
  return ROOT_MARKERS.every((marker) => existsSync(join(candidate, marker)))
}

/**
 * Locate the project root: `CLAUDEWORLD_ROOT` → walk up for a directory holding
 * both `agents/` and `backend/` → `<backend>/..`. The walk is what makes
 * `bun test` work from any cwd; the env var is what makes a relocated install
 * work, where this file may sit outside the repo.
 */
export function resolveProjectRoot(env: Record<string, string | undefined> = process.env): string {
  const override = env[PROJECT_ROOT_ENV_VAR]
  if (override) return resolve(override)

  let current = import.meta.dir
  // Bounded by the filesystem root, where dirname() is a fixed point.
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
  projectRoot?: string
  guidelinesFile?: string
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
