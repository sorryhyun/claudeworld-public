/**
 * Shared schema primitives — port of `backend/schemas/common.py`, plus the
 * Pydantic-compatibility helpers the other four modules all need.
 *
 * `common.py` is only a mixin carrying four `@field_serializer`s. The mixin
 * itself has no counterpart here: Zod validates, it does not serialize, so the
 * work those serializers do (naive datetime → UTC ISO string, SQLite integer →
 * boolean) happens in the row → response mappers instead. The functions are
 * kept under the same names so the two backends read alike.
 *
 * The rest of this file exists because the parity contract is about *wire
 * behaviour*, not about field names. Pydantic in its default lax mode coerces
 * request input in ways Zod does not, and rejects input Zod would accept. A
 * request schema that is merely "the same fields" would quietly change which
 * requests succeed, which is exactly the kind of drift the frozen-contract rule
 * is there to prevent.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Serialization — the `common.py` mixin's job, moved to the mapper layer
// ---------------------------------------------------------------------------

const TWO = (n: number) => String(n).padStart(2, '0')

/**
 * `i18n/serializers.py::serialize_utc_datetime` followed by Pydantic's JSON
 * datetime encoder, collapsed into one step.
 *
 * The Python pair is: attach UTC to a naive datetime, then let pydantic-core
 * render it. That renderer has two behaviours worth naming, because both are
 * visible in the bytes the frontend receives:
 *
 * - UTC is written as a trailing `Z`, not `+00:00`;
 * - the fractional part is **omitted entirely** when the microsecond field is
 *   zero, and otherwise written as exactly six digits.
 *
 * **Known divergence, in the sub-millisecond digits only.** SQLAlchemy stores
 * microseconds (`…54.931812`) and `parseSqlaDateTime` hands them to a JS `Date`,
 * which truncates to milliseconds. Python emits `…54.931812Z` where this emits
 * `…54.931000Z`. `new Date(s)` in the browser parses both to the same instant,
 * and `src/db/columns.ts` already pads the same three zeroes on the way back
 * into the database, so the loss is a property of the port's clock resolution
 * rather than of this function. Nothing downstream compares these as strings.
 */
export function serializeUtcDatetime(dt: Date): string {
  const date = `${dt.getUTCFullYear()}-${TWO(dt.getUTCMonth() + 1)}-${TWO(dt.getUTCDate())}`
  const time = `${TWO(dt.getUTCHours())}:${TWO(dt.getUTCMinutes())}:${TWO(dt.getUTCSeconds())}`
  const ms = dt.getUTCMilliseconds()
  const fraction = ms === 0 ? '' : `.${String(ms).padStart(3, '0')}000`
  return `${date}T${time}${fraction}Z`
}

/** The `Optional[datetime]` serializers: `serialize(dt) if dt else None`. */
export function serializeOptionalUtcDatetime(dt: Date | null | undefined): string | null {
  return dt ? serializeUtcDatetime(dt) : null
}

/**
 * `i18n/serializers.py::serialize_bool` — `bool(value)`.
 *
 * It exists because SQLite hands back `0`/`1` for BOOLEAN columns and the
 * response must carry real JSON booleans. Drizzle's `{ mode: 'boolean' }`
 * already does that conversion, so in this port the function's remaining job is
 * folding `null` — a column that was never written — into `false`.
 */
export function serializeBool(value: unknown): boolean {
  return Boolean(value)
}

/**
 * A response field Pydantic declares as a bare `datetime`, read off a column
 * that is nullable.
 *
 * Every one of these — `Agent.created_at`, `Room.created_at`,
 * `WorldSummary.created_at` / `updated_at`, `Message.timestamp` — is required in
 * the schema and NULL-able in the DDL. Both backends write them on every insert,
 * so a NULL means a row that came from somewhere else, and Pydantic answers that
 * with a `ValidationError` → HTTP 500. Throwing here reproduces that rather than
 * inventing an epoch timestamp the frontend would render as 1970.
 *
 * Contrast the defaulted scalars (`is_paused: bool = False`, `priority: int = 0`)
 * where the mappers *do* fold NULL into the declared default: Pydantic raises on
 * those too, but only as an accident of `from_attributes` reading the attribute
 * as `None` instead of finding it absent. A default is written down for those
 * fields and none is written down for the timestamps.
 */
export function requiredTimestamp(dt: Date | null | undefined, model: string, field: string): string {
  if (!dt) throw new Error(`${model}.${field} is required but the column is NULL`)
  return serializeUtcDatetime(dt)
}

// ---------------------------------------------------------------------------
// Pydantic lax-mode parity for request bodies
// ---------------------------------------------------------------------------

/**
 * An ISO-8601 UTC timestamp as {@link serializeUtcDatetime} writes it.
 *
 * Response-side only: no request model in `backend/schemas/` carries a datetime
 * field, so nothing ever parses one of these off the wire. It is declared as a
 * schema anyway so the response contract is checkable in tests.
 */
export const isoDatetime = () => z.iso.datetime()

/**
 * `int` as Pydantic validates it in lax mode.
 *
 * Reproduced from a probe of pydantic 2.12, not from the docs, because the rule
 * set is unintuitive: `true` is a valid integer (→ `1`), so is `1.0` and so is
 * the string `"1.0"`, while `1.5`, `"1.5"`, `"1e3"` and `""` are all rejected.
 * `z.int()` accepts only the number, so a client that has always sent
 * `{"max_interactions": "5"}` would start getting a 422 at cutover.
 *
 * **One quirk deliberately not reproduced:** Python's int parser honours PEP 515
 * underscore separators, so Pydantic accepts `"1_0"` as `10`. Nothing sends that
 * and supporting it would mean carrying Python's numeral grammar into a
 * validator.
 */
export const pydanticInt = () => z.preprocess(coerceInt, z.int())

/** The `.nullable().default(null)` form, i.e. Pydantic's `Optional[int] = None`. */
export const optionalInt = () => pydanticInt().nullable().default(null)

/**
 * `bool` as Pydantic validates it in lax mode.
 *
 * The accepted strings are pydantic-core's fixed vocabulary — `0/off/f/false/n/no`
 * and `1/on/t/true/y/yes`, case-insensitive — plus the numbers `0` and `1`
 * exactly. `2` and `-1` are errors, not truthy; this is emphatically not
 * JavaScript's `Boolean()`.
 */
export const pydanticBool = () => z.preprocess(coerceBool, z.boolean())

/** The `.nullable().default(null)` form, i.e. Pydantic's `Optional[bool] = None`. */
export const optionalBool = () => pydanticBool().nullable().default(null)

/** `Optional[str] = None`. Pydantic never coerces *into* `str`, so neither do we. */
export const optionalString = () => z.string().nullable().default(null)

/** What Python's `int()` accepts from a string, minus the underscore form. */
const INT_LITERAL = /^[+-]?\d+(\.0*)?$/

function coerceInt(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!INT_LITERAL.test(trimmed)) return value
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) ? parsed : value
  }
  return value
}

const TRUE_STRINGS = new Set(['1', 'on', 't', 'true', 'y', 'yes'])
const FALSE_STRINGS = new Set(['0', 'off', 'f', 'false', 'n', 'no'])

function coerceBool(value: unknown): unknown {
  if (typeof value === 'number') {
    if (value === 0) return false
    if (value === 1) return true
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (TRUE_STRINGS.has(normalized)) return true
    if (FALSE_STRINGS.has(normalized)) return false
    return value
  }
  return value
}

// ---------------------------------------------------------------------------
// JSON TEXT columns
// ---------------------------------------------------------------------------

/**
 * Decode a TEXT column holding JSON and validate it against `schema`, or `null`.
 *
 * Six response fields are built this way — `Message.anthropic_calls`,
 * `Message.images`, `Message.game_time_snapshot`, `World.stat_definitions`,
 * `Location.adjacent_locations`, and the four on `PlayerState`. Python splits
 * the work in two: a `model_validator(mode="before")` runs `json.loads` inside a
 * `try/except` that falls back to `None`, and *then* Pydantic type-checks the
 * result. So a blob of `"not json"` yields `None`, but a blob of `"[1,2]"` in a
 * `List[str]` field passes the first stage and raises in the second — a 500 on a
 * message list because one row holds the wrong shape.
 *
 * **Deliberate divergence:** both failures land on `null` here. Softening the
 * second one is the whole reason this helper exists; a malformed blob in one row
 * should cost that field, not the request. The first-stage behaviour — which is
 * the one rows in the wild were actually written against — is unchanged.
 */
export function parseJsonColumn<T>(raw: string | null | undefined, schema: z.ZodType<T>): T | null {
  if (!raw) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }
  const result = schema.safeParse(decoded)
  return result.success ? result.data : null
}
