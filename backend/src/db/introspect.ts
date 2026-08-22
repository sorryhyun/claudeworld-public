/**
 * Schema introspection and diffing.
 *
 * This is the machinery behind the drift gate. Python gets it for free —
 * `alembic check` autogenerates a diff between `models.py` and a live database
 * — and Drizzle has no equivalent, so the comparison is written out here.
 *
 * Two comparisons matter and they are not the same:
 *
 * 1. **Migrations vs `src/db/schema.ts`.** Both are TypeScript-side artifacts,
 *    so the comparison can be exact. This is what fails when someone edits
 *    `schema.ts` and forgets to run `drizzle-kit generate`.
 * 2. **Migrations vs a real Python-created database.** SQLAlchemy writes
 *    `VARCHAR` and `BOOLEAN` where Drizzle writes `text` and `integer`, and
 *    Drizzle cannot be made to emit the former. Here the comparison has to be
 *    on SQLite's *affinity* rules plus a short, named list of equivalences.
 */

import type { Database } from 'bun:sqlite'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'

import * as schema from './schema'

// ============================================================================
// Descriptions
// ============================================================================

export interface ColumnDescription {
  name: string
  /** The declared type as written in the DDL, e.g. `VARCHAR(32)`. */
  declaredType: string
  notNull: boolean
  primaryKey: boolean
  /** Default expression as SQLite reports it, or null for no DDL default. */
  defaultValue: string | null
}

export interface IndexDescription {
  name: string
  unique: boolean
  columns: string[]
  /**
   * True for a `sqlite_autoindex_*`: an index SQLite created implicitly for an
   * inline `UNIQUE` constraint, whose name is an artefact of declaration order
   * rather than anything anyone chose.
   */
  implicit: boolean
}

export interface TableDescription {
  name: string
  columns: Map<string, ColumnDescription>
  indexes: Map<string, IndexDescription>
}

export type SchemaDescription = Map<string, TableDescription>

// ============================================================================
// SQLite type affinity
// ============================================================================

export type Affinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC'

/**
 * SQLite's five affinity rules, applied in order, from §3.1 of the datatype
 * documentation. This is what makes `VARCHAR`, `text(9)` and `TEXT` compare
 * equal — SQLite itself does not distinguish them.
 */
export function typeAffinity(declaredType: string): Affinity {
  const type = declaredType.toUpperCase()
  if (type.includes('INT')) return 'INTEGER'
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT'
  if (type === '' || type.includes('BLOB')) return 'BLOB'
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

/**
 * Type pairs that mean the same thing across the two ORMs but land in different
 * affinity classes.
 *
 * `BOOLEAN` is NUMERIC affinity and `INTEGER` is INTEGER affinity, so the rules
 * above call them different. They are not, for this data: both store the
 * integers 0 and 1 and read back as the integers 0 and 1. Drizzle has no way to
 * emit `BOOLEAN`, so this pair cannot be designed away — only written down.
 *
 * Nothing else belongs here. A new entry means a real difference is being
 * declared invisible, which is exactly what this gate exists to prevent.
 */
const CROSS_DIALECT_EQUIVALENTS: ReadonlyArray<readonly [Affinity, Affinity]> = [
  ['NUMERIC', 'INTEGER'],
]

function affinitiesMatch(left: string, right: string, allowCrossDialect: boolean): boolean {
  const a = typeAffinity(left)
  const b = typeAffinity(right)
  if (a === b) return true
  if (!allowCrossDialect) return false
  return CROSS_DIALECT_EQUIVALENTS.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x),
  )
}

/** `DEFAULT 0` and `DEFAULT false` are the same clause written two ways. */
function defaultsMatch(left: string | null, right: string | null): boolean {
  const normalize = (value: string | null): string | null => {
    if (value === null) return null
    const trimmed = value.trim().toLowerCase().replace(/^\((.*)\)$/, '$1')
    if (trimmed === 'false') return '0'
    if (trimmed === 'true') return '1'
    return trimmed
  }
  return normalize(left) === normalize(right)
}

// ============================================================================
// Reading a live database
// ============================================================================

interface TableInfoRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

interface IndexListRow {
  name: string
  unique: number
}

interface IndexInfoRow {
  name: string | null
}

/**
 * Describe every application table in a live database.
 *
 * `sqlite_autoindex_*` entries are kept but flagged implicit, with one
 * exception: the one backing the table's own primary key, which is not a
 * separate constraint and would otherwise read as an extra index on every table
 * with a composite or text primary key.
 *
 * They are kept rather than skipped because they carry real information —
 * SQLAlchemy declares `player_states.world_id` unique *inline* and gets an
 * autoindex where Drizzle emits a named `CREATE UNIQUE INDEX` for the same
 * constraint. Dropping them would leave that constraint unverified in one
 * direction; keeping them and matching implicit indexes on their columns
 * instead of their names (see {@link diffSchemas}) verifies it without
 * demanding a name SQLite chose.
 */
export function describeLiveSchema(sqlite: Database, skipTables: readonly string[] = []): SchemaDescription {
  const skip = new Set(['sqlite_sequence', '__drizzle_migrations', ...skipTables])

  const tableNames = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
    .filter((name) => !skip.has(name))

  const description: SchemaDescription = new Map()

  for (const table of tableNames) {
    const columns = new Map<string, ColumnDescription>()
    for (const row of sqlite.query<TableInfoRow, []>(`PRAGMA table_info("${table}")`).all()) {
      columns.set(row.name, {
        name: row.name,
        declaredType: row.type,
        notNull: row.notnull === 1,
        primaryKey: row.pk > 0,
        defaultValue: row.dflt_value,
      })
    }

    const primaryKeyColumns = [...columns.values()]
      .filter((column) => column.primaryKey)
      .map((column) => column.name)
      .sort()
      .join(',')

    const indexes = new Map<string, IndexDescription>()
    for (const row of sqlite.query<IndexListRow, []>(`PRAGMA index_list("${table}")`).all()) {
      const implicit = row.name.startsWith('sqlite_autoindex_')
      const columnNames = sqlite
        .query<IndexInfoRow, []>(`PRAGMA index_info("${row.name}")`)
        .all()
        .map((info) => info.name)
        .filter((name): name is string => name !== null)

      if (implicit && [...columnNames].sort().join(',') === primaryKeyColumns) continue

      indexes.set(row.name, {
        name: row.name,
        unique: row.unique === 1,
        columns: columnNames,
        implicit,
      })
    }

    description.set(table, { name: table, columns, indexes })
  }

  return description
}

// ============================================================================
// Reading src/db/schema.ts
// ============================================================================

function isSqliteTable(value: unknown): value is SQLiteTable {
  // Drizzle brands its tables with a symbol; probing the config accessor is the
  // supported way to tell a table export from an enum or a relations object.
  try {
    return typeof value === 'object' && value !== null && typeof getTableConfig(value as SQLiteTable).name === 'string'
  } catch {
    return false
  }
}

/** Describe the schema as `src/db/schema.ts` declares it. */
export function describeDeclaredSchema(): SchemaDescription {
  const description: SchemaDescription = new Map()

  for (const value of Object.values(schema)) {
    if (!isSqliteTable(value)) continue
    const config = getTableConfig(value)

    const columns = new Map<string, ColumnDescription>()
    for (const column of config.columns) {
      columns.set(column.name, {
        name: column.name,
        declaredType: column.getSQLType(),
        notNull: column.notNull,
        primaryKey: column.primary,
        // `hasDefault` is also true for `$defaultFn` columns, which produce no
        // DDL clause at all — only a literal `default` value does.
        defaultValue: renderDefault(column.default),
      })
    }
    // Composite primary keys are declared at table level, not on the columns.
    for (const primaryKey of config.primaryKeys) {
      for (const column of primaryKey.columns) {
        const existing = columns.get(column.name)
        if (existing) existing.primaryKey = true
      }
    }

    const indexes = new Map<string, IndexDescription>()
    for (const index of config.indexes) {
      const indexConfig = index.config
      const columnNames = (indexConfig.columns ?? [])
        .map((column) => (typeof column === 'object' && column !== null && 'name' in column
          ? String((column as { name: unknown }).name)
          : null))
        .filter((name): name is string => name !== null)
      indexes.set(indexConfig.name, {
        name: indexConfig.name,
        unique: indexConfig.unique === true,
        columns: columnNames,
        implicit: false,
      })
    }
    for (const unique of config.uniqueConstraints) {
      indexes.set(unique.name ?? `${config.name}_unique`, {
        name: unique.name ?? `${config.name}_unique`,
        unique: true,
        columns: unique.columns.map((column) => column.name),
        implicit: false,
      })
    }
    // Column-level `.unique()` is recorded on the column, not in
    // `uniqueConstraints`, and drizzle-kit emits it as a named unique index.
    for (const column of config.columns) {
      if (!column.isUnique) continue
      const name = column.uniqueName ?? `${config.name}_${column.name}_unique`
      indexes.set(name, { name, unique: true, columns: [column.name], implicit: false })
    }

    description.set(config.name, { name: config.name, columns, indexes })
  }

  return description
}

/** Render a Drizzle column default the way SQLite would report it, or null. */
function renderDefault(value: unknown): string | null {
  if (value === undefined) return null
  if (value === null) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') return `'${value}'`
  // An `sql` template: the queryChunks hold the literal text.
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks
  if (Array.isArray(chunks)) {
    return chunks
      .map((chunk) => (typeof chunk === 'object' && chunk !== null && 'value' in chunk
        ? String((chunk as { value: unknown }).value)
        : String(chunk)))
      .join('')
      .replace(/,/g, '')
      .trim()
  }
  return String(value)
}

// ============================================================================
// Diffing
// ============================================================================

export type DiffSeverity = 'fatal' | 'cosmetic'

export interface SchemaDiff {
  severity: DiffSeverity
  description: string
}

export interface DiffOptions {
  /**
   * Accept the SQLAlchemy/Drizzle type spellings in
   * {@link CROSS_DIALECT_EQUIVALENTS}. On when comparing against a
   * Python-created database, off when comparing two Drizzle-created ones.
   */
  allowCrossDialect?: boolean
  /** Label for the `expected` side in messages. */
  expectedLabel?: string
  /** Label for the `actual` side in messages. */
  actualLabel?: string
}

/**
 * Compare two schema descriptions.
 *
 * The fatal/cosmetic split mirrors `alembic_runner._FATAL_DIFF_KINDS`: a
 * missing table or column means the code will reference something that is not
 * there, and nothing else does. Everything else is reported so it cannot be
 * silently accumulated, but does not by itself fail a boot.
 */
export function diffSchemas(
  expected: SchemaDescription,
  actual: SchemaDescription,
  { allowCrossDialect = false, expectedLabel = 'expected', actualLabel = 'actual' }: DiffOptions = {},
): SchemaDiff[] {
  const diffs: SchemaDiff[] = []

  for (const [tableName, expectedTable] of expected) {
    const actualTable = actual.get(tableName)
    if (!actualTable) {
      diffs.push({ severity: 'fatal', description: `missing table '${tableName}'` })
      continue
    }

    for (const [columnName, expectedColumn] of expectedTable.columns) {
      const actualColumn = actualTable.columns.get(columnName)
      if (!actualColumn) {
        diffs.push({ severity: 'fatal', description: `missing column '${tableName}.${columnName}'` })
        continue
      }

      if (!affinitiesMatch(expectedColumn.declaredType, actualColumn.declaredType, allowCrossDialect)) {
        diffs.push({
          severity: 'cosmetic',
          description:
            `type differs on '${tableName}.${columnName}': ` +
            `${expectedLabel} ${expectedColumn.declaredType}, ${actualLabel} ${actualColumn.declaredType}`,
        })
      }
      if (expectedColumn.notNull !== actualColumn.notNull) {
        diffs.push({
          severity: 'cosmetic',
          description:
            `nullability differs on '${tableName}.${columnName}': ` +
            `${expectedLabel} ${expectedColumn.notNull ? 'NOT NULL' : 'nullable'}, ` +
            `${actualLabel} ${actualColumn.notNull ? 'NOT NULL' : 'nullable'}`,
        })
      }
      if (expectedColumn.primaryKey !== actualColumn.primaryKey) {
        diffs.push({
          severity: 'cosmetic',
          description: `primary key differs on '${tableName}.${columnName}'`,
        })
      }
      if (!defaultsMatch(expectedColumn.defaultValue, actualColumn.defaultValue)) {
        diffs.push({
          severity: 'cosmetic',
          description:
            `default differs on '${tableName}.${columnName}': ` +
            `${expectedLabel} ${expectedColumn.defaultValue ?? 'none'}, ` +
            `${actualLabel} ${actualColumn.defaultValue ?? 'none'}`,
        })
      }
    }

    for (const columnName of actualTable.columns.keys()) {
      if (!expectedTable.columns.has(columnName)) {
        diffs.push({
          severity: 'cosmetic',
          description: `extra column '${tableName}.${columnName}' in ${actualLabel}`,
        })
      }
    }

    // An inline `UNIQUE` on one side and a named unique index on the other are
    // the same constraint. Pair those up on their columns first, so what is
    // left can be matched strictly by name.
    const unmatchedExpected = new Map(expectedTable.indexes)
    const unmatchedActual = new Map(actualTable.indexes)
    // Symmetric: either side may be the one that declared the constraint inline.
    const pairImplicitByColumns = (
      implicitSide: Map<string, IndexDescription>,
      namedSide: Map<string, IndexDescription>,
      namedSideAll: Map<string, IndexDescription>,
    ): void => {
      for (const [implicitName, implicitIndex] of [...implicitSide]) {
        if (!implicitIndex.implicit || !implicitIndex.unique) continue
        const counterpart = [...namedSide.values()].find(
          (candidate) =>
            candidate.unique &&
            !namedSideAll.has(implicitName) &&
            candidate.columns.join(',') === implicitIndex.columns.join(','),
        )
        if (!counterpart) continue
        implicitSide.delete(implicitName)
        namedSide.delete(counterpart.name)
      }
    }
    pairImplicitByColumns(unmatchedActual, unmatchedExpected, expectedTable.indexes)
    pairImplicitByColumns(unmatchedExpected, unmatchedActual, actualTable.indexes)

    for (const [indexName, expectedIndex] of unmatchedExpected) {
      const actualIndex = unmatchedActual.get(indexName)
      if (!actualIndex) {
        diffs.push({ severity: 'cosmetic', description: `missing index '${indexName}' on '${tableName}'` })
        continue
      }
      if (expectedIndex.unique !== actualIndex.unique) {
        diffs.push({ severity: 'cosmetic', description: `uniqueness differs on index '${indexName}'` })
      }
      if (expectedIndex.columns.join(',') !== actualIndex.columns.join(',')) {
        diffs.push({
          severity: 'cosmetic',
          description:
            `columns differ on index '${indexName}': ` +
            `${expectedLabel} (${expectedIndex.columns.join(', ')}), ` +
            `${actualLabel} (${actualIndex.columns.join(', ')})`,
        })
      }
    }

    for (const indexName of unmatchedActual.keys()) {
      if (!unmatchedExpected.has(indexName)) {
        diffs.push({ severity: 'cosmetic', description: `extra index '${indexName}' in ${actualLabel}` })
      }
    }
  }

  for (const tableName of actual.keys()) {
    if (!expected.has(tableName)) {
      diffs.push({ severity: 'cosmetic', description: `extra table '${tableName}' in ${actualLabel}` })
    }
  }

  return diffs
}
