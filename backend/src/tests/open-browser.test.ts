/**
 * Opening a browser on the port the server actually won.
 *
 * The two things worth pinning are the ones a manual `make dev` will not show
 * you: that Chrome is preferred over the desktop's default opener on every
 * platform, and that a `bun --watch` restart does not open a second tab. The
 * latter is the whole reason the marker file exists — it only misbehaves after
 * an edit, which is exactly when nobody is looking at the startup log.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { browserCommands, markerPath, openBrowser, resolveOpenBrowser } from '@/http/open-browser'

const URL = 'http://localhost:8123'

/** A `which` that only knows about the commands it is handed. */
function whichOnly(...available: string[]) {
  return (command: string) => (available.includes(command) ? `/usr/bin/${command}` : null)
}

function scratchMarker(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-browser-'))
  return { path: join(dir, 'marker'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('resolveOpenBrowser', () => {
  test('follows dev mode when OPEN_BROWSER is unset', () => {
    expect(resolveOpenBrowser({ FRONTEND_DEV: 'true' })).toBe(true)
    expect(resolveOpenBrowser({ FRONTEND_DEV: 'false' })).toBe(false)
    expect(resolveOpenBrowser({})).toBe(false)
  })

  test('OPEN_BROWSER overrides dev mode in both directions', () => {
    expect(resolveOpenBrowser({ FRONTEND_DEV: 'true', OPEN_BROWSER: 'false' })).toBe(false)
    expect(resolveOpenBrowser({ FRONTEND_DEV: 'true', OPEN_BROWSER: '0' })).toBe(false)
    expect(resolveOpenBrowser({ OPEN_BROWSER: 'true' })).toBe(true)
    expect(resolveOpenBrowser({ OPEN_BROWSER: '1' })).toBe(true)
  })
})

describe('browserCommands', () => {
  test('prefers Chrome over the default-browser opener on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
      const commands = browserCommands(platform, URL)
      expect(commands.length).toBeGreaterThan(1)
      expect(commands.every((argv) => argv.includes(URL))).toBe(true)
      // The generic opener is the fallback, never the first choice.
      expect(commands[0]?.join(' ')).toContain('hrome')
    }
  })

  test("Windows start gets the empty window title its first quoted argument is taken for", () => {
    expect(browserCommands('win32', URL)[0]).toEqual(['cmd', '/c', 'start', '', 'chrome', URL])
  })
})

describe('openBrowser', () => {
  test('launches the first candidate that exists', () => {
    const { path, cleanup } = scratchMarker()
    const spawned: string[][] = []
    const argv = openBrowser(URL, {
      platform: 'linux',
      which: whichOnly('chromium', 'xdg-open'),
      spawn: (a) => spawned.push(a),
      marker: path,
    })
    cleanup()

    expect(argv).toEqual(['chromium', URL])
    expect(spawned).toEqual([['chromium', URL]])
  })

  test('falls back to the default-browser opener when Chrome is absent', () => {
    const { path, cleanup } = scratchMarker()
    const argv = openBrowser(URL, {
      platform: 'linux',
      which: whichOnly('xdg-open'),
      spawn: () => {},
      marker: path,
    })
    cleanup()

    expect(argv).toEqual(['xdg-open', URL])
  })

  test('does nothing, and does not throw, when no browser is installed', () => {
    const { path, cleanup } = scratchMarker()
    let spawns = 0
    const argv = openBrowser(URL, {
      platform: 'linux',
      which: () => null,
      spawn: () => {
        spawns += 1
      },
      marker: path,
    })
    cleanup()

    expect(argv).toBeNull()
    expect(spawns).toBe(0)
  })

  test('a spawn failure is swallowed and leaves no marker, so the next restart retries', () => {
    const { path, cleanup } = scratchMarker()
    const first = openBrowser(URL, {
      platform: 'linux',
      which: whichOnly('google-chrome'),
      spawn: () => {
        throw new Error('Exec format error')
      },
      marker: path,
    })
    expect(first).toBeNull()

    const spawned: string[][] = []
    const second = openBrowser(URL, {
      platform: 'linux',
      which: whichOnly('google-chrome'),
      spawn: (a) => spawned.push(a),
      marker: path,
    })
    cleanup()

    expect(second).toEqual(['google-chrome', URL])
    expect(spawned).toHaveLength(1)
  })

  test('a bun --watch restart on the same URL reuses the tab', () => {
    const { path, cleanup } = scratchMarker()
    const spawned: string[][] = []
    const options = {
      platform: 'linux' as NodeJS.Platform,
      which: whichOnly('google-chrome'),
      spawn: (a: string[]) => spawned.push(a),
      marker: path,
    }

    expect(openBrowser(URL, options)).toEqual(['google-chrome', URL])
    // Same pid, fresh module graph: exactly what `bun --watch` does on save.
    expect(openBrowser(URL, options)).toBeNull()
    cleanup()

    expect(spawned).toHaveLength(1)
  })

  test('a restart that could not keep its relocated port opens the new one', () => {
    const { path, cleanup } = scratchMarker()
    const spawned: string[][] = []
    const options = {
      platform: 'linux' as NodeJS.Platform,
      which: whichOnly('google-chrome'),
      spawn: (a: string[]) => spawned.push(a),
      marker: path,
    }

    openBrowser(URL, options)
    // The old tab is pointing at a port nothing is listening on any more.
    expect(openBrowser('http://localhost:8124', options)).toEqual([
      'google-chrome',
      'http://localhost:8124',
    ])
    cleanup()

    expect(spawned).toHaveLength(2)
  })

  test('a marker left by a recycled pid is ignored once it is stale', () => {
    const { path, cleanup } = scratchMarker()
    writeFileSync(path, `${URL}\n`)
    const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000)
    utimesSync(path, ancient, ancient)

    const argv = openBrowser(URL, {
      platform: 'linux',
      which: whichOnly('google-chrome'),
      spawn: () => {},
      marker: path,
    })
    cleanup()

    expect(argv).toEqual(['google-chrome', URL])
  })
})

describe('markerPath', () => {
  test('is keyed on the pid, which survives a watch restart where the port may not', () => {
    expect(markerPath(4321, '/tmp')).toBe('/tmp/claudeworld-browser-4321')
    expect(markerPath()).toContain(String(process.pid))
  })
})
