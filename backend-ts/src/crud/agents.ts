/**
 * CRUD operations for Agent entities — port of `backend/crud/agents.py`.
 *
 * Every function here is synchronous. `bun:sqlite` executes a statement to
 * completion before returning, so the Python side's `retry_on_db_lock` /
 * `serialized_write` wrappers have nothing left to guard against and are not
 * carried over.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { agents, type Agent } from '../db/schema'

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
