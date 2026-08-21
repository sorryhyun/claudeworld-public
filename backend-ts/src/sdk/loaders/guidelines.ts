/**
 * Base system prompt selection.
 *
 * Ported from `backend/sdk/loaders/guidelines.py`.
 *
 * `guidelines_3rd.yaml` holds several prompt bodies plus an
 * `active_system_prompt` key naming which one is live — an indirection so a
 * prompt can be swapped by editing one line instead of moving a 40-line block.
 * Two agents opt out of that selector entirely and get a dedicated prompt.
 */

import { DEFAULT_FALLBACK_PROMPT } from '../../config/settings'
import { getGuidelinesConfig } from './yaml-config'

/**
 * Agent-name patterns, from `domain/value_objects/enums.py`.
 *
 * Matching is substring-based on a lowercased, space-to-underscore-normalized
 * name, so "Action Manager", "action_manager" and "TRPG_Action_Manager" all
 * hit. Kept here because the domain layer is not part of this port; move these
 * to `domain/entities/agent.ts` when it lands.
 */
const ACTION_MANAGER_PATTERNS = ['action_manager', 'actionmanager', 'action manager']
const ONBOARDING_MANAGER_PATTERNS = ['onboarding_manager', 'onboardingmanager', 'onboarding manager']

function matchesPatterns(agentName: string, patterns: readonly string[]): boolean {
  const normalized = agentName.toLowerCase().replaceAll(' ', '_')
  return patterns.some((pattern) => normalized.includes(pattern))
}

export function isActionManager(agentName: string): boolean {
  return matchesPatterns(agentName, ACTION_MANAGER_PATTERNS)
}

export function isOnboardingManager(agentName: string): boolean {
  return matchesPatterns(agentName, ONBOARDING_MANAGER_PATTERNS)
}

function readPrompt(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Load the base system prompt for `agentName`.
 *
 * - Action Manager → `system_prompt_AM`
 * - Onboarding Manager → `system_prompt_OM`
 * - anything else (or no name) → the key named by `active_system_prompt`
 *
 * The returned template still contains `{agent_name}` placeholders; run it
 * through `formatWithParticles` before use.
 */
export function getBaseSystemPrompt(agentName?: string | null): string {
  try {
    const config = getGuidelinesConfig()

    if (agentName) {
      if (isActionManager(agentName)) {
        const prompt = readPrompt(config, 'system_prompt_AM')
        if (prompt) return prompt.trim()
      } else if (isOnboardingManager(agentName)) {
        const prompt = readPrompt(config, 'system_prompt_OM')
        if (prompt) return prompt.trim()
      }
      // A missing AM/OM prompt intentionally falls through to the selector
      // rather than erroring, so deleting the key degrades to the shared prompt.
    }

    const activeKey = readPrompt(config, 'active_system_prompt') || 'system_prompt'
    let prompt = readPrompt(config, activeKey)

    if (!prompt && activeKey !== 'system_prompt') {
      console.warn(`[guidelines] System prompt '${activeKey}' not found, falling back to 'system_prompt'`)
      prompt = readPrompt(config, 'system_prompt')
    }

    if (prompt) return prompt.trim()

    console.warn('[guidelines] system_prompt not found in guidelines config, using fallback')
    return DEFAULT_FALLBACK_PROMPT
  } catch (error) {
    console.error(`[guidelines] Error loading system prompt: ${String(error)}`)
    return DEFAULT_FALLBACK_PROMPT
  }
}
