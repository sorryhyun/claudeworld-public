/**
 * Port selection: the preferred port, the fallback, and remembering it.
 *
 * These bind real sockets — the whole behaviour under test is what `Bun.serve`
 * does when a port is taken, which no fake reproduces. Each test asks the OS
 * for its own occupied port rather than hardcoding one, so the file is safe
 * under `--parallel` alongside everything else.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listen, stickyPortPath } from '../http/serve'

const OK = (): Response => new Response('ok')

const servers: Bun.Server<unknown>[] = []
const dirs: string[] = []

/** A listener whose only job is to hold a port, so the next bind collides. */
function occupyPort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: OK })
  servers.push(server)
  return server.port ?? 0
}

function start(port: number, stickyPortFile: string | null): Bun.Server<unknown> {
  const server = listen({ hostname: '127.0.0.1', port, stickyPortFile, fetch: OK })
  servers.push(server)
  return server
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-listen-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (servers.length) servers.pop()?.stop(true)
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('listen', () => {
  test('takes the preferred port when it is free', () => {
    const server = start(0, null)
    expect(server.port).toBeGreaterThan(0)
  })

  test('falls back instead of dying when the preferred port is taken', () => {
    const taken = occupyPort()
    const server = start(taken, null)

    expect(server.port).toBeGreaterThan(0)
    expect(server.port).not.toBe(taken)
  })

  test('records the fallback port so a watch restart can keep the URL', () => {
    const file = join(scratchDir(), 'port')
    const taken = occupyPort()
    const first = start(taken, file)
    // Read back before stopping: `Server.port` reports 0 once it is closed.
    const relocated = first.port

    expect(readFileSync(file, 'utf8').trim()).toBe(String(relocated))

    // The restart: the previous listener is gone, the collision on the
    // preferred port is not, and the browser tab is still on `relocated`.
    servers.splice(servers.indexOf(first), 1)
    first.stop(true)
    expect(start(taken, file).port).toBe(relocated)
  })

  test('a remembered port that someone else has taken is given up, not fought over', () => {
    const file = join(scratchDir(), 'port')
    const taken = occupyPort()
    const alsoTaken = occupyPort()
    writeFileSync(file, `${alsoTaken}\n`)

    const server = start(taken, file)
    expect(server.port).not.toBe(taken)
    expect(server.port).not.toBe(alsoTaken)
    // …and the new one replaces it, so the next restart follows the tab here.
    expect(readFileSync(file, 'utf8').trim()).toBe(String(server.port))
  })

  test('an unreadable or nonsense memory is simply ignored', () => {
    const dir = scratchDir()
    const garbage = join(dir, 'port')
    writeFileSync(garbage, 'not-a-port\n')
    const taken = occupyPort()

    expect(start(taken, garbage).port).toBeGreaterThan(0)
    expect(start(taken, join(dir, 'missing')).port).toBeGreaterThan(0)
  })

  test('a non-EADDRINUSE failure still propagates', () => {
    // Port 1 is privileged; binding it unprivileged is EACCES, which must not
    // be quietly turned into "listening somewhere else".
    expect(() => start(1, null)).toThrow()
  })
})

describe('stickyPortPath', () => {
  test('is scoped to one run by pid, like the browser marker', () => {
    expect(stickyPortPath(4321, '/tmp')).toBe('/tmp/claudeworld-port-4321')
    expect(stickyPortPath()).toContain(String(process.pid))
  })
})
