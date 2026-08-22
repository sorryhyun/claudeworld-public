/**
 * Drift gate, run in CI: builds a database from nothing but the committed
 * migrations and asserts the result matches `src/db/schema.ts`. It catches an
 * edit to `schema.ts` without `bun run migration-new` — the one drift that is
 * otherwise invisible until a fresh install breaks in production.
 * `--against <db>` additionally diffs against a real database, which makes it
 * a local check rather than a CI one.
 */

import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeDeclaredSchema, describeLiveSchema, diffSchemas, type SchemaDiff } from '../db/introspect'
import { applyMigrations, loadMigrations } from '../db/migrate'

const args = process.argv.slice(2)
const againstIndex = args.indexOf('--against')
const referenceDb = againstIndex === -1 ? null : args[againstIndex + 1]

if (againstIndex !== -1 && !referenceDb) {
  console.error('usage: bun src/scripts/check-migrations.ts [--against <path-to-db>]')
  process.exit(2)
}

function report(title: string, diffs: SchemaDiff[]): number {
  const fatal = diffs.filter((d) => d.severity === 'fatal')
  const cosmetic = diffs.filter((d) => d.severity === 'cosmetic')

  if (diffs.length === 0) {
    console.log(`✓ ${title}`)
    return 0
  }

  console.error(`✗ ${title}`)
  for (const diff of fatal) console.error(`    FATAL    ${diff.description}`)
  for (const diff of cosmetic) console.error(`    DIFF     ${diff.description}`)
  return diffs.length
}

const workDir = mkdtempSync(join(tmpdir(), 'cw-migration-check-'))
let failures = 0

try {
  const migrations = loadMigrations()
  console.log(`Applying ${migrations.length} migration(s) to a fresh database…`)

  const freshPath = join(workDir, 'fresh.db')
  const fresh = new Database(freshPath, { create: true, strict: true })
  fresh.exec('PRAGMA foreign_keys = ON')
  applyMigrations(fresh, migrations)

  // Strict: both sides are Drizzle artifacts, so no cross-dialect leniency.
  failures += report(
    'migrations produce the schema src/db/schema.ts declares',
    diffSchemas(describeDeclaredSchema(), describeLiveSchema(fresh), {
      expectedLabel: 'schema.ts',
      actualLabel: 'migrations',
    }),
  )

  if (referenceDb) {
    const reference = new Database(referenceDb, { readonly: true, create: false, strict: true })
    // Lenient: an existing database may spell the same types differently.
    failures += report(
      `migrations match the live schema of ${referenceDb}`,
      diffSchemas(describeLiveSchema(reference), describeLiveSchema(fresh), {
        allowCrossDialect: true,
        expectedLabel: 'reference',
        actualLabel: 'migrations',
      }),
    )
    reference.close()
  }

  fresh.close()
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

if (failures === 0) {
  console.log('\nPASS')
  process.exit(0)
}

console.error(
  `\nFAIL (${failures} difference(s))\n` +
    'If src/db/schema.ts changed on purpose, generate a migration:\n' +
    "  bun run migration-new -- --name=<description>",
)
process.exit(1)
