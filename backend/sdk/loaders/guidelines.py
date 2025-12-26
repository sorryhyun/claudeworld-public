"""
Guidelines and system prompt configuration.

Provides functions for loading the base system prompt from guidelines.yaml.
"""

import logging

from .yaml_loaders import get_guidelines_config

logger = logging.getLogger(__name__)


def get_base_system_prompt(agent_name: str | None = None) -> str:
    """
    Load the base system prompt from guidelines.yaml.

    Selects system prompt based on agent type:
    - Action Manager: Uses 'system_prompt_AM' if available
    - Onboarding Manager: Uses 'system_prompt_OM' if available
    - Other agents: Uses 'active_system_prompt' field (default behavior)

    Character configuration is always appended to the system prompt with markdown headings.

    Args:
        agent_name: Optional agent name to determine which prompt variant to use.
                    If None, uses the default active_system_prompt.

    Returns:
        The system prompt template with {agent_name} placeholder
    """
    from core.settings import DEFAULT_FALLBACK_PROMPT
    from domain.entities.agent import is_action_manager, is_onboarding_manager

    try:
        guidelines_config = get_guidelines_config()

        # Determine which system prompt to use based on agent type
        if agent_name:
            if is_action_manager(agent_name):
                # Action Manager: prefer system_prompt_AM
                system_prompt = guidelines_config.get("system_prompt_AM", "")
                if system_prompt:
                    logger.debug(f"Using system_prompt_AM for agent '{agent_name}'")
                    return system_prompt.strip()
            elif is_onboarding_manager(agent_name):
                # Onboarding Manager: prefer system_prompt_OM
                system_prompt = guidelines_config.get("system_prompt_OM", "")
                if system_prompt:
                    logger.debug(f"Using system_prompt_OM for agent '{agent_name}'")
                    return system_prompt.strip()

        # Default: use active_system_prompt selector
        # Falls back to "system_prompt" if not specified
        active_prompt_key = guidelines_config.get("active_system_prompt", "system_prompt")
        system_prompt = guidelines_config.get(active_prompt_key, "")

        # If active key not found, try default "system_prompt"
        if not system_prompt and active_prompt_key != "system_prompt":
            logger.warning(f"System prompt '{active_prompt_key}' not found, falling back to 'system_prompt'")
            system_prompt = guidelines_config.get("system_prompt", "")

        if system_prompt:
            return system_prompt.strip()
        else:
            logger.warning("system_prompt not found in guidelines.yaml, using fallback")
            return DEFAULT_FALLBACK_PROMPT
    except Exception as e:
        # Log and use fallback on any error
        logger.error(f"Error loading system prompt from guidelines.yaml: {e}")
        return DEFAULT_FALLBACK_PROMPT
