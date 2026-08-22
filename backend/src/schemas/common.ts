// Shared schema primitives. The wire contract is frozen, and clients rely on
// coercions Zod does not do by default (`"5"` for an int, `"yes"` for a bool).

import { z } from 'zod'

const TWO = (n: number) => String(n).padStart(2, '0')

// The wire format for every timestamp, and both details are observable: UTC is
// a trailing `Z`, never `+00:00`, and the fraction is omitted entirely at zero
// microseconds, otherwise exactly six digits.
export function serializeUtcDatetime(dt: Date): string {
  const date = `${dt.getUTCFullYear()}-${TWO(dt.getUTCMonth() + 1)}-${TWO(dt.getUTCDate())}`
  const time = `${TWO(dt.getUTCHours())}:${TWO(dt.getUTCMinutes())}:${TWO(dt.getUTCSeconds())}`
  const ms = dt.getUTCMilliseconds()
  const fraction = ms === 0 ? '' : `.${String(ms).padStart(3, '0')}000`
  return `${date}T${time}${fraction}Z`
}

export function serializeOptionalUtcDatetime(dt: Date | null | undefined): string | null {
  return dt ? serializeUtcDatetime(dt) : null
}

/** Folds `null` — a column never written — into `false` for the response. */
export function serializeBool(value: unknown): boolean {
  return Boolean(value)
}

// For a field required in the schema but NULL-able in the DDL. Every insert
// writes these, so a NULL means a foreign row: 500 rather than invent an epoch
// timestamp. Defaulted scalars do fold NULL into their default instead.
export function requiredTimestamp(dt: Date | null | undefined, model: string, field: string): string {
  if (!dt) throw new Error(`${model}.${field} is required but the column is NULL`)
  return serializeUtcDatetime(dt)
}

/** Response-side only; exists to make the contract checkable in tests. */
export const isoDatetime = () => z.iso.datetime()

// Lax coercions: `true` → `1`, `1.0` and `"1.0"` accepted, `1.5` / `"1.5"` /
// `"1e3"` / `""` rejected. Bare `z.int()` would 422 a client sending `"5"`.
export const pydanticInt = () => z.preprocess(coerceInt, z.int())

export const optionalInt = () => pydanticInt().nullable().default(null)

// A fixed vocabulary — `0/off/f/false/n/no`, `1/on/t/true/y/yes`,
// case-insensitive — plus exactly `0` and `1`. `2` is an error, not truthy.
export const pydanticBool = () => z.preprocess(coerceBool, z.boolean())

export const optionalBool = () => pydanticBool().nullable().default(null)

/** A nullable string. Nothing is ever coerced *into* a string on the wire. */
export const optionalString = () => z.string().nullable().default(null)

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

// Both a parse failure and a shape mismatch land on `null`: a malformed blob
// in one row should cost that field, not 500 the whole request.
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
