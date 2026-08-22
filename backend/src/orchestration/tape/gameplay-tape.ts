import { TurnTape, type TurnCell } from './models'

/**
 * Builds the two-cell gameplay tape. Port of
 * `orchestration/tape/trpg_generator.py::create_gameplay_tape`.
 *
 *   cell 0 — every NPC at the player's location reacts, concurrently, hidden.
 *            Their responses are collected rather than persisted.
 *   cell 1 — the Action Manager runs alone, receives those reactions, resolves
 *            the action, and narrates through its tools.
 *
 * Returns `null` when there is no Action Manager in the room. Python fell
 * through to a generic sequential handler in that case, which produced output
 * that looked plausible but was not a gameplay turn — a silent degradation the
 * pilot's trace flagged as a trap. Returning null makes the caller decide.
 */
export function createGameplayTape(actionManagerId: number | null, npcIds: number[]): TurnTape | null {
  if (actionManagerId === null) return null

  const cells: TurnCell[] = []

  // Omitted entirely when the location is empty — an empty concurrent cell would
  // still cost a round trip through the executor for nothing.
  if (npcIds.length > 0) {
    cells.push({
      cellType: 'concurrent',
      agentIds: npcIds,
      hidden: true,
      isReaction: true,
    })
  }

  cells.push({
    cellType: 'sequential',
    agentIds: [actionManagerId],
    hidden: true,
    isReaction: false,
  })

  return new TurnTape(cells)
}

/**
 * Builds the onboarding tape. Port of
 * `orchestration/tape/trpg_generator.py::create_onboarding_tape`.
 *
 * One cell, one agent: the Onboarding Manager conducts the interview *and*
 * generates the world seed through its `draft_world` / `persist_world` tools.
 * There is no separate World Seed Generator — the two were merged — so a world
 * still in `onboarding` never runs the two-cell gameplay tape at all.
 *
 * Unlike the gameplay cells this one is **not hidden**: the interview is a
 * conversation the player is having, so the manager's prose is persisted and
 * shown. That single difference is why onboarding cannot reuse
 * {@link createGameplayTape} with a substituted agent id.
 *
 * Returns `null` when the room has no Onboarding Manager, which is the caller's
 * signal that the room is misconfigured rather than merely empty.
 */
export function createOnboardingTape(onboardingManagerId: number | null): TurnTape | null {
  if (onboardingManagerId === null) return null

  return new TurnTape([
    {
      cellType: 'sequential',
      agentIds: [onboardingManagerId],
      hidden: false,
      isReaction: false,
    },
  ])
}
