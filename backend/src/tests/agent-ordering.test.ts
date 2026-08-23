import { describe, expect, test } from 'bun:test'

import { separateInterruptAgents, separatePriorityAgents } from '@/orchestration/agent-ordering'

interface TestAgent {
  name: string
  priority?: number | null
  interruptEveryTurn?: boolean | null
}

const names = (agents: TestAgent[]) => agents.map((a) => a.name)

describe('separatePriorityAgents', () => {
  test('splits on priority > 0 and sorts the priority half descending', () => {
    const roster: TestAgent[] = [
      { name: 'a', priority: 1 },
      { name: 'b', priority: 0 },
      { name: 'c', priority: 9 },
      { name: 'd', priority: 5 },
    ]
    const [priority, regular] = separatePriorityAgents(roster)

    expect(names(priority)).toEqual(['c', 'd', 'a'])
    expect(names(regular)).toEqual(['b'])
  })

  test('a null, undefined or missing priority is zero, not NaN', () => {
    const roster: TestAgent[] = [
      { name: 'null', priority: null },
      { name: 'undefined', priority: undefined },
      { name: 'absent' },
      { name: 'set', priority: 3 },
    ]
    const [priority, regular] = separatePriorityAgents(roster)

    expect(names(priority)).toEqual(['set'])
    expect(names(regular)).toEqual(['null', 'undefined', 'absent'])
  })

  test('negative priorities are regular agents', () => {
    const [priority, regular] = separatePriorityAgents([{ name: 'a', priority: -1 }])
    expect(priority).toEqual([])
    expect(names(regular)).toEqual(['a'])
  })

  test('ties keep roster order (both sorts are stable)', () => {
    const roster: TestAgent[] = [
      { name: 'a', priority: 5 },
      { name: 'b', priority: 5 },
      { name: 'c', priority: 7 },
      { name: 'd', priority: 5 },
    ]
    const [priority] = separatePriorityAgents(roster)
    expect(names(priority)).toEqual(['c', 'a', 'b', 'd'])
  })

  test('the regular half is left in roster order, unsorted', () => {
    const roster: TestAgent[] = [
      { name: 'a', priority: 0 },
      { name: 'b' },
      { name: 'c', priority: null },
    ]
    const [, regular] = separatePriorityAgents(roster)
    expect(names(regular)).toEqual(['a', 'b', 'c'])
  })

  test('does not reorder the caller’s array', () => {
    const roster: TestAgent[] = [
      { name: 'a', priority: 1 },
      { name: 'b', priority: 9 },
    ]
    separatePriorityAgents(roster)
    expect(names(roster)).toEqual(['a', 'b'])
  })

  test('an empty roster yields two empty halves', () => {
    expect(separatePriorityAgents([])).toEqual([[], []])
  })
})

describe('separateInterruptAgents', () => {
  test('splits on interruptEveryTurn and sorts interrupters by priority', () => {
    const roster: TestAgent[] = [
      { name: 'a', interruptEveryTurn: true, priority: 1 },
      { name: 'b', interruptEveryTurn: false, priority: 9 },
      { name: 'c', interruptEveryTurn: true, priority: 7 },
    ]
    const [interrupt, regular] = separateInterruptAgents(roster)

    expect(names(interrupt)).toEqual(['c', 'a'])
    // High priority does not make a non-interrupter interrupt.
    expect(names(regular)).toEqual(['b'])
  })

  test('null and missing flags are not interrupters', () => {
    // The column is nullable, so an agent that was never configured reads
    // NULL — which Drizzle hands back as null, matching Python's `None == 1`.
    const roster: TestAgent[] = [
      { name: 'null', interruptEveryTurn: null },
      { name: 'undefined', interruptEveryTurn: undefined },
      { name: 'absent' },
      { name: 'set', interruptEveryTurn: true },
    ]
    const [interrupt, regular] = separateInterruptAgents(roster)

    expect(names(interrupt)).toEqual(['set'])
    expect(names(regular)).toEqual(['null', 'undefined', 'absent'])
  })

  test('interrupters with no priority sort as zero and hold roster order', () => {
    const roster: TestAgent[] = [
      { name: 'a', interruptEveryTurn: true },
      { name: 'b', interruptEveryTurn: true, priority: null },
      { name: 'c', interruptEveryTurn: true, priority: 4 },
      { name: 'd', interruptEveryTurn: true, priority: 4 },
    ]
    const [interrupt] = separateInterruptAgents(roster)
    expect(names(interrupt)).toEqual(['c', 'd', 'a', 'b'])
  })

  test('does not reorder the caller’s array', () => {
    const roster: TestAgent[] = [
      { name: 'a', interruptEveryTurn: true, priority: 1 },
      { name: 'b', interruptEveryTurn: true, priority: 9 },
    ]
    separateInterruptAgents(roster)
    expect(names(roster)).toEqual(['a', 'b'])
  })

  test('an empty roster yields two empty halves', () => {
    expect(separateInterruptAgents([])).toEqual([[], []])
  })
})
