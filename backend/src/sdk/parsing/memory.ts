// `consolidated_memory.md` is a flat list of memories under `## [subtitle]`
// headings. Only the subtitles go into an agent's context; `recall` fetches a body
// on demand, which is what keeps the baseline token cost low.

import { readFileSync } from 'node:fs'

/** `## [subtitle]` — the bracket is what separates a memory from a plain heading. */
const SUBTITLE_PATTERN = /^##\s*\[([^\]]+)\]/

/** Text before the first subtitle is discarded as preamble; a missing or
 * unreadable file yields `{}`, since an agent without memories is normal. */
export function parseLongTermMemory(filePath: string): Record<string, string> {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return {}
  }

  const memories: Record<string, string> = {}
  let currentSubtitle: string | null = null
  let currentContent: string[] = []

  for (const line of content.split('\n')) {
    const match = SUBTITLE_PATTERN.exec(line)
    if (match?.[1] !== undefined) {
      if (currentSubtitle !== null) {
        memories[currentSubtitle] = currentContent.join('\n').trim()
      }
      currentSubtitle = match[1]
      currentContent = []
    } else if (currentSubtitle !== null) {
      currentContent.push(line)
    }
  }

  if (currentSubtitle !== null) {
    memories[currentSubtitle] = currentContent.join('\n').trim()
  }

  return memories
}

/** Subtitles only, in file order. */
export function getMemorySubtitles(filePath: string): string[] {
  return Object.keys(parseLongTermMemory(filePath))
}

/** One memory's body, or `null` when the subtitle is unknown. */
export function getMemoryBySubtitle(filePath: string, subtitle: string): string | null {
  return parseLongTermMemory(filePath)[subtitle] ?? null
}
