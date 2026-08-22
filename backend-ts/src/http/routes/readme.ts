/**
 * Readme / help content.
 *
 * Ported from `backend/routers/readme.py`, which FastAPI mounts with no prefix.
 * The single consumer is `frontend/src/components/shared/HowToUseModal.tsx`,
 * which fetches `/readme?lang={en|ko|jp}` and hands the body straight to a
 * markdown renderer — so the response is raw text, not JSON, and the language
 * codes are part of the frozen contract rather than an implementation detail.
 *
 * The files live at the *project* root, not inside the backend: Python resolves
 * them as `Path(__file__).parent.parent.parent`, i.e. two levels up from
 * `backend/routers/`. `settings.paths.projectRoot` is the same directory.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Hono } from 'hono'

import { getLogger } from '../../infrastructure/logging/logger'
import { HttpError, validationError } from '../errors'
import type { AppEnv } from '../types'

const logger = getLogger('Readme')

/**
 * Language code to filename.
 *
 * Python builds this dict inline and then also passes a default to `.get()`,
 * which is dead code — the `^(en|ko|jp)$` pattern on the query parameter means
 * a miss is impossible. The pattern is enforced here instead, so the fallback
 * stays unreachable for the same reason.
 */
const LANG_TO_FILE: Readonly<Record<string, string>> = {
  en: 'en_readme.md',
  ko: 'ko_readme.md',
  jp: 'jp_readme.md',
}

/**
 * @param projectRoot Directory the `*_readme.md` files sit in. Passed in rather
 *   than read from `getSettings()` so a test can point it at a temp tree — the
 *   settings singleton is process-wide and the suite runs in-process.
 */
export function createReadmeRoutes(projectRoot: string): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/readme', (c) => {
    const lang = c.req.query('lang') ?? 'en'

    // FastAPI validates `Query(regex="^(en|ko|jp)$")` before the handler runs
    // and answers with its 422 envelope, not a 400 — so an unknown language is
    // a *validation* failure here too, not a 404 on a missing file.
    const filename = LANG_TO_FILE[lang]
    if (filename === undefined) {
      throw validationError([
        {
          loc: ['query', 'lang'],
          msg: 'String should match pattern \'^(en|ko|jp)$\'',
          type: 'string_pattern_mismatch',
        },
      ])
    }

    const readmePath = join(projectRoot, filename)

    let content: string
    try {
      content = readFileSync(readmePath, 'utf-8')
    } catch (error) {
      // Python checks `exists()` first and 404s, then wraps the read in its own
      // try/except for a 500. One `readFileSync` collapses both checks, so the
      // errno is what separates them — and it has to, because "file is gone"
      // and "file is unreadable" reach the frontend as different messages.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, `Readme file not found: ${filename}`)
      }
      logger.exception(`Failed to read ${readmePath}`, error)
      throw new HttpError(500, `Failed to read readme file: ${String(error)}`)
    }

    return c.text(content)
  })

  return routes
}
