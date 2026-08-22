// These two messages are written into the message log by the server, not by an
// agent; the templates live in `config/localization.yaml`, hot-reloaded.

import type { Language } from '../db/schema'
import { toLangKey } from './enums'
import { formatWithParticles } from '../lib/korean'
import { getLocalizationConfig } from '../sdk/loaders/yaml-config'

// Keys are the placeholder names inside `localization.yaml`, so renaming them
// here silently stops the match.
type TemplateValues = Record<string, string>

/** `{name}` placeholders — the whole grammar these templates use. */
const PLACEHOLDER = /\{(\w+)\}/g

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// An unknown placeholder is left verbatim, so a typo in a hot-reloaded YAML
// edit degrades one message rather than 500-ing world creation.
function formatTemplate(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] as string) : match,
  )
}

// The English fallback is falsy-based, not nullish: an entry that exists but
// is empty falls back too, since a blank message helps nobody.
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

  // Korean templates carry particle pairs (`{user_name:이가}`) that only
  // `formatWithParticles` understands; the others take plain substitution.
  return language === 'ko' ? formatWithParticles(template, values) : formatTemplate(template, values)
}

/** Posted as the first row of a new world's onboarding room. */
export function getOnboardingMessage(language: Language): string {
  return getMessage('onboarding', 'trigger', language)
}

/** First entry into a location: written by polling, read by the Action Manager. */
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
