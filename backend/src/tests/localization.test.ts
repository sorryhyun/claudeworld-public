/**
 * Localized message generation.
 *
 * These assert against the real `config/localization.yaml` rather
 * than a fixture, because the property worth protecting is not "the function
 * substitutes variables" — it is that the strings a player actually reads come
 * out of the file the Python backend also reads, correctly conjugated. A
 * fixture would let the two backends drift and still pass.
 *
 * Only the invariants that survive an editorial rewrite are asserted: which
 * language came back, that the variables landed, and that the Korean particle
 * agreed. The prose itself is not pinned, so improving the wording is not a
 * test failure.
 */

import { describe, expect, test } from 'bun:test'

import { getArrivalMessage, getOnboardingMessage } from '../domain/localization'
import type { Language } from '../db/schema'

describe('getOnboardingMessage', () => {
  test.each([
    ['en', /newcomer/i],
    ['ko', /온보딩/],
    ['jp', /オンボーディング/],
  ] as const)('%s resolves to its own language', (language, pattern) => {
    expect(getOnboardingMessage(language)).toMatch(pattern)
  })

  test('the three languages are genuinely different strings', () => {
    const messages = (['en', 'ko', 'jp'] as const).map(getOnboardingMessage)
    expect(new Set(messages).size).toBe(3)
  })

  test('takes no variables, so braces never appear in the output', () => {
    expect(getOnboardingMessage('en')).not.toContain('{')
  })

  test('an unknown language falls back to English', () => {
    // Python's `_LANG_MAP.get(language, "en")` (localization.py:39). Reachable
    // in practice: `worlds.language` is a nullable VARCHAR(2) that predates the
    // enum, so a stored value outside it is a data question, not a type error.
    const unknown = 'de' as Language
    expect(getOnboardingMessage(unknown)).toBe(getOnboardingMessage('en'))
  })
})

describe('getArrivalMessage', () => {
  test('substitutes both variables in English', () => {
    const message = getArrivalMessage('Ada', 'The Observatory', 'en')

    expect(message).toContain('Ada')
    expect(message).toContain('The Observatory')
    expect(message).not.toContain('{user_name}')
    expect(message).not.toContain('{location_name}')
  })

  test('substitutes both variables in Japanese', () => {
    const message = getArrivalMessage('アダ', '天文台', 'jp')

    expect(message).toContain('アダ')
    expect(message).toContain('天文台')
    expect(message).not.toContain('{')
  })

  test('Korean picks the particle that agrees with the name', () => {
    // The template is `{user_name:이가}`. 프리렌 ends in a final consonant and
    // takes 이; 유나 ends in a vowel and takes 가. Getting this wrong is the
    // failure the whole particle module exists to prevent, and it is invisible
    // to a typecheck.
    expect(getArrivalMessage('프리렌', '천문대', 'ko')).toContain('프리렌이')
    expect(getArrivalMessage('유나', '천문대', 'ko')).toContain('유나가')
  })

  test('Korean leaves no unexpanded placeholder behind', () => {
    const message = getArrivalMessage('유나', '천문대', 'ko')

    expect(message).toContain('천문대')
    expect(message).not.toContain('{')
  })

  test('an unknown language falls back to the English template', () => {
    const unknown = 'de' as Language

    expect(getArrivalMessage('Ada', 'The Observatory', unknown)).toBe(
      getArrivalMessage('Ada', 'The Observatory', 'en'),
    )
  })

  test('a value containing braces is inert', () => {
    // Python's `str.format` substitutes in one pass and never rescans a value.
    // A chained `replace` would expand `{location_name}` a second time here.
    const message = getArrivalMessage('{location_name}', 'The Observatory', 'en')

    expect(message).toContain('{location_name}')
    expect(message).toContain('The Observatory')
  })
})
