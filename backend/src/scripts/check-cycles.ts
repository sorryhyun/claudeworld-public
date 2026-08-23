/**
 * Fail on any import cycle among the src/ modules (tests and scripts excluded —
 * they are leaves nothing imports back from). Regex-based rather than a parser:
 * internal imports in this codebase are all static `from '...'` or dynamic
 * `import('...')` with relative or `@/` (src-rooted) specifiers, which the
 * pattern below covers.
 * Type-only imports are stripped first — they are erased at compile time and
 * cannot create a runtime cycle. Wired into `bun run lint` beside eslint's
 * boundary rules, which cannot see cycles.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..')
const SKIP_TOP_LEVEL = new Set(['tests', 'scripts'])

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (dir === SRC && SKIP_TOP_LEVEL.has(entry)) continue
      collect(full, out)
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

const TYPE_ONLY_RE = /(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"]/g
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]((?:\.\.?|@)\/[^'"]+)['"]/g

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier)
  for (const candidate of [base.endsWith('.ts') ? base : `${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not this candidate.
    }
  }
  return null
}

const files = collect(SRC)
const graph = new Map<string, string[]>()

for (const file of files) {
  const source = readFileSync(file, 'utf-8').replace(TYPE_ONLY_RE, '')
  const deps: string[] = []
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1]
    if (specifier === undefined) continue
    const dep = resolveSpecifier(file, specifier)
    if (dep !== null) deps.push(dep)
  }
  graph.set(file, deps)
}

const state = new Map<string, 'active' | 'done'>()
const stack: string[] = []
const cycles: string[][] = []

function visit(node: string): void {
  state.set(node, 'active')
  stack.push(node)
  for (const dep of graph.get(node) ?? []) {
    const seen = state.get(dep)
    if (seen === 'done') continue
    if (seen === 'active') {
      cycles.push([...stack.slice(stack.indexOf(dep)), dep])
      continue
    }
    visit(dep)
  }
  stack.pop()
  state.set(node, 'done')
}

for (const file of files) {
  if (!state.has(file)) visit(file)
}

if (cycles.length > 0) {
  console.error(`Found ${cycles.length} import cycle(s):`)
  for (const cycle of cycles) {
    console.error(`  ${cycle.map((f) => relative(SRC, f)).join(' -> ')}`)
  }
  process.exit(1)
}

console.log(`No import cycles across ${files.length} modules.`)
