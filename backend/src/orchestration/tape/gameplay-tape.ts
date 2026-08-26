import { TurnTape, type TurnCell } from './models'

/** NPCs at the player's location react concurrently and hidden, their responses
 * collected rather than persisted; the Action Manager starts at the *same
 * moment* and narrates through its tools, pulling the reactions in with
 * `await_reactions` once it has narrated the player's own action. `null` when
 * the room has no Action Manager — falling through to a generic sequential
 * handler produces output that looks plausible but is not a gameplay turn.
 *
 * The reaction cell is `deferred`, which is the whole point: run in order, the
 * player watched a blank screen for the length of the slowest NPC before a
 * single word was written. */
export function createGameplayTape(actionManagerId: number | null, npcIds: number[]): TurnTape | null {
  if (actionManagerId === null) return null

  const cells: TurnCell[] = []

  // Omitted when the location is empty: an empty concurrent cell still costs a
  // round trip through the executor.
  if (npcIds.length > 0) {
    cells.push({
      cellType: 'concurrent',
      agentIds: npcIds,
      hidden: true,
      isReaction: true,
      deferred: true,
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

/** One cell, one agent, conducting the interview *and* writing the world seed
 * through `draft_world`/`persist_world`. Unlike the gameplay cells it is **not
 * hidden** — the interview is a conversation the player is having — which is why
 * onboarding cannot reuse {@link createGameplayTape} with another agent id. */
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
