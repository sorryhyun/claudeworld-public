/**
 * The standalone executable's seams — the branches that only run inside
 * `bun build --compile` output and so are invisible to every other test.
 *
 * `IS_BUNDLED_EXE` is false here (nothing defines `__CLAUDEWORLD_BUNDLED` in a
 * test run), which is itself worth asserting: it is what keeps the repo run on
 * the paths it has always been on. The logic that *does* run in the binary is
 * reachable because it takes its inputs as arguments rather than reading the
 * process.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IS_BUNDLED_EXE, BUNDLED_VERSION } from '../config/bundled'
import {
  decideSeedAction,
  embeddedFrontend,
  relocateSeed,
  unpackSeed,
  type SeedManifest,
} from '../exe/assets'
import { resolveClaudeExecutable } from '../sdk/client/cli-path'
import { resetSettings, restoreExpandedDotEnv } from '../config/settings'

describe('bundled flags', () => {
  test('a test run is not a bundled run', () => {
    expect(IS_BUNDLED_EXE).toBe(false)
    expect(BUNDLED_VERSION).toBeNull()
  })

  test('nothing is embedded, so the embedded-asset readers stand down', () => {
    // `Bun.embeddedFiles` is empty outside the binary; both readers have to
    // report that as "read from disk instead" rather than as an empty tree.
    expect(embeddedFrontend()).toBeNull()

    const root = mkdtempSync(join(tmpdir(), 'cw-unpack-'))
    try {
      const result = unpackSeed(root)
      expect(result.created).toEqual([])
      expect(Bun.file(join(root, '.claudeworld-seed.json')).size).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('decideSeedAction', () => {
  const shipped = 'aaa'

  test('creates what is not there', () => {
    expect(decideSeedAction(null, undefined, shipped)).toBe('create')
  })

  test('refreshes a file the user never touched', () => {
    // On disk is exactly what the *previous* release wrote, so replacing it
    // loses nothing and is the only way a new prompt or agent ever ships.
    expect(decideSeedAction('bbb', 'bbb', shipped)).toBe('update')
  })

  test('keeps an edited file', () => {
    expect(decideSeedAction('edited', 'bbb', shipped)).toBe('preserve')
  })

  test('keeps a file that predates the manifest', () => {
    // No record of having written it: an install from before the manifest
    // existed, where every file has to be assumed to be the user's.
    expect(decideSeedAction('bbb', undefined, shipped)).toBe('preserve')
  })

  test('says nothing about a file that already matches', () => {
    expect(decideSeedAction(shipped, 'bbb', shipped)).toBe('identical')
  })
})

describe('relocateSeed', () => {
  const OLD_DIR = 'backend/sdk/config'
  const OLD_DEBUG = 'backend/infrastructure/logging/debug.yaml'

  let root: string

  function write(relative: string, contents: string): void {
    const target = join(root, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }

  function read(relative: string): string {
    return readFileSync(join(root, relative), 'utf-8')
  }

  /** An install from before the move: prompt YAML under the backend workspace. */
  function seedLegacyInstall(): SeedManifest {
    write(`${OLD_DIR}/guidelines_3rd.yaml`, 'shipped guidelines')
    write(`${OLD_DIR}/localization.yaml`, 'edited by the user')
    write(OLD_DEBUG, 'shipped debug')
    return {
      version: '0.1.0',
      files: {
        [`${OLD_DIR}/guidelines_3rd.yaml`]: 'hash-of-shipped-guidelines',
        [`${OLD_DIR}/localization.yaml`]: 'hash-of-shipped-localization',
        [OLD_DEBUG]: 'hash-of-shipped-debug',
      },
    }
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-relocate-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('a fresh install has nothing to move', () => {
    const manifest: SeedManifest = { version: null, files: {} }
    expect(relocateSeed(root, manifest)).toEqual([])
    expect(manifest.files).toEqual({})
  })

  test('legacy files land under config/, dragging their recorded hashes along', () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    const manifest = seedLegacyInstall()

    const moved = relocateSeed(root, manifest)

    expect(moved.sort()).toEqual([
      'config/debug.yaml',
      'config/guidelines_3rd.yaml',
      'config/localization.yaml',
    ])
    expect(read('config/guidelines_3rd.yaml')).toBe('shipped guidelines')
    expect(read('config/localization.yaml')).toBe('edited by the user')
    expect(read('config/debug.yaml')).toBe('shipped debug')
    expect(existsSync(join(root, OLD_DIR))).toBe(false)

    // The carried hash is the whole point: without it `decideSeedAction` sees
    // `recorded === undefined` and calls an untouched file a user edit, pinning
    // the install to whichever release first wrote it.
    expect(manifest.files['config/guidelines_3rd.yaml']).toBe('hash-of-shipped-guidelines')
    expect(manifest.files['config/debug.yaml']).toBe('hash-of-shipped-debug')
    const recorded = manifest.files['config/guidelines_3rd.yaml']
    expect(decideSeedAction('hash-of-shipped-guidelines', recorded, 'next-release')).toBe('update')
  })

  test('the empty backend/ tree the move leaves behind is pruned, drizzle/ is not', () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    seedLegacyInstall()
    write('backend/drizzle/0000_init.sql', 'create table ...')

    relocateSeed(root, { version: null, files: {} })

    expect(existsSync(join(root, 'backend/sdk'))).toBe(false)
    expect(existsSync(join(root, 'backend/infrastructure'))).toBe(false)
    // pruneEmpty climbs only through directories the removal actually emptied.
    expect(existsSync(join(root, 'backend/drizzle/0000_init.sql'))).toBe(true)
  })

  test('a file the seed never shipped moves too', () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    seedLegacyInstall()
    // A custom GUIDELINES_FILE: the user's own, in no manifest, and orphaned by
    // a rename that only knew about the files this release ships.
    write(`${OLD_DIR}/my_guidelines.yaml`, 'hand-written')

    const manifest: SeedManifest = { version: null, files: {} }
    expect(relocateSeed(root, manifest)).toContain('config/my_guidelines.yaml')
    expect(read('config/my_guidelines.yaml')).toBe('hand-written')
    expect(manifest.files['config/my_guidelines.yaml']).toBeUndefined()
  })

  test('an install already on the new layout is left alone', () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    seedLegacyInstall()
    write('config/guidelines_3rd.yaml', 'the copy that counts')

    relocateSeed(root, { version: null, files: {} })

    expect(read('config/guidelines_3rd.yaml')).toBe('the copy that counts')
    // Nothing was clobbered, so the stale original is simply left where it is.
    expect(read(`${OLD_DIR}/guidelines_3rd.yaml`)).toBe('shipped guidelines')
  })

  test('relocation is idempotent', () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    seedLegacyInstall()

    relocateSeed(root, { version: null, files: {} })
    expect(relocateSeed(root, { version: null, files: {} })).toEqual([])
    expect(read('config/localization.yaml')).toBe('edited by the user')
  })
})

describe('restoreExpandedDotEnv', () => {
  // What `make setup` writes, and what Bun's loader turns it into: `$2b`, `$12`
  // and `$kD0...` are all read as variable references, all undefined, all
  // replaced with nothing.
  const HASH = '$2b$12$kD0.QQcs0fgYDIT17f9lv.D3BmBbcD9wi5icEQzFbnPOjDc1f3qTK'
  const SHREDDED = '.QQcs0fgYDIT17f9lv.D3BmBbcD9wi5icEQzFbnPOjDc1f3qTK'

  test('puts back a hash the loader expanded away', () => {
    expect(restoreExpandedDotEnv({ API_KEY_HASH: HASH }, { API_KEY_HASH: SHREDDED })).toEqual({
      API_KEY_HASH: HASH,
    })
  })

  test('leaves a real override alone', () => {
    // Someone exporting API_KEY_HASH by hand means it; only a value that is
    // *exactly* the expansion of the file's is treated as damage.
    const other = '$2b$12$adifferenthashentirely00000000000000000000000000000000'
    expect(restoreExpandedDotEnv({ API_KEY_HASH: HASH }, { API_KEY_HASH: other })).toEqual({})
  })

  test('ignores values with no reference in them and keys not in the process', () => {
    expect(restoreExpandedDotEnv({ USER_NAME: 'Ada' }, { USER_NAME: '' })).toEqual({})
    expect(restoreExpandedDotEnv({ API_KEY_HASH: HASH }, {})).toEqual({})
  })

  test('handles the braced form', () => {
    expect(restoreExpandedDotEnv({ K: 'a${NOPE}b' }, { K: 'ab' })).toEqual({ K: 'a${NOPE}b' })
  })
})

describe('resolveClaudeExecutable', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-cli-'))
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('honours CLAUDE_CODE_PATH in a repo run', () => {
    const binary = join(dir, 'claude')
    expect(resolveClaudeExecutable({ CLAUDE_CODE_PATH: binary }, '')).toBe(binary)
  })

  test('a CLAUDE_CODE_PATH pointing nowhere resolves to nothing', () => {
    // Not a fallback to the search: an override that is wrong should say so by
    // failing to start, not by silently running a different binary.
    expect(resolveClaudeExecutable({ CLAUDE_CODE_PATH: join(dir, 'gone') }, '')).toBeNull()
  })

  test('without an override a repo run defers to the SDK', () => {
    // The SDK resolves its own copy from node_modules, version-matched to the
    // pin. Only the binary, which has no node_modules, has to search.
    expect(resolveClaudeExecutable({ HOME: dir }, dir)).toBeNull()
  })
})

describe('the embedded frontend middleware', () => {
  let dir: string
  let files: Record<string, string>

  beforeAll(() => {
    // Real files on disk standing in for embedded ones: the middleware only
    // ever hands the path to `Bun.file()`, so the map is the whole contract.
    dir = mkdtempSync(join(tmpdir(), 'cw-embedded-'))
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>')
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
    files = {
      '/index.html': join(dir, 'index.html'),
      '/assets/index-abc123.js': join(dir, 'assets', 'index-abc123.js'),
    }
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function app() {
    process.env.API_KEY_HASH = '$2b$12$H0fCIM9buSuQsCFErTRi0Omz//QVZxCKJW5Dapi2u3ealuUFzvF9O'
    process.env.JWT_SECRET = 'embedded-test-secret'
    resetSettings()
    const { createApp } = await import('../http/app')
    return createApp(undefined, { embeddedFrontend: files })
  }

  test('serves the shell at the root, unauthenticated', async () => {
    const response = await (await app()).request('/')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('id="root"')
  })

  test('serves a hashed asset as immutable', async () => {
    const response = await (await app()).request('/assets/index-abc123.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  test('hands a deep link the shell', async () => {
    const response = await (await app()).request('/game/abc')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('id="root"')
  })

  test('leaves API paths to the API', async () => {
    // The whole reason `API_PREFIXES` exists: an unknown API path must stay a
    // JSON 404 rather than becoming a 200 full of HTML.
    const response = await (await app()).request('/worlds/nope')
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  test('a POST to an unknown path is not a page load', async () => {
    // Falls through to auth, which is the point: a POST is a client bug, and
    // answering it with 200 and the shell would hide that.
    const response = await (await app()).request('/game/abc', { method: 'POST' })
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})
