/**
 * Localized message generation.
 *
 * Ported from `backend/domain/services/localization.py`.
 *
 * The two messages here are written into the message log by the server, not by
 * an agent: the onboarding trigger is the first row of a new world's onboarding
 * room, and the arrival message is what the Action Manager reads when the
 * player first enters a location. Both are read by a human, so the templates
 * stay in `backend/sdk/config/localization.yaml` — the same file the Python
 * backend reads, loaded through the same mtime-keyed loader, so an edit takes
 * effect without a restart in either backend and the two can never disagree
 * about what a Korean player sees.
 *
 * Python's `_LANG_MAP` (`localization.py:14-18`) does not survive as a map:
 * `Language`'s *values* are already `en` / `ko` / `jp` (`enums.py:51-56`), so
 * the mapping is the identity. What it actually contributed was the `.get(...,
 * "en")` fallback for a value outside the enum, and that is `toLangKey`.
 */

import type { Language } from '../db/schema'
import { toLangKey } from './enums'
import { formatWithParticles } from '../lib/korean'
import { getLocalizationConfig } from '../sdk/loaders/yaml-config'

/**
 * Template variable names are snake_case because they are the placeholder names
 * written inside `localization.yaml` (`{user_name}`, `{location_name:이가}`),
 * not TypeScript identifiers. Renaming them here would silently stop matching.
 */
type TemplateValues = Record<string, string>

/** `{name}` placeholders, the subset of Python's format-spec grammar these templates use. */
const PLACEHOLDER = /\{(\w+)\}/g

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Python's `template.format(**kwargs)` for the non-Korean path.
 *
 * Divergence: `str.format` raises `KeyError` on a placeholder with no matching
 * argument. An unknown placeholder is left verbatim here instead, so a typo in
 * a hot-reloaded YAML edit degrades one message rather than 500-ing world
 * creation. Substitution is a single pass, so a value that itself contains
 * braces is inert — which `str.format` also guarantees.
 */
function formatTemplate(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] as string) : match,
  )
}

/**
 * Read `section.key.<lang>` out of the localization config.
 *
 * The `||` fallback to English is Python's (`localization.py:42`) and is
 * deliberately falsy-based rather than nullish: a language whose entry exists
 * but is an empty string falls back too, because an empty message is never what
 * a half-finished translation meant.
 */
function getMessage(
  section: string,
  key: string,
  language: Language,
  values?: TemplateValues,
): string {
  const config = getLocalizationConfig()
  const langKey = toLangKey(language)

  const messageConfig = asRecord(asRecord(config[section])[key])
  const localized = messageConfig[langKey]
  const english = messageConfig.en
  const template =
    (typeof localized === 'string' && localized) || (typeof english === 'string' ? english : '')

  if (values === undefined) return template

  // Korean templates carry particle pairs (`{user_name:이가}`), which only
  // `formatWithParticles` understands; the other two languages take the plain
  // substitution so an accidental particle pattern in an English template stays
  // as visible as it does in Python.
  return language === 'ko' ? formatWithParticles(template, values) : formatTemplate(template, values)
}

/**
 * The message that starts onboarding, posted as the first turn of a new world's
 * onboarding room.
 */
export function getOnboardingMessage(language: Language): string {
  return getMessage('onboarding', 'trigger', language)
}

/**
 * The message announcing that the player has entered a location for the first
 * time. Written by the polling endpoint, then read by the Action Manager.
 */
export function getArrivalMessage(
  userName: string,
  locationName: string,
  language: Language,
): string {
  return getMessage('game', 'arrival', language, {
    user_name: userName,
    location_name: locationName,
  })
}
