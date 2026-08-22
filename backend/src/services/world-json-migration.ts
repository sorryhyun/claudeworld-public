/**
 * One-shot conversion of a world tree written before the world data moved from
 * YAML to JSON. Nothing else in the codebase reads `.yaml` under `worlds/`, so
 * an install upgraded in place would otherwise find every world empty — the
 * installer preserves `worlds/` across a release, which is exactly the case
 * this exists for.
 *
 * Run from `main.ts` only, before the first request. It is deliberately not
 * wired into `createAppState`: the test suite and `bun run smoke` build their
 * worlds through `WorldService`, which has written JSON from the start.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { YAML } from 'bun'

import {
  dumpJson,
  LOCATION_INDEX_FILE,
  PLAYER_STATE_FILE,
  STAT_DEFINITIONS_FILE,
  WORLD_CONFIG_FILE,
} from './world-service'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('WorldJsonMigration')

/** The world-root files, paired with the JSON name each becomes. */
const ROOT_FILES: [string, string][] = [
  ['world.yaml', WORLD_CONFIG_FILE],
  ['player.yaml', PLAYER_STATE_FILE],
  ['stats.yaml', STAT_DEFINITIONS_FILE],
]

/**
 * Convert one file, and delete the YAML only once the JSON is on disk. Returns
 * false — never throws — for every reason to leave the pair alone: a malformed
 * document is kept as-is rather than replaced with a half-parse, and a JSON file
 * that already exists wins, because it is what the running code has been reading.
 */
function convertFile(yamlPath: string, jsonPath: string): boolean {
  if (!existsSync(yamlPath)) return false

  if (existsSync(jsonPath)) {
    logger.warning(`${jsonPath} already exists; leaving ${yamlPath} in place`)
    return false
  }

  let parsed: unknown
  try {
    parsed = YAML.parse(readFileSync(yamlPath, 'utf-8'))
  } catch (error) {
    logger.warning(`Could not parse ${yamlPath}, leaving it in place: ${String(error)}`)
    return false
  }

  // An empty file parses to null, which is still a file the readers expect to
  // find; `{}` is what every one of them degrades a null document to anyway.
  writeFileSync(jsonPath, dumpJson(parsed ?? {}), 'utf-8')
  rmSync(yamlPath)
  return true
}

/** `<world>/items/*.yaml`, each keeping its basename. */
function convertItemTemplates(worldPath: string): number {
  const itemsDir = join(worldPath, 'items')

  let names: string[]
  try {
    names = readdirSync(itemsDir)
  } catch {
    return 0
  }

  let converted = 0
  for (const name of names) {
    if (!name.endsWith('.yaml') || name.startsWith('.')) continue
    const jsonName = `${name.slice(0, -'.yaml'.length)}.json`
    if (convertFile(join(itemsDir, name), join(itemsDir, jsonName))) converted++
  }
  return converted
}

function convertWorld(worldPath: string): number {
  let converted = 0

  for (const [yamlName, jsonName] of ROOT_FILES) {
    if (convertFile(join(worldPath, yamlName), join(worldPath, jsonName))) converted++
  }

  const locationsDir = join(worldPath, 'locations')
  if (convertFile(join(locationsDir, '_index.yaml'), join(locationsDir, LOCATION_INDEX_FILE))) {
    converted++
  }

  return converted + convertItemTemplates(worldPath)
}

/**
 * Convert every world under `worldsDir`. Returns the number of files rewritten,
 * which is 0 on the common path — a fresh install, or one already converted.
 */
export function migrateWorldDataToJson(worldsDir: string): number {
  let entries
  try {
    entries = readdirSync(worldsDir, { withFileTypes: true })
  } catch {
    // No worlds directory yet: the first `createWorld` makes one, in JSON.
    return 0
  }

  let converted = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    converted += convertWorld(join(worldsDir, entry.name))
  }

  if (converted > 0) {
    logger.info(`Converted ${converted} world data file(s) from YAML to JSON`)
  }
  return converted
}
