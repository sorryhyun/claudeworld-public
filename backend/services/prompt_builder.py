"""
Prompt builder service for constructing agent system prompts.

This module provides centralized prompt building logic to avoid duplication
across CRUD operations.
"""

import logging
import random
from typing import Dict

from domain.entities.agent_config import AgentConfigData
from i18n.korean import format_with_particles
from sdk.loaders import (
    SYSTEM_PROMPT_SEGMENTS,
    get_base_system_prompt,
    get_guidelines_sep_config,
    get_segment_variations,
)

logger = logging.getLogger(__name__)


def build_system_prompt(agent_name: str, config_data: AgentConfigData) -> str:
    """
    Build a complete system prompt for an agent.

    This function combines the base system prompt with agent-specific
    configuration markdown, applying Korean particle formatting.

    Uses different base prompts for different agent types:
    - Action Manager: system_prompt_AM
    - Onboarding Manager: system_prompt_OM
    - Other agents: active_system_prompt (default)

    Args:
        agent_name: The name of the agent
        config_data: Agent configuration data

    Returns:
        Complete system prompt string with markdown formatting
    """
    # Start with base system prompt (selected by agent type) and apply Korean particle formatting
    system_prompt = format_with_particles(get_base_system_prompt(agent_name), agent_name=agent_name)

    # Append character configuration with markdown headings
    config_markdown = config_data.to_system_prompt_markdown(agent_name)
    if config_markdown:
        system_prompt += config_markdown

    return system_prompt


def build_runtime_system_prompt(
    agent_name: str,
    config_data: AgentConfigData,
    lore: str | None = None,
) -> str:
    """
    Build a system prompt at runtime with optional lore injection.

    Structure:
        [platform_guideline]
        [lore]                 <- injected between guideline and traits
        [character_config]

    This allows world-specific lore to be injected between the platform
    guidelines and character traits for better context.

    Uses different base prompts for different agent types:
    - Action Manager: system_prompt_AM
    - Onboarding Manager: system_prompt_OM
    - Other agents: active_system_prompt (default)

    Args:
        agent_name: The name of the agent
        config_data: Agent configuration data
        lore: Optional world lore to inject

    Returns:
        Complete system prompt with lore injected in the middle
    """
    # Start with base system prompt (selected by agent type) and apply Korean particle formatting
    system_prompt = format_with_particles(get_base_system_prompt(agent_name), agent_name=agent_name)

    # Inject lore between platform guideline and character config
    if lore:
        system_prompt += f"\n\n# World Lore\n\n{lore.strip()}"

    # Append character configuration with markdown headings
    config_markdown = config_data.to_system_prompt_markdown(agent_name)
    if config_markdown:
        system_prompt += config_markdown

    return system_prompt


def sample_system_prompt_with_choices(
    agent_name: str,
    choices: Dict[str, int] | None = None,
) -> str:
    """
    Build a system prompt using specific variation choices for each segment.

    Args:
        agent_name: Agent name to substitute in templates
        choices: Dict mapping segment prefix to variation number
                 e.g., {"first": 2, "second": 1, "third": 3, "fourth": 2}
                 If a segment is not in choices, randomly sample it.

    Returns:
        Combined system prompt with {agent_name} substituted
    """
    if choices is None:
        choices = {}

    config = get_guidelines_sep_config()
    sampled_parts = []

    for segment in SYSTEM_PROMPT_SEGMENTS:
        if segment in choices:
            # Use specific variation
            chosen_key = f"{segment}_{choices[segment]}"
        else:
            # Random sample
            variations = get_segment_variations(segment)
            if not variations:
                logger.warning(f"No variations found for segment '{segment}'")
                continue
            chosen_key = random.choice(variations)

        content = config.get(chosen_key, "")
        if content:
            sampled_parts.append(content.strip())
        else:
            logger.warning(f"Segment key '{chosen_key}' not found in config")

    combined = "\n\n".join(sampled_parts)
    return combined.format(agent_name=agent_name)
