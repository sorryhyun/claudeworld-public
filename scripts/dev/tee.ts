/**
 * `tee` for the perf target's pipeline. cmd.exe has no tee and Bun's shell has
 * no builtin for it, but both cmd and sh spell `2>&1 | ...` the same way, so a
 * filter that copies stdin to stdout and to a file is all `make dev-perf`
 * needs to keep working off a PowerShell prompt.
 *
 * Usage: <producer> 2>&1 | bun scripts/dev/tee.ts run.log
 */

const path = Bun.argv[2]
if (!path) {
  console.error('usage: bun scripts/dev/tee.ts <file>')
  process.exit(2)
}

const file = Bun.file(path).writer()
try {
  for await (const chunk of Bun.stdin.stream()) {
    Bun.stdout.write(chunk)
    file.write(chunk)
    // Flushed per chunk: the producer is a long-running server and the point of
    // the log is to `tail -f` it while that server is still running.
    await file.flush()
  }
} finally {
  await file.end()
}
