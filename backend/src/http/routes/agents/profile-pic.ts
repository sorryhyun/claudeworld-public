/**
 * Agent profile pictures, served off the `agents/` tree so a dropped-in
 * `profile.png` shows up without a restart. This route is *unauthenticated* —
 * `middleware/auth.ts` excludes it — because the frontend renders it in an
 * `<img src>`, which cannot carry a header. That makes the name validation below
 * a security control, not a nicety.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import type { Context } from 'hono'

import { HttpError } from '../../errors'
import type { AppEnv } from '../../types'

/**
 * Word characters, hyphens, dots, spaces and the CJK ranges — agents are
 * routinely named in Korean and Japanese, and JavaScript's `\w` is ASCII-only,
 * so those ranges are load-bearing.
 */
const VALID_AGENT_NAME = /^[\w\-.\s぀-ヿ一-鿿가-힯]+$/u

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']

/** Checked before falling back to "any image in the folder". */
const COMMON_NAMES = ['profile', 'avatar', 'picture', 'photo']

const CACHE_HEADERS = { 'cache-control': 'public, max-age=3600, must-revalidate' }

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The first image in a folder, preferring the conventional names. */
function findInFolder(folder: string): string | null {
  if (!isDirectory(folder)) return null

  for (const name of COMMON_NAMES) {
    for (const ext of IMAGE_EXTENSIONS) {
      const candidate = join(folder, `${name}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }

  // Extension order wins over alphabetical order within the folder; readdir is
  // sorted to make the pick deterministic.
  let entries: string[]
  try {
    entries = readdirSync(folder).sort()
  } catch {
    return null
  }
  for (const ext of IMAGE_EXTENSIONS) {
    const match = entries.find((entry) => entry.toLowerCase().endsWith(ext))
    if (match) return join(folder, match)
  }

  return null
}

/** Three places in order: the agent's own folder, the same name inside any
 * `group_*` folder, then the legacy `agents/<name>.<ext>` layout. */
export function findProfilePic(agentsDir: string, agentName: string): string | null {
  const direct = findInFolder(join(agentsDir, agentName))
  if (direct) return direct

  let groups: string[]
  try {
    groups = readdirSync(agentsDir).filter((entry) => entry.startsWith('group_')).sort()
  } catch {
    groups = []
  }
  for (const group of groups) {
    const inGroup = findInFolder(join(agentsDir, group, agentName))
    if (inGroup) return inGroup
  }

  for (const ext of IMAGE_EXTENSIONS) {
    const legacy = join(agentsDir, `${agentName}${ext}`)
    if (existsSync(legacy)) return legacy
  }

  return null
}

export async function serveProfilePic(
  c: Context<AppEnv>,
  projectRoot: string,
  agentName: string,
): Promise<Response> {
  // The pattern rejects separators; the explicit `..` test catches a name that
  // is only dots, which the dot in the character class would otherwise allow.
  if (!VALID_AGENT_NAME.test(agentName) || agentName.includes('..')) {
    throw new HttpError(400, 'Invalid agent name')
  }

  const agentsDir = resolve(join(projectRoot, 'agents'))
  const found = findProfilePic(agentsDir, agentName)
  if (found === null) throw new HttpError(404, 'Profile picture not found')

  // Belt and braces: the name was validated, but the answer to "did we just
  // build a path outside the tree" should never depend on one regex.
  const resolved = resolve(found)
  if (!resolved.startsWith(agentsDir + sep)) {
    throw new HttpError(400, 'Invalid agent name')
  }

  const ext = IMAGE_EXTENSIONS.find((candidate) => resolved.toLowerCase().endsWith(candidate))
  const file = Bun.file(resolved)
  return new Response(file, {
    headers: {
      ...CACHE_HEADERS,
      'content-type': (ext && MEDIA_TYPES[ext]) || file.type || 'application/octet-stream',
    },
  })
}
