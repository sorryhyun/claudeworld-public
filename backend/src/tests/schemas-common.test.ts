/**
 * The serialization and coercion primitives every other schema module leans on.
 *
 * The expected values here were taken from a probe of the live Python backend
 * (pydantic 2.12) rather than from documentation — the lax-mode rules in
 * particular are not what either language's intuition suggests.
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  isoDatetime,
  optionalBool,
  optionalInt,
  optionalString,
  parseJsonColumn,
  pydanticBool,
  pydanticInt,
  requiredTimestamp,
  serializeBool,
  serializeOptionalUtcDatetime,
  serializeUtcDatetime,
} from '@/schemas/common'

describe('serializeUtcDatetime', () => {
  test('writes UTC as a trailing Z, never as +00:00', () => {
    expect(serializeUtcDatetime(new Date('2026-08-06T04:14:54.931Z'))).toBe('2026-08-06T04:14:54.931000Z')
  })

  test('omits the fractional part entirely when there is none', () => {
    // Pydantic prints `2026-08-06T04:14:54Z`, not `...54.000000Z`.
    expect(serializeUtcDatetime(new Date('2026-08-06T04:14:54Z'))).toBe('2026-08-06T04:14:54Z')
  })

  test('pads a sub-100ms fraction to six digits', () => {
    expect(serializeUtcDatetime(new Date('2026-08-06T04:14:54.004Z'))).toBe('2026-08-06T04:14:54.004000Z')
  })

  test('renders in UTC regardless of the input offset', () => {
    expect(serializeUtcDatetime(new Date('2026-08-06T06:14:54+02:00'))).toBe('2026-08-06T04:14:54Z')
  })

  test('pads every component to two digits', () => {
    expect(serializeUtcDatetime(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05Z')
  })

  test('known divergence: microseconds below the millisecond are lost', () => {
    // Python emits `.931812Z` for this row; a JS Date cannot hold the 812.
    const fromSqlite = new Date('2026-08-06T04:14:54.931812Z')
    expect(serializeUtcDatetime(fromSqlite)).toBe('2026-08-06T04:14:54.931000Z')
  })

  test('output parses back to the same instant', () => {
    const dt = new Date('2026-08-06T04:14:54.931Z')
    expect(new Date(serializeUtcDatetime(dt)).getTime()).toBe(dt.getTime())
  })

  test('output satisfies the isoDatetime schema', () => {
    expect(isoDatetime().safeParse(serializeUtcDatetime(new Date())).success).toBe(true)
    expect(isoDatetime().safeParse('2026-08-06T04:14:54+02:00').success).toBe(false)
  })
})

describe('serializeOptionalUtcDatetime', () => {
  test('null and undefined both become null', () => {
    expect(serializeOptionalUtcDatetime(null)).toBeNull()
    expect(serializeOptionalUtcDatetime(undefined)).toBeNull()
  })

  test('a date is serialized as normal', () => {
    expect(serializeOptionalUtcDatetime(new Date('2026-08-06T04:14:54Z'))).toBe('2026-08-06T04:14:54Z')
  })
})

describe('serializeBool', () => {
  test('folds SQLite integers and NULL into real booleans', () => {
    expect(serializeBool(1)).toBe(true)
    expect(serializeBool(0)).toBe(false)
    expect(serializeBool(null)).toBe(false)
    expect(serializeBool(undefined)).toBe(false)
    expect(serializeBool(true)).toBe(true)
  })
})

describe('requiredTimestamp', () => {
  test('serializes a present timestamp', () => {
    expect(requiredTimestamp(new Date('2026-08-06T04:14:54Z'), 'Room', 'created_at')).toBe(
      '2026-08-06T04:14:54Z',
    )
  })

  test('throws on NULL, as Pydantic does for a required datetime', () => {
    expect(() => requiredTimestamp(null, 'Room', 'created_at')).toThrow('Room.created_at')
  })
})

describe('pydanticInt', () => {
  const schema = pydanticInt()

  test('accepts integers', () => {
    expect(schema.parse(5)).toBe(5)
    expect(schema.parse(-5)).toBe(-5)
    expect(schema.parse(0)).toBe(0)
  })

  test('accepts a float with no fractional part and rejects one with', () => {
    expect(schema.parse(1.0)).toBe(1)
    expect(schema.safeParse(1.5).success).toBe(false)
  })

  test('accepts an integer-shaped string, trimmed and signed', () => {
    expect(schema.parse('123')).toBe(123)
    expect(schema.parse('  12  ')).toBe(12)
    expect(schema.parse('+5')).toBe(5)
    expect(schema.parse('-5')).toBe(-5)
    expect(schema.parse('1.0')).toBe(1)
  })

  test('rejects the string forms Python rejects', () => {
    for (const bad of ['1.5', '1e3', '0x10', '', ' ', 'five']) {
      expect(schema.safeParse(bad).success).toBe(false)
    }
  })

  test('accepts a boolean, because Python int() does', () => {
    expect(schema.parse(true)).toBe(1)
    expect(schema.parse(false)).toBe(0)
  })

  test('rejects null, arrays and objects', () => {
    for (const bad of [null, undefined, [], {}]) {
      expect(schema.safeParse(bad).success).toBe(false)
    }
  })

  test('documented gap: PEP 515 underscores are not honoured', () => {
    // Pydantic parses "1_0" as 10; nothing sends that and we do not emulate it.
    expect(schema.safeParse('1_0').success).toBe(false)
  })
})

describe('pydanticBool', () => {
  const schema = pydanticBool()

  test('accepts the whole pydantic-core string vocabulary, case-insensitively', () => {
    for (const truthy of ['1', 'on', 't', 'true', 'TRUE', 'y', 'yes', 'Yes']) {
      expect(schema.parse(truthy)).toBe(true)
    }
    for (const falsy of ['0', 'off', 'f', 'false', 'FALSE', 'n', 'no']) {
      expect(schema.parse(falsy)).toBe(false)
    }
  })

  test('accepts exactly 0 and 1, not JavaScript truthiness', () => {
    expect(schema.parse(0)).toBe(false)
    expect(schema.parse(1)).toBe(true)
    expect(schema.safeParse(2).success).toBe(false)
    expect(schema.safeParse(-1).success).toBe(false)
    expect(schema.safeParse(1.5).success).toBe(false)
  })

  test('rejects strings outside the vocabulary', () => {
    for (const bad of ['', 'maybe', 'True!']) {
      expect(schema.safeParse(bad).success).toBe(false)
    }
  })

  test('rejects null', () => {
    expect(schema.safeParse(null).success).toBe(false)
  })
})

describe('optional wrappers', () => {
  test('absent and explicit null are the same request', () => {
    const schema = z.object({ a: optionalInt(), b: optionalBool(), c: optionalString() })
    expect(schema.parse({})).toEqual({ a: null, b: null, c: null })
    expect(schema.parse({ a: null, b: null, c: null })).toEqual({ a: null, b: null, c: null })
  })

  test('coercion still applies to a supplied value', () => {
    const schema = z.object({ a: optionalInt(), b: optionalBool() })
    expect(schema.parse({ a: '7', b: 'yes' })).toEqual({ a: 7, b: true })
  })

  test('optionalString does not coerce, matching Pydantic', () => {
    expect(optionalString().safeParse(5).success).toBe(false)
  })
})

describe('parseJsonColumn', () => {
  const schema = z.string().array()

  test('decodes and validates', () => {
    expect(parseJsonColumn('["a","b"]', schema)).toEqual(['a', 'b'])
  })

  test('NULL, undefined and the empty string all give null', () => {
    expect(parseJsonColumn(null, schema)).toBeNull()
    expect(parseJsonColumn(undefined, schema)).toBeNull()
    expect(parseJsonColumn('', schema)).toBeNull()
  })

  test('undecodable JSON gives null, as Python does', () => {
    expect(parseJsonColumn('not json', schema)).toBeNull()
  })

  test('deliberate divergence: valid JSON of the wrong shape gives null, not a 500', () => {
    expect(parseJsonColumn('[1,2]', schema)).toBeNull()
    expect(parseJsonColumn('{"a":1}', schema)).toBeNull()
  })
})
