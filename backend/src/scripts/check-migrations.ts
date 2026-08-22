/**
 * Drift gate: builds a database from the committed migrations and diffs it
 * against `schema.ts`. Runs in CI.
 *
 * Builds a database from nothing but the committed migrations and asserts that
 * the result is the schema `src/db/schema.ts` describes. That is the guarantee
 * a schema dump alone cannot give: `verify-schema.ts` proves the mirror can
 * read a database that already exists, this proves a *fresh install* converges
 * on the same schema an upgraded one has.
 *
 * It fails when someone edits `schema.ts` and forgets `bun run migration-new`,
 * which is the one drift that is otherwise invisible until a fresh install
 * breaks in production.
 *
 *     bun src/scripts/check-migrations.ts
 *     bun src/scripts/check-migrations.ts --against /path/to/claudeworld.db
 *
 * With `--against`, the fresh schema is additionally compared to a real
 * Python-created database — the cross-backend half of the contract. That run
 * needs a database to hand, so it is a local check rather than a CI one.
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
    // Lenient: the reference was written by SQLAlchemy, which spells the same
    // types differently and has no way to be made to spell them the same.
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
