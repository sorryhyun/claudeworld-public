// `guidelines_3rd.yaml` holds several prompt bodies plus an
// `active_system_prompt` key naming which one is live, so a prompt is swapped
// by editing one line. The Action and Onboarding Managers opt out.

import { DEFAULT_FALLBACK_PROMPT } from '@/config/settings'
import { isActionManager, isOnboardingManager } from '@/domain/agent'
import { getGuidelinesConfig } from './yaml-config'
import { getLogger } from '@/infrastructure/logging/logger'

const logger = getLogger('Guidelines')

// Defined in `domain/agent.ts`; re-exported because callers import them here.
export { isActionManager, isOnboardingManager }

function readPrompt(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

/**
 * `system_prompt_AM` for the Action Manager, `system_prompt_OM` for the
 * Onboarding Manager, otherwise `active_system_prompt`'s key. The result still
 * holds `{agent_name}` placeholders.
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
      logger.warning(`System prompt '${activeKey}' not found, falling back to 'system_prompt'`)
      prompt = readPrompt(config, 'system_prompt')
    }

    if (prompt) return prompt.trim()

    logger.warning('system_prompt not found in guidelines config, using fallback')
    return DEFAULT_FALLBACK_PROMPT
  } catch (error) {
    logger.error(`Error loading system prompt: ${String(error)}`)
    return DEFAULT_FALLBACK_PROMPT
  }
}
