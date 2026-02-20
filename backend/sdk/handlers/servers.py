"""
MCP server factories for gameplay, onboarding, and sub-agent tools.

Factory functions that aggregate tool modules into MCP servers:
- Action Manager MCP server (gameplay-phase agents and subagents)
- Subagent MCP server (persist tools for Task-tool sub-agents)
- Onboarding MCP server (onboarding-phase agents)
- Character Design MCP server (detailed character creation for onboarding)
"""

from claude_agent_sdk import create_sdk_mcp_server

from sdk.handlers.character_design_tools import create_character_design_tools
from sdk.handlers.character_tools import create_character_tools
from sdk.handlers.context import ToolContext
from sdk.handlers.equipment_tools import create_equipment_tools
from sdk.handlers.history_tools import create_history_tools
from sdk.handlers.item_tools import create_item_tools
from sdk.handlers.location_tools import create_location_tools
from sdk.handlers.mechanics_tools import create_mechanics_tools
from sdk.handlers.narrative_tools import create_narrative_tools
from sdk.handlers.onboarding_tools import (
    SUBAGENT_TOOL_NAMES,
    create_onboarding_tools,
)

__all__ = [
    # Action Manager tools
    "create_action_manager_tools",
    "create_action_manager_mcp_server",
    # Onboarding Manager tools
    "create_onboarding_tools",
    "create_onboarding_mcp_server",
    # Character Design tools
    "create_character_design_tools",
    "create_character_design_mcp_server",
    # Subagent tools
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

    # Add equipment tools (equip_item, unequip_item, use_item, list_equipment, set_flag) - Phase 2
    tools.extend(create_equipment_tools(ctx))

    # Add history tools (recall_history) - for recalling past events from consolidated history
    tools.extend(create_history_tools(ctx))

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


def create_character_design_mcp_server(ctx: ToolContext):
    """
    Create an MCP server with character design tools (create_comprehensive_character, implant_consolidated_memory).

    These tools are used during onboarding by the detailed_character_designer agent
    to create rich, memorable characters with deep backstories and consolidated memories.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        MCP server instance with character design tools
    """
    character_design_tools = create_character_design_tools(ctx)

    return create_sdk_mcp_server(name="character_design", version="1.0.0", tools=character_design_tools)
