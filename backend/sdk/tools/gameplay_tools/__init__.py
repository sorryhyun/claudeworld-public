"""
Gameplay tools for TRPG.

This package contains tools used during TRPG gameplay and onboarding:

Action Manager MCP server (for gameplay-phase agents and subagents):
- Character tools: remove_character, move_character, list_characters, persist_character_design
- Location tools: travel, list_locations, persist_location_design
- Item tools: persist_item
- Mechanics tools: inject_memory, narration, suggest_options, change_stat, roll_the_dice, advance_time

Onboarding MCP server (for onboarding-phase agents):
- draft_world: Lightweight world draft (genre, theme, lore summary) to unblock sub-agents
- persist_world: Comprehensive persistence (full lore + stats + player state)
- complete: Phase transition from onboarding to active

Note: Each persist tool is in the same MCP server as its parent agent's tools,
so subagents can access them when invoked via Task tool.

Re-exports:
- create_action_manager_tools: Create all Action Manager tools
- create_action_manager_mcp_server: Create MCP server with Action Manager tools
- create_onboarding_tools: Create onboarding tools (draft_world, persist_world, complete)
- create_onboarding_mcp_server: Create MCP server with onboarding tools
- SUBAGENT_TOOL_NAMES: Mapping of sub-agent types to their persist tool names
"""

from claude_agent_sdk import create_sdk_mcp_server

from sdk.tools.context import ToolContext

from .character_tools import create_character_tools
from .item_tools import create_item_tools
from .location_tools import create_location_tools
from .mechanics_tools import create_mechanics_tools
from .narrative_tools import create_narrative_tools
from .onboarding_tools import (
    SUBAGENT_TOOL_NAMES,
    create_onboarding_tools,
)

__all__ = [
    # Action Manager tools
    "create_action_manager_tools",
    "create_action_manager_mcp_server",
    "create_character_tools",
    "create_item_tools",
    "create_location_tools",
    "create_mechanics_tools",
    "create_narrative_tools",
    # Onboarding Manager tools
    "create_onboarding_tools",
    "create_onboarding_mcp_server",
    # Subagent tools (shared between Action Manager and Onboarding Manager)
    "create_subagents_tools",
    "create_subagents_mcp_server",
    # Sub-agent tool mappings
    "SUBAGENT_TOOL_NAMES",
]


def create_action_manager_tools(ctx: ToolContext) -> list:
    """
    Create all Action Manager tools for sub-agent invocation and game state changes.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of Action Manager tool functions
    """
    tools = []

    # Add character tools (remove_character, move_character, list_characters, persist_character_design)
    tools.extend(create_character_tools(ctx))

    # Add location tools (travel, list_locations, persist_location_design)
    tools.extend(create_location_tools(ctx))

    # Add mechanics tools (inject_memory, roll_the_dice, change_stat, advance_time)
    tools.extend(create_mechanics_tools(ctx))

    # Add narrative tools (narration, suggest_options)
    tools.extend(create_narrative_tools(ctx))

    return tools


def create_action_manager_mcp_server(ctx: ToolContext):
    """
    Create an MCP server with Action Manager tools.

    These tools allow Action Manager to invoke sub-agents and modify game state.
    NOTE: Persist tools (persist_item, persist_character_design, persist_location_design)
    are now in the separate "subagents" MCP server.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        MCP server instance with Action Manager tools
    """
    action_manager_tools = create_action_manager_tools(ctx)

    return create_sdk_mcp_server(name="action_manager", version="1.0.0", tools=action_manager_tools)


def create_subagents_tools(ctx: ToolContext) -> list:
    """
    Create subagent persist tools (item, character, location).

    These tools are used by subagents invoked via Task tool by either
    Action Manager or Onboarding Manager.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of subagent persist tool functions
    """
    from .character_tools import create_character_tools
    from .item_tools import create_item_tools
    from .location_tools import create_location_tools

    tools = []

    # Get character persist tool (persist_character_design)
    char_tools = create_character_tools(ctx)
    for tool in char_tools:
        if hasattr(tool, "name") and "persist_character" in tool.name:
            tools.append(tool)

    # Get location persist tool (persist_location_design)
    loc_tools = create_location_tools(ctx)
    for tool in loc_tools:
        if hasattr(tool, "name") and "persist_location" in tool.name:
            tools.append(tool)

    # Get item persist tool (persist_item) from item_tools
    item_tools = create_item_tools(ctx)
    for tool in item_tools:
        if hasattr(tool, "name") and "persist_item" in tool.name:
            tools.append(tool)

    return tools


def create_subagents_mcp_server(ctx: ToolContext):
    """
    Create an MCP server with subagent persist tools.

    These tools are available to subagents (Item Designer, Character Designer,
    Location Designer) when invoked via Task tool by Action Manager or
    Onboarding Manager.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        MCP server instance with subagent tools
    """
    subagent_tools = create_subagents_tools(ctx)

    return create_sdk_mcp_server(name="subagents", version="1.0.0", tools=subagent_tools)


def create_onboarding_mcp_server(ctx: ToolContext):
    """
    Create an MCP server with onboarding tools (draft_world, persist_world, complete).

    These tools are used during the onboarding phase to initialize
    the game world with lore, stats, and starting location.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        MCP server instance with onboarding tools
    """
    onboarding_tools = create_onboarding_tools(ctx)

    return create_sdk_mcp_server(name="onboarding", version="1.0.0", tools=onboarding_tools)
