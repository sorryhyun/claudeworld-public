/**
 * System prompt assembly. The character sheet is appended as markdown headings
 * rather than XML tags, so it blends into the SDK's own immutable "You are
 * Claude Code" prompt instead of fighting it. Section order is load-bearing:
 * identity, behaviour, recent context, memory index — cheapest-to-ignore
 * material furthest from the instructions.
 */

import { formatWithParticles } from '../lib/korean'
import { getBaseSystemPrompt } from '../sdk/loaders/guidelines'
import type { AgentConfigData } from '../sdk/parsing/agent-config'

export type PromptConfigData = Pick<
  AgentConfigData,
  'inANutshell' | 'characteristics' | 'recentEvents' | 'longTermMemorySubtitles'
>

/**
 * Render the character sheet as markdown, or `''`. The leading blank lines are
 * part of the contract — callers concatenate this onto the base prompt. The
 * memory heading's hardcoded `이` particle deliberately skips
 * `formatWithParticles`: fixing it would change every agent's prompt.
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

function baseFor(agentName: string): string {
  return formatWithParticles(getBaseSystemPrompt(agentName), { agent_name: agentName })
}

// The base prompt varies by agent type; Action Manager and Onboarding Manager
// get dedicated ones.
export function buildSystemPrompt(agentName: string, config: PromptConfigData): string {
  return baseFor(agentName) + toSystemPromptMarkdown(agentName, config)
}

/**
 * Build a system prompt at request time, optionally injecting world lore.
 * Guidelines → lore → character sheet: lore sits in the middle so the traits
 * stay adjacent to the agent's own output, where they have most pull.
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
