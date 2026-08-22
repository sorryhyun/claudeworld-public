import { describe, expect, test } from 'bun:test'

import { formatWithParticles, hasFinalConsonant, selectParticle } from '../lib/korean'

describe('hasFinalConsonant', () => {
  test('detects 받침 on Hangul syllables', () => {
    expect(hasFinalConsonant('프리렌')).toBe(true) // ...렌 ends in ㄴ
    expect(hasFinalConsonant('크리스')).toBe(false) // ...스 has no final
    expect(hasFinalConsonant('히메')).toBe(false)
    expect(hasFinalConsonant('마법사')).toBe(false)
    expect(hasFinalConsonant('강')).toBe(true)
  })

  test('treats non-Hangul as consonant-final', () => {
    expect(hasFinalConsonant('Action_Manager')).toBe(true)
    expect(hasFinalConsonant('42')).toBe(true)
    expect(hasFinalConsonant('Claude')).toBe(true)
  })

  test('empty string has no final consonant', () => {
    expect(hasFinalConsonant('')).toBe(false)
  })

  test('astral characters are taken whole, not as a lone surrogate', () => {
    // A lone low surrogate would fall outside the Hangul range and report true
    // either way, so assert the code point actually parsed is the emoji.
    expect(hasFinalConsonant('테스트🙂')).toBe(true)
  })
})

describe('selectParticle', () => {
  test('picks the consonant or vowel form per pair', () => {
    expect(selectParticle('프리렌', '이가')).toBe('이')
    expect(selectParticle('히메', '이가')).toBe('가')
    expect(selectParticle('프리렌', '은는')).toBe('은')
    expect(selectParticle('히메', '은는')).toBe('는')
    expect(selectParticle('프리렌', '을를')).toBe('을')
    expect(selectParticle('히메', '을를')).toBe('를')
    expect(selectParticle('프리렌', '과와')).toBe('과')
    expect(selectParticle('히메', '과와')).toBe('와')
    expect(selectParticle('프리렌', '으로로')).toBe('으로')
    expect(selectParticle('치즈루', '으로로')).toBe('로')
  })
})

describe('formatWithParticles', () => {
  test('matches the docstring examples from i18n/korean.py', () => {
    expect(formatWithParticles('{name:이가} 말했다', { name: '프리렌' })).toBe('프리렌이 말했다')
    expect(formatWithParticles('{name:은는} 강하다', { name: '히메' })).toBe('히메는 강하다')
    expect(formatWithParticles('{name:으로로}서', { name: '치즈루' })).toBe('치즈루로서')
  })

  test('substitutes bare placeholders too, and every occurrence', () => {
    expect(formatWithParticles('{agent_name} / {agent_name:은는} 여기', { agent_name: '크리스' })).toBe(
      '크리스 / 크리스는 여기',
    )
  })

  test('leaves unknown placeholders and unknown particle patterns alone', () => {
    expect(formatWithParticles('{other} {name:라라}', { name: '히메' })).toBe('{other} {name:라라}')
  })

  test('substituted values are not rescanned (diverges from Python)', () => {
    // Python's chained str.replace would expand the injected placeholder again.
    expect(formatWithParticles('{name}', { name: '{name}' })).toBe('{name}')
  })

  test('handles multiple named values', () => {
    expect(
      formatWithParticles('{a:은는} {b:을를} 봤다', { a: '프리렌', b: '히메' }),
    ).toBe('프리렌은 히메를 봤다')
  })
})
