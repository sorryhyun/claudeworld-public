/**
 * Opening a browser at the URL the server actually won — only the process that
 * bound the socket knows it. Never fatal, and once per `make dev` rather than
 * once per reload: `bun --watch` re-runs the module graph on every save under
 * one pid, hence the pid-keyed marker file.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IS_BUNDLED_EXE } from '@/config/bundled'
import { getLogger } from '@/infrastructure/logging/logger'

const logger = getLogger('Serve')

// Past this the pid a marker names is assumed recycled. Guessing wrong in
// either direction costs one tab.
const MARKER_TTL_MS = 12 * 60 * 60 * 1000

// `OPEN_BROWSER` decides outright when set; otherwise this follows dev mode —
// or the executable, where the browser *is* the UI. Someone who double-clicked
// an icon has no terminal to read a URL out of, and the exe has no equivalent of
// the native window the PyInstaller build shipped.
export function resolveOpenBrowser(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = env.OPEN_BROWSER?.trim().toLowerCase()
  if (explicit === 'true' || explicit === '1') return true
  if (explicit === 'false' || explicit === '0') return false
  if (IS_BUNDLED_EXE) return true
  return env.FRONTEND_DEV?.trim().toLowerCase() === 'true'
}

// Chrome by name precedes the default-browser opener, which stays last so a
// machine without Chrome still gets a page. `wslview` is for WSL.
//
// Chrome is asked for `--app=<url>`: a window with no address bar, no tab strip
// and no back button, which is what the app should look like when the browser
// *is* the UI. Every fallback below the Chrome entries opens an ordinary tab —
// only Chromium understands the flag.
export function browserCommands(platform: NodeJS.Platform, url: string): string[][] {
  const app = `--app=${url}`
  switch (platform) {
    case 'darwin':
      // The binary directly, not `open -a`: `open` forwards `--args` only when
      // it *starts* the app, so with Chrome already running it would activate
      // the existing window and drop the flag on the floor. Invoking the binary
      // hands the flag to the running instance, which opens the app window.
      return [
        ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', app],
        ['open', '-a', 'Google Chrome', url],
        ['open', url],
      ]
    case 'win32':
      // `start` is a cmd builtin, not an executable, and its first quoted
      // argument is taken as the window title — hence the empty one.
      return [
        ['cmd', '/c', 'start', '', 'chrome', app],
        ['cmd', '/c', 'start', '', url],
      ]
    default:
      return [
        ['google-chrome', app],
        ['google-chrome-stable', app],
        ['chromium', app],
        ['chromium-browser', app],
        ['wslview', url],
        ['xdg-open', url],
      ]
  }
}

// Keyed on the pid, not the port: the port can change across a restart, the
// pid is stable for the lifetime of one `bun --watch` supervisor.
export function markerPath(pid: number = process.pid, dir: string = tmpdir()): string {
  return join(dir, `claudeworld-browser-${pid}`)
}

// The URL is compared, not just the marker: a restart can land on a different
// port, leaving the old tab pointing at a dead one.
function alreadyOpened(path: string, url: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs >= MARKER_TTL_MS) return false
    return readFileSync(path, 'utf8').trim() === url
  } catch {
    return false
  }
}

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform
  /** Resolves a command name to an executable path, or null. Injected for tests. */
  which?: (command: string) => string | null
  /** Fire-and-forget launcher. Injected for tests. */
  spawn?: (argv: string[]) => void
  /** Marker file guarding against `bun --watch` reopening a tab on every save. */
  marker?: string | null
}

// Nothing is awaited — a launch that starts a fresh browser lives as long as
// the browsing session — and the child is unref'd so it cannot hold the event
// loop open at shutdown.
export function openBrowser(url: string, options: OpenBrowserOptions = {}): string[] | null {
  const {
    platform = process.platform,
    which = (command: string) => Bun.which(command),
    marker = markerPath(),
  } = options

  const spawn =
    options.spawn ??
    ((argv: string[]) => {
      const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      child.unref()
    })

  if (marker && alreadyOpened(marker, url)) return null

  const argv = browserCommands(platform, url).find(([command]) => command !== undefined && which(command) !== null)
  if (!argv) {
    logger.warning(`No browser found to open ${url} — open it manually, or set OPEN_BROWSER=false`)
    return null
  }

  try {
    spawn(argv)
  } catch (error) {
    logger.warning(`Could not open ${url} in a browser: ${String(error)}`)
    return null
  }

  // Written only after a successful launch, so a failure this run does not
  // suppress the attempt on the next restart.
  if (marker) {
    try {
      writeFileSync(marker, `${url}\n`)
    } catch {
      // A read-only temp directory costs a duplicate tab per reload, nothing more.
    }
  }

  logger.info(`🧭 Opening ${url} in ${argv[0]}`)
  return argv
}
