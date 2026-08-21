/**
 * CRUD operations for Agent entities — port of `backend/crud/agents.py`.
 *
 * Every function here is synchronous. `bun:sqlite` executes a statement to
 * completion before returning, so the Python side's `retry_on_db_lock` /
 * `serialized_write` wrappers have nothing left to guard against and are not
 * carried over.
 */

import { and, eq, inArray } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createProjectPaths } from '../config/paths'
import type { Db } from '../db'
import { agents, type Agent } from '../db/schema'
import { getLogger } from '../infrastructure/logging/logger'
import { invalidateAgentCache } from './cached'

const logger = getLogger('CRUD')

/** Arguments of `crud/agents.py::create_agent` (:20), as one object. */
export interface AgentCreate {
  name: string
  systemPrompt: string
  profilePic?: string | null
  inANutshell?: string | null
  characteristics?: string | null
  recentEvents?: string | null
  group?: string | null
  configFile?: string | null
  interruptEveryTurn?: boolean
  priority?: number
  transparent?: boolean
  /** NULL for system agents; a world name scopes the agent to one world's cast. */
  worldName?: string | null
}

/**
 * Create an agent row.
 *
 * Pure CRUD, as in Python: nothing here reads a config folder or builds a
 * prompt. `AgentFactory.create_from_config` is the layer that does, and it ends
 * by calling this.
 *
 * The three booleans and `priority` carry Python's `default=`/argument defaults
 * (`agents.py:30-32`) rather than being left NULL. SQLAlchemy applies those
 * ORM-side defaults on insert and they emit no DDL, so a column omitted here
 * would store NULL and read back as `null` — which `interrupt_every_turn` is
 * checked for truthiness anyway, but `priority` feeds an ordering comparison
 * where NULL and 0 sort differently.
 *
 * `created_at` is explicit for the same reason (`models.py:72`).
 */
export function createAgent(db: Db, agent: AgentCreate): Agent {
  return db
    .insert(agents)
    .values({
      name: agent.name,
      worldName: agent.worldName ?? null,
      group: agent.group ?? null,
      configFile: agent.configFile ?? null,
      profilePic: agent.profilePic ?? null,
      inANutshell: agent.inANutshell ?? null,
      characteristics: agent.characteristics ?? null,
      recentEvents: agent.recentEvents ?? null,
      systemPrompt: agent.systemPrompt,
      interruptEveryTurn: agent.interruptEveryTurn ?? false,
      priority: agent.priority ?? 0,
      transparent: agent.transparent ?? false,
      createdAt: new Date(),
    })
    .returning()
    .get()
}

/**
 * Fields `crud/agents.py::update_agent` (:198) accepts.
 *
 * Note the semantics differ from {@link updateLocation}'s patch object, and the
 * difference is Python's, not an inconsistency introduced here: `update_agent`
 * tests `if x is not None`, so a null means *leave the column alone*, while
 * `update_location` uses `model_dump(exclude_unset=True)`, where a null means
 * *write NULL*. `null` and `undefined` are therefore both "skip" here.
 */
export interface AgentUpdate {
  systemPrompt?: string | null
  profilePic?: string | null
  inANutshell?: string | null
  characteristics?: string | null
  recentEvents?: string | null
  interruptEveryTurn?: boolean | null
  priority?: number | null
  transparent?: boolean | null
}

/**
 * Update an agent's columns. Returns null when the agent does not exist.
 *
 * Pure CRUD: reloading from a config folder is `AgentFactory.reload_from_config`.
 */
export function updateAgent(db: Db, agentId: number, update: AgentUpdate): Agent | null {
  const existing = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!existing) return null

  const patch: Partial<typeof agents.$inferInsert> = {}

  if (update.systemPrompt != null) patch.systemPrompt = update.systemPrompt
  if (update.profilePic != null) {
    if (update.profilePic.startsWith('data:image/')) {
      // TODO(phase-3): call the port of `AgentConfigService.save_base64_profile_pic`
      // (`services/agent_config_service.py:145`, invoked from `crud/agents.py:247`)
      // before nulling the column. `services/agent-config.ts` has no writer yet.
      //
      // The DB half is reproduced as-is — Python clears the column because the
      // image is then served from `agents/<name>/profile.<ext>` — so that when
      // the writer lands, only the call above has to be added. Until then the
      // upload is accepted and the bytes go nowhere, which is why this logs at
      // error rather than passing quietly.
      logger.error(
        `Discarded a base64 profile picture for agent '${existing.name}': the filesystem ` +
          'writer (AgentConfigService.save_base64_profile_pic) is not ported yet.',
      )
      patch.profilePic = null
    } else {
      patch.profilePic = update.profilePic
    }
  }
  if (update.inANutshell != null) patch.inANutshell = update.inANutshell
  if (update.characteristics != null) patch.characteristics = update.characteristics
  if (update.recentEvents != null) patch.recentEvents = update.recentEvents
  if (update.interruptEveryTurn != null) patch.interruptEveryTurn = update.interruptEveryTurn
  if (update.priority != null) patch.priority = update.priority
  if (update.transparent != null) patch.transparent = update.transparent

  // Drizzle rejects an empty SET clause, where SQLAlchemy would simply commit
  // nothing. Python still returns the (unchanged) agent in that case.
  const updated =
    Object.keys(patch).length === 0
      ? existing
      : db.update(agents).set(patch).where(eq(agents.id, agentId)).returning().get()

  // `agents.py:269-271`. The prompt cache keyed on the agent id is what the SDK
  // layer reads at the start of every turn, so a system-prompt edit that is not
  // followed by this stays invisible until the entry expires.
  invalidateAgentCache(agentId)

  return updated
}

/** Get a specific agent by ID. */
export function getAgent(db: Db, agentId: number): Agent | null {
  return db.select().from(agents).where(eq(agents.id, agentId)).get() ?? null
}

/**
 * Get an agent by name, tolerating whitespace/underscore variations.
 *
 * Agent names reach this function from three unrelated places — folder names on
 * disk, prompts written by the model, and rows already in the DB — and those
 * disagree about whether "Action Manager" is spelled with a space or an
 * underscore. Python probes the three spellings in a fixed order and returns
 * the first hit; the order is load-bearing because a world could legitimately
 * contain both "Foo Bar" and "Foo_Bar", and the exact-match candidate has to
 * win.
 *
 * `worldName` is only applied as a filter when supplied. Passing `undefined`
 * therefore searches system agents and world characters alike, mirroring
 * Python's `if world_name is not None` guard. Note that a NULL `world_name`
 * (a system agent) can only be reached by omitting the argument — SQL `= NULL`
 * never matches, and Python has the same hole.
 */
export function getAgentByName(db: Db, name: string, worldName?: string | null): Agent | null {
  const lookup = (candidate: string): Agent | null => {
    const nameMatch = eq(agents.name, candidate)
    const where =
      worldName === undefined || worldName === null
        ? nameMatch
        : and(nameMatch, eq(agents.worldName, worldName))
    return db.select().from(agents).where(where).get() ?? null
  }

  // Variants equal to the original are dropped rather than re-queried, which is
  // what Python's `if name_with_underscores != name` guards express.
  const candidates = [name, name.replaceAll(' ', '_'), name.replaceAll('_', ' ')].filter(
    (candidate, i) => i === 0 || candidate !== name,
  )

  for (const candidate of candidates) {
    const found = lookup(candidate)
    if (found) return found
  }
  return null
}

/**
 * Every agent belonging to one world's cast.
 *
 * System agents are excluded by construction: their `world_name` is NULL and
 * SQL equality never matches NULL.
 */
export function getAgentsByWorld(db: Db, worldName: string): Agent[] {
  return db.select().from(agents).where(eq(agents.worldName, worldName)).all()
}

/**
 * `Path.with_suffix('.md')`.
 *
 * Replaces an existing extension rather than appending, and treats a leading
 * dot as part of the name (`.hidden` → `.hidden.md`), which is what
 * `pathlib` does and what `agents.py:184` relies on for single-file configs.
 */
function withMarkdownSuffix(path: string): string {
  const dir = dirname(path)
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return join(dir, `${stem}.md`)
}

export interface SyncAgentsOptions {
  /**
   * Root that relative `config_file` values resolve against.
   * Defaults to the discovered project root.
   */
  projectRoot?: string
}

/**
 * Delete agent rows whose config no longer exists on disk. Returns how many.
 *
 * An agent folder removed from `worlds/<world>/agents/` leaves its database row
 * behind, and that row still gets loaded into rooms and prompted. This is the
 * reconciliation pass; the filesystem wins.
 *
 * **Divergence from Python, deliberate.** `agents.py:181` builds
 * `Path(agent.config_file)` and tests it as-is, which resolves against the
 * process's *current working directory*. Stored values are project-root
 * relative (`agents/group_gameplay/Action_Manager`,
 * `worlds/<world>/agents/<name>` — see `agent_factory.py:131`), and the Python
 * server is launched from `backend/`, so every probe misses and the function
 * deletes the entire cast of the world it was asked to sync. Reproducing that
 * would be reproducing data loss, so paths are resolved against the project
 * root here, matching how `AgentConfigService` reads the very same value
 * (`agent_config_service.py:90`).
 *
 * A row with no `config_file` at all is left alone — Python's `if
 * agent.config_file:` guard — because that is an agent nothing on disk claims
 * ownership of.
 */
export function syncAgentsWithFilesystem(
  db: Db,
  worldName: string,
  { projectRoot }: SyncAgentsOptions = {},
): number {
  const root = projectRoot ?? createProjectPaths().projectRoot

  const stale: Agent[] = []
  for (const agent of getAgentsByWorld(db, worldName)) {
    if (!agent.configFile) continue

    const configPath = isAbsolute(agent.configFile) ? agent.configFile : join(root, agent.configFile)
    // Two shapes are legal: a folder of `.md` files, or a single `.md` file.
    if (existsSync(configPath) || existsSync(withMarkdownSuffix(configPath))) continue

    logger.info(
      `Deleting stale agent '${agent.name}' - config not found at '${agent.configFile}'`,
    )
    stale.push(agent)
  }

  if (stale.length === 0) return 0

  // One statement, one transaction — Python accumulates the deletes and commits
  // them together, so a failure part-way leaves the cast intact rather than
  // half-removed.
  db.delete(agents)
    .where(
      inArray(
        agents.id,
        stale.map((agent) => agent.id),
      ),
    )
    .run()

  logger.info(`Cleaned up ${stale.length} stale agents for world '${worldName}'`)
  return stale.length
}
