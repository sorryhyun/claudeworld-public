"""
Tool definitions for the ClaudeWorld SDK.

This package contains tool definition modules (schemas, descriptions, input models)
organized by feature area:

- tool_definitions: Base ToolDefinition dataclass
- action: Action tools (skip, memorize, recall)
- gameplay: Action Manager gameplay tools
- guideline: Guideline tools
- onboarding: Onboarding phase tools
- subagent: Sub-agent persist tools
- character_design: Character design tools
- item: Item tool definitions (private)
- location: Location tool definitions (private)

Handler implementations live in sdk/handlers/.
"""

# Re-export base definition
# Re-export tool dictionaries for yaml_loaders
from sdk.tools.action import ACTION_TOOLS
from sdk.tools.gameplay import ACTION_MANAGER_TOOLS
from sdk.tools.guideline import GUIDELINE_TOOLS
from sdk.tools.onboarding import ONBOARDING_TOOLS
from sdk.tools.subagent import SUBAGENT_TOOLS
from sdk.tools.tool_definitions import ToolDefinition

__all__ = [
    "ToolDefinition",
    "ACTION_TOOLS",
    "ACTION_MANAGER_TOOLS",
    "GUIDELINE_TOOLS",
    "ONBOARDING_TOOLS",
    "SUBAGENT_TOOLS",
]
