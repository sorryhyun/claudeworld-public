/**
 * The chat-room scheduler.
 *
 * Port of the behaviour `orchestration/tape/generator.py` encodes and that
 * Python never tested. The rules are easy to state and easy to get subtly
 * wrong — who speaks first, who runs concurrently, and which agents provoke the
 * interrupt agents — so they are pinned here cell by cell.
 */

import { describe, expect, test } from 'bun:test'

import { separateInterruptAgents } from '@/orchestration/agent-ordering'
import { createChatRoomTapes, type ChatRoomAgent } from '@/orchestration/tape/chat-room-tape'
import type { TurnCell } from '@/orchestration/tape/models'

function agent(id: number, extra: Partial<ChatRoomAgent> = {}): ChatRoomAgent {
  return { id, priority: 0, interruptEveryTurn: false, transparent: false, ...extra }
}

/** A readable shorthand for a tape: `[type, ...ids]` per cell. */
function shape(cells: readonly TurnCell[]): (string | number)[][] {
  return cells.map((cell) => [cell.cellType, ...cell.agentIds])
}

/** Split a roster the way the orchestrator does before building tapes. */
function tapesFor(roster: ChatRoomAgent[]) {
  const [interrupt, plain] = separateInterruptAgents(roster)
  // `shuffle` is the identity here: the follow-up round shuffles regular agents
  // for a natural conversation order, which would make these assertions flaky.
  return createChatRoomTapes(plain, interrupt, (items) => items)
}

describe('initial round', () => {
  test('regular agents answer the user concurrently', () => {
    // They are all reacting to the same message and nothing they say depends on
    // each other, so serialising them would only cost latency.
    const tape = tapesFor([agent(1), agent(2), agent(3)]).initial()
    expect(shape(tape.cells)).toEqual([['concurrent', 1, 2, 3]])
  })

  test('priority agents go first, sequentially, in descending priority', () => {
    const tape = tapesFor([
      agent(1),
      agent(2, { priority: 5 }),
      agent(3, { priority: 9 }),
    ]).initial()

    expect(shape(tape.cells)).toEqual([
      ['sequential', 3],
      ['sequential', 2],
      ['concurrent', 1],
    ])
  })

  test('an interrupt agent answers the user before anyone, then after each beat', () => {
    const tape = tapesFor([
      agent(1),
      agent(2, { priority: 5 }),
      agent(9, { interruptEveryTurn: true }),
    ]).initial()

    expect(shape(tape.cells)).toEqual([
      // Triggered by the user.
      ['interrupt', 9],
      ['sequential', 2],
      // Triggered by agent 2.
      ['interrupt', 9],
      ['concurrent', 1],
      // One cell for the whole concurrent block: it is a single beat.
      ['interrupt', 9],
    ])
  })

  test('a transparent priority agent does not provoke the interrupt agents', () => {
    const tape = tapesFor([
      agent(2, { priority: 5, transparent: true }),
      agent(9, { interruptEveryTurn: true }),
    ]).initial()

    expect(shape(tape.cells)).toEqual([
      ['interrupt', 9],
      ['sequential', 2],
    ])
  })

  test('an all-transparent concurrent block gets no interrupt cell', () => {
    const tape = tapesFor([
      agent(1, { transparent: true }),
      agent(2, { transparent: true }),
      agent(9, { interruptEveryTurn: true }),
    ]).initial()

    expect(shape(tape.cells)).toEqual([
      ['interrupt', 9],
      ['concurrent', 1, 2],
    ])
  })

  test('interrupt agents are ordered by priority among themselves', () => {
    const tape = tapesFor([
      agent(8, { interruptEveryTurn: true, priority: 1 }),
      agent(9, { interruptEveryTurn: true, priority: 7 }),
    ]).initial()

    expect(shape(tape.cells)).toEqual([['interrupt', 9, 8]])
  })
})

describe('follow-up rounds', () => {
  test('everyone is sequential — they are answering each other', () => {
    const tape = tapesFor([agent(1), agent(2), agent(3)]).followUp(0)
    expect(shape(tape!.cells)).toEqual([
      ['sequential', 1],
      ['sequential', 2],
      ['sequential', 3],
    ])
  })

  test('priority agents still lead', () => {
    const tape = tapesFor([agent(1), agent(2, { priority: 4 })]).followUp(0)
    expect(shape(tape!.cells)).toEqual([
      ['sequential', 2],
      ['sequential', 1],
    ])
  })

  test('an interrupt agent does not interrupt itself', () => {
    // Its own turn is followed by an interrupt cell, and without the exclusion
    // it would be in that cell answering its own line.
    const tapes = tapesFor([agent(1), agent(9, { interruptEveryTurn: true })])
    const tape = tapes.followUp(0)

    expect(shape(tape!.cells)).toEqual([
      ['sequential', 1],
      ['interrupt', 9],
    ])
  })

  test('two interrupt agents still react to each other', () => {
    const tapes = createChatRoomTapes(
      [agent(1)],
      [agent(8, { interruptEveryTurn: true }), agent(9, { interruptEveryTurn: true })],
      (items) => items,
    )
    expect(shape(tapes.followUp(0)!.cells)).toEqual([
      ['sequential', 1],
      ['interrupt', 8, 9],
    ])
  })

  test('a room with only interrupt agents has no follow-up tape', () => {
    // Nothing to schedule sequentially, so there is no round to run.
    const tapes = tapesFor([agent(9, { interruptEveryTurn: true })])
    expect(tapes.followUp(0)).toBeNull()
  })

  test('the shuffle only moves regular agents', () => {
    // Reversing stands in for a shuffle: the priority agent must keep its slot.
    const [interrupt, plain] = separateInterruptAgents([
      agent(1),
      agent(2),
      agent(3, { priority: 9 }),
    ])
    const tapes = createChatRoomTapes(plain, interrupt, (items) => items.reverse())

    expect(shape(tapes.followUp(0)!.cells)).toEqual([
      ['sequential', 3],
      ['sequential', 2],
      ['sequential', 1],
    ])
  })
})

describe('the roster the tapes report', () => {
  test('allAgents includes the interrupt agents', () => {
    // The orchestrator counts it to decide whether follow-up rounds are worth
    // running at all — a one-agent room has nobody to talk to.
    const tapes = tapesFor([agent(1), agent(9, { interruptEveryTurn: true })])
    expect(tapes.allAgents.map((a) => a.id).sort()).toEqual([1, 9])
  })

  test('a tape never reorders the caller’s roster', () => {
    const roster = [agent(1), agent(2, { priority: 5 })]
    const before = roster.map((a) => a.id)
    tapesFor(roster).initial()
    expect(roster.map((a) => a.id)).toEqual(before)
  })
})
