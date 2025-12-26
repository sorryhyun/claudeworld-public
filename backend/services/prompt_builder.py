"""
Prompt builder service for constructing agent system prompts.

This module provides centralized prompt building logic to avoid duplication
across CRUD operations.
"""

import logging

from domain.entities.agent_config import AgentConfigData
from i18n.korean import format_with_particles
from sdk.loaders import get_base_system_prompt

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
