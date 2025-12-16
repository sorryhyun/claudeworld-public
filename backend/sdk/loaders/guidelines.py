"""
Guidelines and system prompt configuration.

Provides functions for system prompt sampling and guidelines templates.
"""

import logging
import random
from typing import List

from .yaml_loaders import get_guidelines_config, get_guidelines_sep_config

logger = logging.getLogger(__name__)

# Segment prefixes for sampling system prompt variations
SYSTEM_PROMPT_SEGMENTS = ["first", "second", "third", "fourth"]


def is_sample_system_prompt_enabled() -> bool:
    """
    Check if sampled system prompt is enabled.

    Returns the value from Settings, which properly loads from .env file.
    """
    from core import get_settings

    return get_settings().sample_system_prompt


# Backward compatibility: module-level constant that delegates to function
# Note: This is evaluated lazily via __getattr__ to avoid import-time issues
def __getattr__(name: str):
    if name == "SAMPLE_SYSTEM_PROMPT":
        return is_sample_system_prompt_enabled()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def get_segment_variations(segment_prefix: str) -> List[str]:
    """
    Get all variations for a given segment prefix.

    Args:
        segment_prefix: The prefix to look for (e.g., "first", "second")

    Returns:
        List of keys matching the prefix (e.g., ["first_1", "first_2", "first_3"])
    """
    config = get_guidelines_sep_config()
    return sorted([key for key in config.keys() if key.startswith(f"{segment_prefix}_")])


def sample_system_prompt_segments(
    agent_name: str,
    segments: List[str] | None = None,
    seed: int | None = None,
) -> str:
    """
    Build a system prompt by randomly sampling one variation from each segment.

    Args:
        agent_name: Agent name to substitute in templates
        segments: List of segment prefixes to sample from (default: SYSTEM_PROMPT_SEGMENTS)
        seed: Optional random seed for reproducibility

    Returns:
        Combined system prompt with {agent_name} substituted
    """
    if segments is None:
        segments = SYSTEM_PROMPT_SEGMENTS

    if seed is not None:
        random.seed(seed)

    config = get_guidelines_sep_config()
    sampled_parts = []

    for segment in segments:
        variations = get_segment_variations(segment)
        if not variations:
            logger.warning(f"No variations found for segment '{segment}'")
            continue

        chosen_key = random.choice(variations)
        content = config.get(chosen_key, "")
        if content:
            sampled_parts.append(content.strip())

    combined = "\n\n".join(sampled_parts)

    # Substitute agent_name placeholder
    return combined.format(agent_name=agent_name)


def get_base_system_prompt(agent_name: str | None = None) -> str:
    """
    Load the base system prompt from guidelines.yaml or sample from guidelines_sep.yaml.

    When SAMPLE_SYSTEM_PROMPT=true, builds system prompt by randomly sampling
    one variation from each segment (first, second, third, fourth) in guidelines_sep.yaml.

    Otherwise, selects system prompt based on agent type:
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
        # Use sampled system prompt if enabled
        if is_sample_system_prompt_enabled():
            # Return template with {agent_name} placeholder (not substituted yet)
            return sample_system_prompt_segments("{agent_name}")

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
