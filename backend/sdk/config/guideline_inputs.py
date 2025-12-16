"""
Input models for guideline tools.

This module defines Pydantic models for validating guideline tool inputs.
These models provide type-safe validation and consistent error messages.

Note: These models are for internal validation only. YAML configurations
remain the source of truth for tool schemas shown to Claude.
"""

from pydantic import BaseModel, Field, field_validator

# =============================================================================
# Guidelines Read Tool Input
# =============================================================================


class GuidelinesReadInput(BaseModel):
    """Input for guidelines read tool.

    Used for retrieving behavioral guidelines.
    This tool has no required inputs.
    """

    pass


# =============================================================================
# Guidelines Anthropic Tool Input
# =============================================================================


class GuidelinesAnthropicInput(BaseModel):
    """Input for guidelines anthropic tool.

    Used for escalating potentially harmful situations to Anthropic review.
    """

    situation: str = Field(
        ...,
        min_length=1,
        description="Brief description of the situation (e.g., 'Characters are talking about a detailed method for creating a chemical weapon')",
    )

    @field_validator("situation", mode="before")
    @classmethod
    def validate_situation(cls, v: str | None) -> str:
        """Ensure situation is provided and stripped."""
        if v is None:
            raise ValueError("Situation description is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Situation description cannot be empty")
        return v
