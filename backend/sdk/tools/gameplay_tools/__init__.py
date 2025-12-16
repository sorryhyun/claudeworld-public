"""
Gameplay tools for TRPG.

This package contains tools used during TRPG gameplay and onboarding:

Action Manager MCP server (for gameplay-phase agents and subagents):
- Character tools: remove_character, move_character, list_characters, persist_character_design
- Location tools: travel, list_locations, persist_location_design
- Mechanics tools: inject_memory, narration, suggest_options, persist_stat_changes

Onboarding MCP server (for onboarding-phase agents and subagents):
- Onboarding tools: complete (world initialization), persist_world_seed

Note: Each persist tool is in the same MCP server as its parent agent's tools,
so subagents can access them when invoked via Task tool.

Re-exports:
- create_action_manager_tools: Create all Action Manager tools
- create_action_manager_mcp_server: Create MCP server with Action Manager tools
- create_onboarding_tools: Create onboarding tools (includes persist_world_seed)
- create_onboarding_mcp_server: Create MCP server with onboarding tools
- SUBAGENT_TOOL_NAMES: Mapping of sub-agent types to their persist tool names
"""

from claude_agent_sdk import create_sdk_mcp_server

from sdk.tools.context import ToolContext

from .character_tools import create_character_tools
from .location_tools import create_location_tools
from .mechanics_tools import create_mechanics_tools
from .onboarding_tools import (
    SUBAGENT_TOOL_NAMES,
    create_onboarding_tools,
)

__all__ = [
    # Action Manager tools
    "create_action_manager_tools",
    "create_action_manager_mcp_server",
    "create_character_tools",
    "create_location_tools",
    "create_mechanics_tools",
    # Onboarding Manager tools
    "create_onboarding_tools",
    "create_onboarding_mcp_server",
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

    # Add character tools (add_character, remove_character)
    tools.extend(create_character_tools(ctx))

    # Add location tools (travel, summarize)
    tools.extend(create_location_tools(ctx))

    # Add mechanics tools (stat_calc, narration, suggest_options)
    tools.extend(create_mechanics_tools(ctx))

    return tools


def create_action_manager_mcp_server(ctx: ToolContext):
    """
    Create an MCP server with Action Manager tools.

    These tools allow Action Manager to invoke sub-agents and modify game state.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        MCP server instance with Action Manager tools
    """
    action_manager_tools = create_action_manager_tools(ctx)

    return create_sdk_mcp_server(name="action_manager", version="1.0.0", tools=action_manager_tools)


def create_onboarding_mcp_server(ctx: ToolContext):
    """
    Create an MCP server with onboarding tools (complete, persist_world_seed).

    These tools are used during the onboarding phase to initialize
    the game world with lore, stats, and starting location.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        MCP server instance with onboarding tools
    """
    onboarding_tools = create_onboarding_tools(ctx)

    return create_sdk_mcp_server(name="onboarding", version="1.0.0", tools=onboarding_tools)
