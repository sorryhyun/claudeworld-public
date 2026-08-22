/**
 * Korean particle (조사) agreement. Postpositions come in pairs whose right
 * member depends on whether the preceding syllable ends in a final consonant
 * (받침), so templates write the pair — `{agent_name:은는}`.
 */

const HANGUL_SYLLABLE_START = 0xac00
const HANGUL_SYLLABLE_END = 0xd7a3
/** Each Hangul syllable block cycles through 28 final-consonant slots; 0 = none. */
const FINAL_CONSONANT_COUNT = 28

export const PARTICLE_PAIRS = {
  은는: ['은', '는'],
  이가: ['이', '가'],
  을를: ['을', '를'],
  과와: ['과', '와'],
  으로로: ['으로', '로'],
} as const satisfies Record<string, readonly [string, string]>

export type ParticlePattern = keyof typeof PARTICLE_PAIRS

// Non-Hangul endings report `true`: the consonant forms (은/이/을) read as
// merely stiff, where the vowel forms after a consonant read as broken.
export function hasFinalConsonant(text: string): boolean {
  if (!text) return false

  // `Array.from` splits by code point; plain indexing takes a lone surrogate.
  const codePoints = Array.from(text)
  const lastChar = codePoints[codePoints.length - 1]
  if (lastChar === undefined) return false

  const code = lastChar.codePointAt(0) ?? 0
  if (code < HANGUL_SYLLABLE_START || code > HANGUL_SYLLABLE_END) return true

  return (code - HANGUL_SYLLABLE_START) % FINAL_CONSONANT_COUNT !== 0
}

export function selectParticle(word: string, pattern: ParticlePattern): string {
  const [consonantForm, vowelForm] = PARTICLE_PAIRS[pattern]
  return hasFinalConsonant(word) ? consonantForm : vowelForm
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Substitute `{name}` and `{name:은는}` placeholders, the latter expanding to
 * the value *plus* its agreeing particle. One regex pass, not chained replaces,
 * so a value that itself contains a placeholder stays inert.
 */
export function formatWithParticles(template: string, values: Record<string, string>): string {
  let result = template

  for (const [name, value] of Object.entries(values)) {
    const escapedName = escapeForRegex(name)
    const patterns = Object.keys(PARTICLE_PAIRS).join('|')
    const placeholder = new RegExp(`\\{${escapedName}(?::(${patterns}))?\\}`, 'g')

    result = result.replace(placeholder, (_match, pattern: string | undefined) =>
      pattern === undefined ? value : value + selectParticle(value, pattern as ParticlePattern),
    )
  }

  return result
}
