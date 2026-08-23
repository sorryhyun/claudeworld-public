/**
 * `make stop`, on every platform.
 *
 * The POSIX version was one `pkill -f` per pattern. Windows has neither pkill
 * nor any way to match on a command line from the shell -- `taskkill /IM
 * bun.exe` would take down every Bun process on the machine, this repo's server
 * or not -- so there each pattern becomes a Win32_Process query that filters on
 * the command line before killing anything.
 */

const isWindows = process.platform === 'win32'

interface Target {
  label: string
  /** `pkill -f` regex. */
  posix: string
  /** Image name plus a substring its command line must contain, or null for any. */
  windows: { image: string; commandLine: string | null }
}

// `bun --watch src/main.ts` and the child it supervises both match; the
// workspace runner that spawned them exits on its own once they are gone.
const TARGETS: Target[] = [
  {
    label: 'backend',
    posix: 'bun.*src/main\.ts',
    windows: { image: 'bun.exe', commandLine: 'main.ts' },
  },
  {
    label: 'cloudflared tunnel',
    posix: 'cloudflared',
    windows: { image: 'cloudflared.exe', commandLine: null },
  },
]

function stopPosix(target: Target): number {
  // pkill exits 1 when nothing matched, which is the normal case here.
  const proc = Bun.spawnSync(['pkill', '-f', target.posix], { stdout: 'ignore', stderr: 'ignore' })
  return proc.exitCode === 0 ? 1 : 0
}

function stopWindows(target: Target): number {
  const { image, commandLine } = target.windows
  const match = commandLine === null ? '' : ` -and $_.CommandLine -like '*${commandLine}*'`
  // Named in single quotes and matched on the image first, so this query cannot
  // find -- and kill -- the PowerShell process running it.
  const script =
    `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${image}'${match} }) | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }'
  const proc = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  return proc.stdout.toString().trim().split('\n').filter(Boolean).length
}

let stopped = 0
for (const target of TARGETS) {
  const count = isWindows ? stopWindows(target) : stopPosix(target)
  if (count > 0) console.log(`Stopped ${target.label}${isWindows ? ` (${count} process(es))` : ''}.`)
  stopped += count
}

console.log(stopped > 0 ? 'Servers stopped.' : 'Nothing to stop.')
