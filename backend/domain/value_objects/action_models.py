"""
Action tool output models for MCP tool responses.

This module defines Pydantic models for action tool (skip, memorize, recall)
outputs, providing type-safe validation and structured data.

Note: Input models are in sdk/config/action_inputs.py
"""

from typing import Any, Optional

from pydantic import BaseModel, Field


# Output Models
class ToolResponse(BaseModel):
    """Base model for tool responses."""

    content: list[dict[str, str]] = Field(default_factory=list)


class SkipOutput(BaseModel):
    """Output model for skip tool."""

    response: str = Field(..., description="Confirmation message for skip action")

    def to_tool_response(self) -> dict[str, Any]:
        """Convert to MCP tool response format."""
        return {"content": [{"type": "text", "text": self.response}]}


class MemorizeOutput(BaseModel):
    """Output model for memorize tool."""

    response: str = Field(..., description="Confirmation message with the memorized entry")
    memory_entry: str = Field(..., description="The memory entry that was recorded")

    def to_tool_response(self) -> dict[str, Any]:
        """Convert to MCP tool response format."""
        return {"content": [{"type": "text", "text": self.response}]}


class RecallOutput(BaseModel):
    """Output model for recall tool."""

    response: str = Field(..., description="The retrieved memory content or error message")
    success: bool = Field(..., description="Whether the memory was found")
    subtitle: str = Field(..., description="The subtitle that was queried")
    memory_content: Optional[str] = Field(None, description="The full memory content if found")

    def to_tool_response(self) -> dict[str, Any]:
        """Convert to MCP tool response format."""
        return {"content": [{"type": "text", "text": self.response}]}
