"""
Input models for common action tools.

This module defines Pydantic models for validating action tool inputs.
These models provide type-safe validation and consistent error messages.

Note: These models are for internal validation only. YAML configurations
remain the source of truth for tool schemas shown to Claude.
"""

from pydantic import BaseModel, Field, field_validator  # noqa: I001


# =============================================================================
# Skip Tool Input
# =============================================================================


class SkipInput(BaseModel):
    """Input for skip tool.

    Used when an agent decides to skip their turn.
    This tool has no required inputs.
    """

    pass


# =============================================================================
# Memorize Tool Input
# =============================================================================


class MemorizeInput(BaseModel):
    """Input for memorize tool.

    Used for recording significant events as one-liners to recent_events.
    """

    memory_entry: str = Field(
        ...,
        min_length=1,
        description='A brief one-liner summary (e.g., "Met the merchant - felt suspicious")',
    )

    @field_validator("memory_entry", mode="before")
    @classmethod
    def validate_memory_entry(cls, v: str | None) -> str:
        """Ensure memory entry is provided and stripped."""
        if v is None:
            raise ValueError("Memory entry is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Memory entry cannot be empty")
        return v


# =============================================================================
# Recall Tool Input
# =============================================================================


class RecallInput(BaseModel):
    """Input for recall tool.

    Used for retrieving detailed memory entries from long-term memory.
    """

    subtitle: str = Field(
        ...,
        min_length=1,
        description="The subtitle of the memory to recall",
    )

    @field_validator("subtitle", mode="before")
    @classmethod
    def validate_subtitle(cls, v: str | None) -> str:
        """Ensure subtitle is provided and stripped."""
        if v is None:
            raise ValueError("Subtitle is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Subtitle cannot be empty")
        return v
