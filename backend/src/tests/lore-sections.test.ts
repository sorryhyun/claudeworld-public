/**
 * The `lore.md` region split. This is the file two writers share — the
 * Onboarding Manager owns the body, the design sub-agents own the additions —
 * so the assertions here are all about one writer not destroying the other's
 * text. A world on disk may also carry the duplicated `## World Notes` blocks
 * earlier releases appended, which is why merging is tested rather than
 * last-one-wins.
 */

import { describe, expect, test } from 'bun:test'

import {
  composeLore,
  listAdditionTitles,
  splitLore,
  upsertAddition,
} from '@/sdk/handlers/lore-sections'

describe('splitLore', () => {
  test('a plain lore file is all body', () => {
    const sections = splitLore('# World Lore\n\nA drowned city.\n')
    expect(sections.body).toBe('# World Lore\n\nA drowned city.')
    expect(sections.additions).toBe('')
    expect(sections.notes).toBe('')
  })

  test('separates the two managed regions from the body', () => {
    const sections = splitLore(
      '# World Lore\n\nBody.\n\n---\n## World Lore Additions\n\n### Tide Wardens\nThey keep the locks.\n\n---\n## World Notes\nSpoilers.\n',
    )
    expect(sections.body).toBe('# World Lore\n\nBody.')
    expect(sections.additions).toBe('### Tide Wardens\nThey keep the locks.')
    expect(sections.notes).toBe('Spoilers.')
  })

  test('a region appearing twice is merged, not dropped', () => {
    // Earlier releases appended a second `## World Notes` instead of editing the
    // first, so worlds on disk carry duplicates.
    const sections = splitLore(
      '# World Lore\n\nBody.\n\n---\n## World Notes\nOne.\n\n---\n## World Notes\nTwo.\n',
    )
    expect(sections.notes).toBe('One.\n\nTwo.')
  })

  test('round-trips through composeLore', () => {
    const original =
      '# World Lore\n\nBody.\n\n---\n## World Lore Additions\n\n### A\nAlpha.\n\n---\n## World Notes\n\nNotes.\n'
    expect(composeLore(splitLore(original))).toBe(original)
  })

  test('composeLore omits a region that is empty rather than writing a bare heading', () => {
    expect(composeLore({ body: '# World Lore\n\nBody.', additions: '', notes: '  ' })).toBe(
      '# World Lore\n\nBody.\n',
    )
  })
})

describe('upsertAddition', () => {
  test('the first contribution becomes the whole region', () => {
    const { additions, replaced } = upsertAddition('', 'Tide Wardens', 'They keep the locks.')
    expect(replaced).toBe(false)
    expect(additions).toBe('### Tide Wardens\nThey keep the locks.')
  })

  test('a second title is appended, leaving the first alone', () => {
    const first = upsertAddition('', 'A', 'Alpha.').additions
    const { additions, replaced } = upsertAddition(first, 'B', 'Beta.')
    expect(replaced).toBe(false)
    expect(listAdditionTitles(additions)).toEqual(['A', 'B'])
    expect(additions).toContain('Alpha.')
  })

  test('the same title rewrites its own section and nothing else', () => {
    let additions = upsertAddition('', 'A', 'Alpha.').additions
    additions = upsertAddition(additions, 'B', 'Beta.').additions
    additions = upsertAddition(additions, 'C', 'Gamma.').additions

    const result = upsertAddition(additions, 'B', 'Beta, revised.')
    expect(result.replaced).toBe(true)
    // Rewritten in place: a revision must not shuffle the reading order of the
    // sections around it.
    expect(listAdditionTitles(result.additions)).toEqual(['A', 'B', 'C'])
    expect(result.additions).toContain('Beta, revised.')
    expect(result.additions).not.toContain('Beta.\n')
    expect(result.additions).toContain('Alpha.')
    expect(result.additions).toContain('Gamma.')
  })

  test('titles match case-insensitively', () => {
    // A designer revising its own contribution a turn later rarely reproduces
    // the capitalisation, and two entries for one faction is the worse outcome.
    const first = upsertAddition('', 'Tide Wardens', 'Alpha.').additions
    const result = upsertAddition(first, 'tide wardens', 'Beta.')
    expect(result.replaced).toBe(true)
    expect(listAdditionTitles(result.additions)).toEqual(['tide wardens'])
  })
})
