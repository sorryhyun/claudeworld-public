/** CRUD operations for Agent entities. */

import { and, eq, inArray } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createProjectPaths } from '@/config/paths'
import type { Db } from '@/db'
import { agents, roomAgents, type Agent } from '@/db/schema'
import { getCache, roomAgentsKey } from '@/infrastructure/cache'
import { getLogger } from '@/infrastructure/logging/logger'
import { invalidateAgentCache } from './cache-invalidation'

const logger = getLogger('CRUD')

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

// The booleans, `priority` and `created_at` carry no SQL DEFAULT, and NULL and
// 0 sort differently in the ordering `priority` feeds.
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

// Unlike `LocationUpdate`, `null` and `undefined` both mean "skip" here.
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

export function updateAgent(db: Db, agentId: number, update: AgentUpdate): Agent | null {
  const existing = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!existing) return null

  const patch: Partial<typeof agents.$inferInsert> = {}

  if (update.systemPrompt != null) patch.systemPrompt = update.systemPrompt
  if (update.profilePic != null) {
    if (update.profilePic.startsWith('data:image/')) {
      // TODO(phase-3): write the image to `agents/<name>/profile.<ext>` before
      // nulling the column — `services/agent-config.ts` has no writer yet, so
      // the upload is accepted and the bytes go nowhere. Hence the error log.
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

  // Drizzle rejects an empty SET clause.
  const updated =
    Object.keys(patch).length === 0
      ? existing
      : db.update(agents).set(patch).where(eq(agents.id, agentId)).returning().get()

  // The SDK layer reads the id-keyed prompt cache at the start of every turn, so
  // a system-prompt edit not followed by this stays invisible until it expires.
  invalidateAgentCache(agentId)

  return updated
}

export function getAgent(db: Db, agentId: number): Agent | null {
  return db.select().from(agents).where(eq(agents.id, agentId)).get() ?? null
}

// Unscoped: system agents (NULL `world_name`) mixed with every world's cast.
export function getAllAgents(db: Db): Agent[] {
  return db.select().from(agents).all()
}

// `room_agents` and `room_agent_sessions` cascade; `messages.agent_id` is
// `ON DELETE SET NULL`. Both cache sweeps are required: SQLite reuses rowids, so
// a cached `agent_config:{id}` can reach a *different* agent that inherits the
// id, and without the membership sweep the orchestrator keeps giving it turns.
export function deleteAgent(db: Db, agentId: number): boolean {
  const memberships = db
    .select({ roomId: roomAgents.roomId })
    .from(roomAgents)
    .where(eq(roomAgents.agentId, agentId))
    .all()

  const deleted = db.delete(agents).where(eq(agents.id, agentId)).returning({ id: agents.id }).get()
  if (!deleted) return false

  invalidateAgentCache(agentId)
  for (const { roomId } of memberships) getCache().invalidate(roomAgentsKey(roomId))

  return true
}

/**
 * Get an agent by name, tolerating whitespace/underscore variations. The three
 * spellings are probed in a fixed order, and the order is load-bearing: a world
 * can hold both "Foo Bar" and "Foo_Bar". `worldName` filters only when
 * supplied, and a NULL one is reachable *only* by omitting the argument.
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

  // Variants equal to the original are dropped rather than re-queried.
  const candidates = [name, name.replaceAll(' ', '_'), name.replaceAll('_', ' ')].filter(
    (candidate, i) => i === 0 || candidate !== name,
  )

  for (const candidate of candidates) {
    const found = lookup(candidate)
    if (found) return found
  }
  return null
}

// System agents are excluded by construction: `world_name` is NULL for them.
export function getAgentsByWorld(db: Db, worldName: string): Agent[] {
  return db.select().from(agents).where(eq(agents.worldName, worldName)).all()
}

// Replaces an existing extension rather than appending; a leading dot is part
// of the name (`.hidden` → `.hidden.md`).
function withMarkdownSuffix(path: string): string {
  const dir = dirname(path)
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return join(dir, `${stem}.md`)
}

export interface SyncAgentsOptions {
  /** Root relative `config_file` values resolve against; defaults to the project root. */
  projectRoot?: string
}

/**
 * Delete agent rows whose config no longer exists on disk; the filesystem wins.
 * Stored `config_file` values are project-root relative and must be resolved
 * against the project root, never the cwd — against the cwd every probe misses
 * and the world's entire cast is deleted. A row with no `config_file` is left
 * alone: nothing on disk claims it.
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

  // One statement, so a failure leaves the cast intact rather than half-removed.
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
