"""
Tool definition models for SDK configuration.

This module provides the base dataclass for defining tool definitions
that combine descriptions and input schemas in one place.

Usage:
    from sdk.config.tool_definitions import ToolDefinition
    from sdk.config.action_tools import ACTION_TOOLS

    tool = ACTION_TOOLS["skip"]
    print(tool.description)
    print(tool.input_schema)  # JSON schema from Pydantic model
"""

from dataclasses import dataclass
from typing import Any, Type

from pydantic import BaseModel


@dataclass
class ToolDefinition:
    """
    Complete tool definition with description and input schema.

    Attributes:
        name: Full tool name (e.g., "mcp__action_manager__travel")
        description: Description shown to Claude explaining the tool's purpose.
                    Supports template variables: {agent_name}, {memory_subtitles}, etc.
        input_model: Pydantic model for input validation and schema generation
        response: Response template returned after tool execution.
                 Supports template variables like {result}, {memory_content}, etc.
        enabled: Whether the tool is enabled (default: True)
    """

    name: str
    description: str
    input_model: Type[BaseModel]
    response: str = ""
    enabled: bool = True

    @property
    def input_schema(self) -> dict[str, Any]:
        """Generate JSON schema from Pydantic model."""
        return self.input_model.model_json_schema()

    def format_description(self, **kwargs: Any) -> str:
        """Format description with template variables."""
        try:
            return self.description.format(**kwargs)
        except KeyError:
            return self.description

    def format_response(self, **kwargs: Any) -> str:
        """Format response with template variables."""
        try:
            return self.response.format(**kwargs)
        except KeyError:
            return self.response


# Type alias for tool dictionaries
ToolDict = dict[str, ToolDefinition]


# =============================================================================
# Backward Compatibility
# =============================================================================

# Alias for legacy code that uses ToolDescription
# TODO: Remove after migration is complete
ToolDescription = ToolDefinition


@dataclass
class LegacyToolDescription:
    """
    Legacy tool description without input_model.

    Used during migration for tools that haven't been consolidated yet.
    Provides same interface as ToolDefinition but without input_model requirement.
    """

    name: str
    description: str
    response: str = ""
    enabled: bool = True

    def format_description(self, **kwargs: Any) -> str:
        """Format description with template variables."""
        try:
            return self.description.format(**kwargs)
        except KeyError:
            return self.description

    def format_response(self, **kwargs: Any) -> str:
        """Format response with template variables."""
        try:
            return self.response.format(**kwargs)
        except KeyError:
            return self.response


# Type alias for legacy tool dictionaries
LegacyToolDict = dict[str, LegacyToolDescription]
