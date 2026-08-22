/**
 * Opening a browser at the URL the server actually won.
 *
 * This exists *because* the port is negotiable. `listen()` falls back to an
 * OS-assigned port when the preferred one is taken, so the only place that
 * knows where to point a browser is the process that just bound the socket —
 * a `make dev` recipe cannot hardcode the URL it prints any more than the Vite
 * proxy could hardcode the backend's. Launching from here closes that gap: the
 * tab always lands on the port in use, relocated or not.
 *
 * Two properties are deliberate:
 *
 * - **Never fatal.** No browser, no display, a container with neither — none of
 *   those are reasons for a dev server to fail. Every failure path logs at
 *   most a warning and returns.
 * - **Once per `make dev`, not once per reload.** `bun --watch` re-runs the
 *   whole module graph on every save while keeping the same pid, so an
 *   in-process flag resets and a naive implementation opens a tab on every
 *   keystroke-triggered restart. The marker file below is keyed on that stable
 *   pid, which is exactly the "one `make dev` invocation" scope wanted.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('Serve')

/**
 * How long a marker file is believed.
 *
 * Beyond this the pid it names is assumed to have been recycled by an
 * unrelated process, so a fresh `make dev` that happens to land on it still
 * gets its tab. The cost of guessing wrong in either direction is one tab.
 */
const MARKER_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Whether to open a browser at startup.
 *
 * `OPEN_BROWSER` decides it outright when set; otherwise it follows dev mode,
 * because that is the run mode whose whole point is a person sitting in front
 * of the page. `make serve`, `make run-backend`, the packaged build and the
 * test suite all leave `FRONTEND_DEV` unset and are left alone.
 */
export function resolveOpenBrowser(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = env.OPEN_BROWSER?.trim().toLowerCase()
  if (explicit === 'true' || explicit === '1') return true
  if (explicit === 'false' || explicit === '0') return false
  return env.FRONTEND_DEV?.trim().toLowerCase() === 'true'
}

/**
 * Candidate launch commands, most specific first.
 *
 * Chrome by name comes before the desktop's default-browser opener on every
 * platform: the request is for Chrome, and `xdg-open`/`open`/`start` honour
 * whatever the user set as default instead. The generic opener stays on the
 * list as the last resort so a machine without Chrome still gets a page rather
 * than nothing.
 *
 * WSL is the reason `wslview` appears among the Linux candidates — there the
 * browser lives on the Windows side and no Linux binary will be found.
 */
export function browserCommands(platform: NodeJS.Platform, url: string): string[][] {
  switch (platform) {
    case 'darwin':
      return [
        ['open', '-a', 'Google Chrome', url],
        ['open', url],
      ]
    case 'win32':
      // `start` is a cmd builtin, not an executable, and its first quoted
      // argument is taken as the window title — hence the empty one.
      return [
        ['cmd', '/c', 'start', '', 'chrome', url],
        ['cmd', '/c', 'start', '', url],
      ]
    default:
      return [
        ['google-chrome', url],
        ['google-chrome-stable', url],
        ['chromium', url],
        ['chromium-browser', url],
        ['wslview', url],
        ['xdg-open', url],
      ]
  }
}

/**
 * The marker whose existence means "this run already opened a tab".
 *
 * Keyed on the pid rather than the port: the port can change across a restart
 * (the previous listener has not always released it yet), while the pid is
 * stable for the lifetime of one `bun --watch` supervisor.
 */
export function markerPath(pid: number = process.pid, dir: string = tmpdir()): string {
  return join(dir, `claudeworld-browser-${pid}`)
}

/**
 * True when this run already opened a tab on exactly this URL.
 *
 * The URL is compared, not merely the marker's existence, because a relocated
 * port is not guaranteed to survive a restart — `listen()` tries hard to keep
 * it, and when it cannot the old tab is pointing at a dead port and a new one
 * is the only useful thing to do.
 */
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

/**
 * Launch a browser at `url`. Returns the argv used, or null if nothing ran.
 *
 * Nothing is awaited. A `google-chrome <url>` that starts a *fresh* browser
 * stays alive for the whole browsing session, so waiting on its exit would
 * hang the server's startup path for as long as the user keeps the window
 * open; the launched process is unref'd so it also cannot hold the server's
 * event loop open at shutdown.
 */
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

  // `cmd` on Windows and `open` on macOS are always present; on Linux the
  // whole point of the candidate list is that most of it is not.
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
