/**
 * System prompt assembly.
 *
 * Ports `AgentConfigData.to_system_prompt_markdown` from
 * `backend/domain/entities/agent_config.py` together with
 * `backend/services/prompt_builder.py`.
 *
 * The character sheet is appended to the base prompt as markdown headings
 * rather than XML tags — the Claude Agent SDK prepends its own immutable
 * "You are Claude Code" prompt, and headings blend into that document instead
 * of fighting it. Section order is load-bearing: identity, then behaviour, then
 * recent context, then the memory index last, so the cheapest-to-ignore
 * material sits furthest from the instructions.
 */

import { formatWithParticles } from '../lib/korean'
import { getBaseSystemPrompt } from '../sdk/loaders/guidelines'
import type { AgentConfigData } from '../sdk/parsing/agent-config'

/** The subset of {@link AgentConfigData} that reaches the prompt. */
export type PromptConfigData = Pick<
  AgentConfigData,
  'inANutshell' | 'characteristics' | 'recentEvents' | 'longTermMemorySubtitles'
>

/**
 * Render the character sheet as markdown, or `''` when nothing is configured.
 *
 * The leading blank lines are part of the contract — callers concatenate this
 * directly onto the base prompt.
 *
 * Note the memory section heading is Korean prose with a hardcoded `이`
 * particle. It is *not* run through `formatWithParticles`, so a vowel-final
 * agent name reads ungrammatically; reproduced verbatim because changing it
 * would change every agent's prompt.
 */
export function toSystemPromptMarkdown(agentName: string, config: PromptConfigData): string {
  const sections: string[] = []

  if (config.inANutshell) {
    sections.push(`## ${agentName} in a nutshell\n\n${config.inANutshell}`)
  }
  if (config.characteristics) {
    sections.push(`## ${agentName}'s characteristics\n\n${config.characteristics}`)
  }
  if (config.recentEvents) {
    sections.push(`## ${agentName}'s recent events\n\n${config.recentEvents}`)
  }
  if (config.longTermMemorySubtitles) {
    sections.push(`## ${agentName}이 가진 기억 index\n\n${config.longTermMemorySubtitles}`)
  }

  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : ''
}

/** Base prompt for `agentName` with `{agent_name}` placeholders resolved. */
function baseFor(agentName: string): string {
  return formatWithParticles(getBaseSystemPrompt(agentName), { agent_name: agentName })
}

/**
 * Build the stored system prompt for an agent.
 *
 * The base prompt varies by agent type (Action Manager and Onboarding Manager
 * get dedicated ones); see `getBaseSystemPrompt`.
 */
export function buildSystemPrompt(agentName: string, config: PromptConfigData): string {
  return baseFor(agentName) + toSystemPromptMarkdown(agentName, config)
}

/**
 * Build a system prompt at request time, optionally injecting world lore.
 *
 * Layout: platform guidelines → lore → character sheet. Lore sits in the middle
 * so the character traits stay adjacent to the agent's own output, which is
 * where they have the most pull.
 */
export function buildRuntimeSystemPrompt(
  agentName: string,
  config: PromptConfigData,
  lore?: string | null,
): string {
  let prompt = baseFor(agentName)
  if (lore) prompt += `\n\n# World Lore\n\n${lore.trim()}`
  return prompt + toSystemPromptMarkdown(agentName, config)
}
