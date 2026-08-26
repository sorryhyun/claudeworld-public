/**
 * What the Action Manager is told about the NPCs.
 *
 * The two branches are mutually exclusive and the difference is the whole point
 * of the deferred reaction cell: reactions already in hand are pasted in, while
 * NPCs still speaking are *announced*, so the first narration can be written
 * before any of them has answered.
 */

import { describe, expect, test } from 'bun:test'

import {
  buildActionManagerUserMessage,
  type GameplayServices,
} from '@/orchestration/gameplay-context'

// Only two service methods are reachable from this builder; the rest would be
// dead weight in the stub.
const services = {
  locations: { loadLocation: () => null },
  rooms: { loadAndClearArrivalContext: () => null },
} as unknown as GameplayServices

function build(overrides: Record<string, unknown> = {}): string {
  return buildActionManagerUserMessage(services, {
    worldName: 'test_world',
    userName: 'Player',
    language: null,
    currentLocation: 'town_square',
    playerAction: 'I push the door open.',
    agentName: 'Action_Manager',
    ...overrides,
  })
}

describe('buildActionManagerUserMessage', () => {
  test('reactions already collected are pasted in, with the order to voice them', () => {
    const message = build({
      npcReactions: [{ agentId: 1, agentName: 'Elara', content: '"Careful."' }],
    })

    expect(message).toContain('<npc_reactions>')
    expect(message).toContain('### Elara')
    expect(message).toContain('"Careful."')
    expect(message).toContain('quote what they said as spoken')
  })

  test('NPCs still speaking are named, not waited for', () => {
    const message = build({ pendingReactionNames: ['Elara', 'Marcus'] })

    expect(message).toContain('<npc_reactions status="in_flight">')
    expect(message).toContain('Elara, Marcus')
    expect(message).toContain('await_reactions')
    // The instruction that buys the latency win.
    expect(message).toContain('Narrate the action itself first')
  })

  test('an empty location gets neither block', () => {
    const message = build()
    expect(message).not.toContain('<npc_reactions')
  })

  test('reactions in hand win over an in-flight announcement', () => {
    // Both would describe the same NPCs; announcing ones whose lines are already
    // quoted above sends the Action Manager to wait on nothing.
    const message = build({
      npcReactions: [{ agentId: 1, agentName: 'Elara', content: '"Careful."' }],
      pendingReactionNames: ['Elara'],
    })

    expect(message).toContain('<npc_reactions>')
    expect(message).not.toContain('in_flight')
  })
})
