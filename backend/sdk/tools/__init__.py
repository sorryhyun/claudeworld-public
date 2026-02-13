"""
Agent tools for controlling agent behavior.

This module re-exports all tool creation functions from specialized modules.
- action_tools: skip, memorize, recall tools (for chat agents)
- guidelines_tools: guidelines read tool (for chat agents)
- servers: MCP server factories (action manager, onboarding, subagents, character design)
- Individual tool modules: character, location, mechanics, narrative, equipment, etc.
"""

# Re-export action tools
from sdk.tools.action_tools import create_action_mcp_server, create_action_tools

# Re-export guidelines tools
from sdk.tools.guidelines_tools import create_guidelines_mcp_server

# Re-export onboarding tools
from sdk.tools.onboarding_tools import SUBAGENT_TOOL_NAMES

# Re-export server factories
from sdk.tools.servers import (
    create_action_manager_mcp_server,
    create_action_manager_tools,
    create_character_design_mcp_server,
    create_character_design_tools,
    create_onboarding_mcp_server,
    create_onboarding_tools,
    create_subagents_mcp_server,
    create_subagents_tools,
)

__all__ = [
    # Action tools (for chat agents)
    "create_action_tools",
    "create_action_mcp_server",
    # Guidelines tools (for chat agents)
    "create_guidelines_mcp_server",
    # Onboarding tools (for TRPG)
    "create_onboarding_tools",
    "create_onboarding_mcp_server",
    # Character design tools (for detailed character creation in onboarding)
    "create_character_design_tools",
    "create_character_design_mcp_server",
    # Gameplay tools (for TRPG gameplay)
    "create_action_manager_tools",
    "create_action_manager_mcp_server",
    # Subagent tools (shared between Action Manager and Onboarding Manager)
    "create_subagents_tools",
    "create_subagents_mcp_server",
    # Subagent tool name mappings
    "SUBAGENT_TOOL_NAMES",
]
