"""
Task Sub-Agent Definition Builder for SDK Native Pattern.

This module builds AgentDefinition objects for sub-agents that can be invoked
via the SDK Task tool by parent agents (Action Manager, Onboarding Manager).

Key features:
- Loads agent identity from filesystem (in_a_nutshell.md, characteristics.md)
- All sub-agent prompts are defined in characteristics.md files
- Specifies persist tools for each sub-agent type
- Integrates with ClaudeAgentOptions.agents parameter

IMPORTANT: This module is ONLY for Task-tool sub-agents. Standalone agents
like Chat_Summarizer (which are invoked directly via AgentManager) should
NOT be defined here.

Usage:
    from sdk.agent.task_subagent_definitions import build_subagent_definitions_for_agent

    # In AgentManager._build_agent_options():
    agents = build_subagent_definitions_for_agent(agent_name)
    options = ClaudeAgentOptions(
        ...,
        agents=agents,
    )

The SDK native pattern:
1. Registers AgentDefinition in ClaudeAgentOptions.agents
2. Action Manager/Onboarding Manager uses Task tool to invoke sub-agents
3. Sub-agents use persist tools to directly apply changes
4. Task tool result confirms the persistence was successful
"""

import logging
from pathlib import Path
from typing import Optional

from claude_agent_sdk.types import AgentDefinition

from sdk.tools.gameplay_tools.onboarding_tools import SUBAGENT_TOOL_NAMES

# Valid sub-agent types (formerly sourced from subagent_prompts.py)
# Now sub-agent prompts are defined in characteristics.md files
SUBAGENT_TYPES = {"item_designer", "character_designer", "location_designer"}

logger = logging.getLogger("TaskSubagentDefinitions")

# Cache for sub-agent definitions with mtime tracking for hot-reload support
# Structure: {agent_name: {"definitions": dict, "mtimes": {path: mtime}}}
_subagent_cache: dict[str, dict] = {}


def _get_agents_dir() -> Path:
    """Get agents directory, handling PyInstaller bundled mode."""
    from core.settings import get_settings

    return get_settings().agents_dir


def _get_subagent_paths() -> dict[str, Path]:
    """Get sub-agent paths dynamically to support PyInstaller bundles.

    NOTE: Only Task-tool sub-agents are included here. Standalone agents
    (like Chat_Summarizer) are NOT included.

    World Seed Generator was merged into Onboarding_Manager (no longer a sub-agent).
    """
    agents_dir = _get_agents_dir()
    return {
        # Task-tool sub-agents (invoked by Action Manager / Onboarding Manager)
        "item_designer": agents_dir / "group_subagent" / "Item_Designer",
        "character_designer": agents_dir / "group_subagent" / "Character_Designer",
        "location_designer": agents_dir / "group_subagent" / "Location_Designer",
    }


# Human-readable names for Task-tool sub-agents (used in descriptions)
SUBAGENT_DISPLAY_NAMES = {
    "item_designer": "Item Designer",
    "character_designer": "Character Designer",
    "location_designer": "Location Designer",
}

# Task-tool sub-agent descriptions for the Task tool
SUBAGENT_DESCRIPTIONS = {
    "item_designer": (
        "Invoke to design a new item template for the game world. Provide the "
        "purpose, context, and any specific requirements. Returns structured JSON "
        "with item_id, name, description, and properties. Use this when players "
        "find, craft, or receive new items that don't exist yet."
    ),
    "character_designer": (
        "Invoke to design a new NPC character for the game world. Provide the "
        "purpose/role of the character. Returns structured JSON with name, role, "
        "appearance, personality, location, and initial_disposition."
    ),
    "location_designer": (
        "Invoke to design a new location for the game world. You MUST provide the "
        "exact snake_case location name (e.g., 'fringe_market_descent', 'abandoned_warehouse') "
        "along with the purpose and adjacent location. Returns structured JSON with name, "
        "display_name, description, position, and adjacent_hints."
    ),
}


def _load_agent_identity(agent_type: str) -> tuple[str, str]:
    """
    Load agent identity from filesystem config files.

    Args:
        agent_type: Type of agent (item_designer, character_designer, etc.)

    Returns:
        Tuple of (in_a_nutshell, characteristics)
    """
    base_path = _get_subagent_paths().get(agent_type)
    if base_path is None or not base_path.exists():
        logger.warning(f"Agent path not found: {base_path}")
        return "", ""

    in_a_nutshell = ""
    nutshell_path = base_path / "in_a_nutshell.md"
    if nutshell_path.exists():
        in_a_nutshell = nutshell_path.read_text(encoding="utf-8").strip()

    characteristics = ""
    char_path = base_path / "characteristics.md"
    if char_path.exists():
        characteristics = char_path.read_text(encoding="utf-8").strip()

    return in_a_nutshell, characteristics


def _build_subagent_prompt(
    agent_type: str,
    identity: str,
    characteristics: str,
    persist_tool_name: Optional[str],
) -> str:
    """
    Build the complete system prompt for a Task-tool sub-agent.

    The prompt includes:
    - Agent identity (from in_a_nutshell.md)
    - Behavior guidelines (from characteristics.md, which now includes tool usage)
    - Persist tool instructions (if applicable)

    Args:
        agent_type: Type of sub-agent
        identity: Content from in_a_nutshell.md
        characteristics: Content from characteristics.md
        persist_tool_name: Name of the persist tool to use (None for no-persist agents)

    Returns:
        Complete system prompt string
    """
    display_name = SUBAGENT_DISPLAY_NAMES.get(agent_type, agent_type.replace("_", " ").title())

    prompt = f"""You are {display_name}, a specialized sub-agent in the ClaudeWorld TRPG system.

## Identity
{identity or f"A specialized {display_name} for ClaudeWorld TRPG."}

## Guidelines
{characteristics or "Follow the task instructions carefully and provide accurate results."}"""

    if persist_tool_name:
        prompt += f"""

## Output Instructions
You MUST use the `{persist_tool_name}` tool to persist your results. Do not return anything else or follow-up like 'I'll...', just use the tool."""
    else:
        prompt += """

## Output Instructions
Provide your results as a clear, structured text response. Your output will be
returned to the parent agent via the Task tool result."""

    return prompt


def build_subagent_definition(agent_type: str) -> Optional[AgentDefinition]:
    """
    Build an AgentDefinition for a specific Task-tool sub-agent type.

    Args:
        agent_type: Type of sub-agent (item_designer, character_designer, etc.)

    Returns:
        AgentDefinition or None if agent type is not recognized
    """
    if agent_type not in SUBAGENT_TYPES:
        logger.warning(f"Unknown sub-agent type: {agent_type}")
        return None

    # Get the persist tool name for this agent type (may be None for no-persist agents)
    persist_tool_name = SUBAGENT_TOOL_NAMES.get(agent_type)

    # Load identity from filesystem
    identity, characteristics = _load_agent_identity(agent_type)

    # Build the complete system prompt
    prompt = _build_subagent_prompt(
        agent_type=agent_type,
        identity=identity,
        characteristics=characteristics,
        persist_tool_name=persist_tool_name,
    )

    # Get description
    description = SUBAGENT_DESCRIPTIONS.get(
        agent_type,
        f"Sub-agent for {agent_type.replace('_', ' ')}",
    )

    # Build tools list - only include persist tool if agent has one
    tools_list = [persist_tool_name] if persist_tool_name else []

    # Build AgentDefinition
    # Note: tools list specifies the MCP tool names that this agent can use
    # The persist tool must be provided via an MCP server in the parent agent
    definition = AgentDefinition(
        description=description,
        prompt=prompt,
        tools=tools_list if tools_list else None,
        model="inherit",
    )

    logger.debug(f"Built AgentDefinition for {agent_type}: tools={definition.tools}")

    return definition


def build_subagent_definitions() -> dict[str, AgentDefinition]:
    """
    Build AgentDefinition dict for all Task-tool sub-agents.

    This is a utility function for building all definitions at once.

    Returns:
        Dictionary mapping agent type to AgentDefinition
        Example: {"item_designer": AgentDefinition(...), ...}
    """
    definitions = {}

    for agent_type in SUBAGENT_TYPES:
        definition = build_subagent_definition(agent_type)
        if definition:
            definitions[agent_type] = definition
            logger.debug(f"Registered sub-agent definition: {agent_type}")

    logger.debug(f"Built {len(definitions)} sub-agent definitions")
    return definitions


def _get_subagent_mtimes(agent_types: list[str]) -> dict[str, float]:
    """Get modification times for all config files of the given sub-agent types."""
    mtimes = {}
    subagent_paths = _get_subagent_paths()
    for agent_type in agent_types:
        base_path = subagent_paths.get(agent_type)
        if base_path and base_path.exists():
            for filename in ["in_a_nutshell.md", "characteristics.md"]:
                file_path = base_path / filename
                if file_path.exists():
                    mtimes[str(file_path)] = file_path.stat().st_mtime
    return mtimes


def _cache_is_valid(agent_name: str, current_mtimes: dict[str, float]) -> bool:
    """Check if cached definitions are still valid based on file mtimes."""
    if agent_name not in _subagent_cache:
        return False
    cached_mtimes = _subagent_cache[agent_name].get("mtimes", {})
    return cached_mtimes == current_mtimes


def build_subagent_definitions_for_agent(agent_name: str) -> Optional[dict[str, AgentDefinition]]:
    """
    Build Task-tool sub-agent definitions based on the parent agent name.

    Only certain agents (Action Manager, Onboarding Manager) should have
    access to sub-agents. Results are cached with mtime-based invalidation
    to support hot-reloading while avoiding unnecessary rebuilds.

    Args:
        agent_name: Name of the parent agent

    Returns:
        Dictionary of sub-agent definitions, or None if agent doesn't need sub-agents
    """
    # Agents that can invoke Task-tool sub-agents
    SUBAGENT_ENABLED_AGENTS = {
        "Action_Manager": [
            "item_designer",
            "character_designer",
            "location_designer",
        ],
        "Onboarding_Manager": [
            "item_designer",
            "character_designer",
            "location_designer",
        ],
    }

    if agent_name not in SUBAGENT_ENABLED_AGENTS:
        return None

    allowed_subagents = SUBAGENT_ENABLED_AGENTS[agent_name]
    if not allowed_subagents:
        return None

    # Check cache validity using file mtimes
    current_mtimes = _get_subagent_mtimes(allowed_subagents)
    if _cache_is_valid(agent_name, current_mtimes):
        logger.debug(f"Using cached sub-agent definitions for {agent_name}")
        return _subagent_cache[agent_name]["definitions"]

    # Build definitions (cache miss or invalidated)
    definitions = {}
    for agent_type in allowed_subagents:
        definition = build_subagent_definition(agent_type)
        if definition:
            definitions[agent_type] = definition

    if definitions:
        # Update cache
        _subagent_cache[agent_name] = {
            "definitions": definitions,
            "mtimes": current_mtimes,
        }
        logger.info(f"Built {len(definitions)} sub-agent definitions for {agent_name} (cache updated)")
        return definitions

    return None
