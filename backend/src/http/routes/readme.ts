/**
 * Readme / help content. `HowToUseModal.tsx` fetches `/readme?lang={en|ko|jp}`
 * and renders the body as markdown, so the response is raw text and the
 * language codes are part of the frozen contract. The files sit at the
 * *project* root, not inside the backend.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Hono } from 'hono'

import { getLogger } from '@/infrastructure/logging/logger'
import { HttpError, validationError } from '@/domain/errors'
import type { AppEnv } from '@/http/types'

const logger = getLogger('Readme')

// The `^(en|ko|jp)$` contract, enforced by this map's keys.
const LANG_TO_FILE: Readonly<Record<string, string>> = {
  en: 'en_readme.md',
  ko: 'ko_readme.md',
  jp: 'jp_readme.md',
}

/**
 * @param projectRoot Directory the `*_readme.md` files sit in. Passed in rather
 *   than read from the process-wide settings, so a test can use a temp tree.
 */
export function createReadmeRoutes(projectRoot: string): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/readme', (c) => {
    const lang = c.req.query('lang') ?? 'en'

    // An unknown language is a 422, not a 404 on a missing file.
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
      // "File is gone" and "file is unreadable" reach the frontend as
      // different messages, so the errno has to separate them.
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
