/**
 * `lore.md` has three regions, and which agent owns which is the whole point.
 *
 * - **body** — the Onboarding Manager's prose. `draft_world` writes a summary
 *   here and `persist_world` replaces it wholesale.
 * - **World Lore Additions** — written by the design sub-agents through
 *   `add_world_lore`, one `### title` entry each. The Onboarding Manager never
 *   authors these and must not destroy them: a designer that invents a faction
 *   while the interview is still running would otherwise lose it the moment the
 *   manager persisted its full lore.
 * - **World Notes** — free-form notes carried across a rewrite, as before.
 *
 * `WorldService.saveLore` replaces the file wholesale (there is deliberately no
 * append path), so every writer goes split → edit → compose. Keep that sequence
 * synchronous: designers run concurrently, and an `await` between the read and
 * the write is where one contribution silently overwrites another.
 */

export const LORE_ADDITIONS_HEADING = '## World Lore Additions'
export const WORLD_NOTES_HEADING = '## World Notes'

// Tolerant on the leading blank lines and the trailing spaces so a file a model
// hand-edited still parses. The `---` rule is what makes the region greppable.
const SECTION_PATTERN = new RegExp(
  `\\n*---[ \\t]*\\n(${LORE_ADDITIONS_HEADING}|${WORLD_NOTES_HEADING})[ \\t]*\\n?`,
  'g',
)

const ENTRY_PATTERN = /^###[ \t]+(.+?)[ \t]*$/gm

export interface LoreSections {
  /** Everything before the first managed section — the `# World Lore` heading included. */
  body: string
  /** Inner text of the additions region, without its heading. */
  additions: string
  /** Inner text of the notes region, without its heading. */
  notes: string
}

function joinBlocks(existing: string, addition: string): string {
  if (!existing.trim()) return addition.trim()
  if (!addition.trim()) return existing.trim()
  return `${existing.trim()}\n\n${addition.trim()}`
}

/**
 * A region appearing twice is *merged*, not dropped: earlier releases of
 * `persist_world` appended a second `## World Notes` block instead of editing
 * the first, so worlds on disk carry duplicates.
 */
export function splitLore(lore: string): LoreSections {
  const matches = [...lore.matchAll(SECTION_PATTERN)]
  if (matches.length === 0) return { body: lore.trim(), additions: '', notes: '' }

  const sections: LoreSections = {
    body: lore.slice(0, matches[0]!.index).trim(),
    additions: '',
    notes: '',
  }

  matches.forEach((match, index) => {
    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1]!.index : lore.length
    const text = lore.slice(start, end)
    if (match[1] === LORE_ADDITIONS_HEADING) {
      sections.additions = joinBlocks(sections.additions, text)
    } else {
      sections.notes = joinBlocks(sections.notes, text)
    }
  })

  return sections
}

/** Region order is fixed, so a save that changed nothing is a no-op diff. */
export function composeLore(sections: LoreSections): string {
  let out = sections.body.trim()
  const additions = sections.additions.trim()
  const notes = sections.notes.trim()
  if (additions) out += `\n\n---\n${LORE_ADDITIONS_HEADING}\n\n${additions}`
  if (notes) out += `\n\n---\n${WORLD_NOTES_HEADING}\n\n${notes}`
  return `${out}\n`
}

export interface UpsertResult {
  additions: string
  /** True when an entry under this title already existed and was rewritten. */
  replaced: boolean
}

/**
 * Add or rewrite one `### title` entry. Titles match case-insensitively: a
 * designer revising its own contribution across two turns rarely reproduces the
 * capitalisation, and two entries for one faction is worse than one overwrite.
 */
export function upsertAddition(additions: string, title: string, content: string): UpsertResult {
  const entry = `### ${title.trim()}\n${content.trim()}`
  const existing = additions.trim()
  if (!existing) return { additions: entry, replaced: false }

  const headings = [...existing.matchAll(ENTRY_PATTERN)]
  const target = headings.findIndex(
    (match) => match[1]!.trim().toLowerCase() === title.trim().toLowerCase(),
  )
  if (target === -1) return { additions: `${existing}\n\n${entry}`, replaced: false }

  const start = headings[target]!.index
  const next = headings[target + 1]
  const end = next ? next.index : existing.length
  const before = existing.slice(0, start).trim()
  const after = existing.slice(end).trim()

  return {
    additions: [before, entry, after].filter((part) => part.length > 0).join('\n\n'),
    replaced: true,
  }
}

/** The `### title`s currently on file, for a status report. */
export function listAdditionTitles(additions: string): string[] {
  return [...additions.matchAll(ENTRY_PATTERN)].map((match) => match[1]!.trim())
}
