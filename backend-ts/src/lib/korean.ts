/**
 * Korean particle (조사) agreement for prompt templates.
 *
 * Ported from `backend/i18n/korean.py`.
 *
 * Korean postpositions come in pairs and the correct member depends on whether
 * the preceding syllable ends in a final consonant (받침). Since agent names are
 * substituted at runtime, templates write the pair — `{agent_name:은는}` — and
 * this module picks a member. Getting it wrong is immediately visible to a
 * Korean reader in every line of a prompt.
 */

const HANGUL_SYLLABLE_START = 0xac00
const HANGUL_SYLLABLE_END = 0xd7a3
/** Each Hangul syllable block cycles through 28 final-consonant slots; 0 = none. */
const FINAL_CONSONANT_COUNT = 28

/** Particle pairs, keyed by the literal pattern used in templates. */
export const PARTICLE_PAIRS = {
  은는: ['은', '는'],
  이가: ['이', '가'],
  을를: ['을', '를'],
  과와: ['과', '와'],
  으로로: ['으로', '로'],
} as const satisfies Record<string, readonly [string, string]>

export type ParticlePattern = keyof typeof PARTICLE_PAIRS

/**
 * Whether `text` ends in a final consonant.
 *
 * Non-Hangul endings (English names, digits) report `true`: the consonant forms
 * (은/이/을) are the safer default because they read as merely stiff, while the
 * vowel forms after a consonant read as outright broken.
 */
export function hasFinalConsonant(text: string): boolean {
  if (!text) return false

  // Python indexes by code point, so a name ending in an astral character (an
  // emoji) takes the whole character; JS string indexing would take a lone
  // surrogate. Array.from splits by code point to match.
  const codePoints = Array.from(text)
  const lastChar = codePoints[codePoints.length - 1]
  if (lastChar === undefined) return false

  const code = lastChar.codePointAt(0) ?? 0
  if (code < HANGUL_SYLLABLE_START || code > HANGUL_SYLLABLE_END) return true

  return (code - HANGUL_SYLLABLE_START) % FINAL_CONSONANT_COUNT !== 0
}

/** Pick the particle for `word` from a pair. */
export function selectParticle(word: string, pattern: ParticlePattern): string {
  const [consonantForm, vowelForm] = PARTICLE_PAIRS[pattern]
  return hasFinalConsonant(word) ? consonantForm : vowelForm
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Substitute `{name}` and `{name:은는}`-style placeholders in a template.
 *
 * Particle placeholders expand to the value *plus* the agreeing particle, so
 * `{agent_name:이가} 말했다` with `프리렌` yields `프리렌이 말했다`.
 *
 * Divergence: Python chains `str.replace`, which then rescans the substituted
 * text — a value containing `{agent_name}` would be expanded again. We replace
 * in one regex pass so values are inert.
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
