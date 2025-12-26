"""
Agent tools for controlling agent behavior.

This module re-exports all tool creation functions from specialized modules
for backward compatibility. New code should import directly from the specific
modules:
- action_tools: skip, memorize, recall tools (for chat agents)
- guidelines_tools: guidelines read tool (for chat agents)
- gameplay_tools/: gameplay phase tools (includes onboarding)
  - character_tools: remove_character, persist_character_design, etc. (Action Manager)
  - location_tools: travel, persist_location_design, etc. (Action Manager)
  - mechanics_tools: narration, suggest_options, change_stat (Action Manager)
  - onboarding_tools: draft_world, persist_world, complete (Onboarding)
"""

# Re-export action tools
from sdk.tools.action_tools import create_action_mcp_server, create_action_tools

# Re-export gameplay tools (for TRPG gameplay and onboarding)
from sdk.tools.gameplay_tools import (
    SUBAGENT_TOOL_NAMES,
    create_action_manager_mcp_server,
    create_action_manager_tools,
    create_onboarding_mcp_server,
    create_onboarding_tools,
    create_subagents_mcp_server,
    create_subagents_tools,
)

# Re-export guidelines tools
from sdk.tools.guidelines_tools import create_guidelines_mcp_server

__all__ = [
    # Action tools (for chat agents)
    "create_action_tools",
    "create_action_mcp_server",
    # Guidelines tools (for chat agents)
    "create_guidelines_mcp_server",
    # Onboarding tools (for TRPG)
    "create_onboarding_tools",
    "create_onboarding_mcp_server",
    # Gameplay tools (for TRPG gameplay)
    "create_action_manager_tools",
    "create_action_manager_mcp_server",
    # Subagent tools (shared between Action Manager and Onboarding Manager)
    "create_subagents_tools",
    "create_subagents_mcp_server",
    # Subagent tool name mappings
    "SUBAGENT_TOOL_NAMES",
]
