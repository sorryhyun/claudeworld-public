"""
Action tool definitions.

Defines the action tools available to agents: skip, memorize, recall.
These are the core tools for agent behavior control.

Combines input models and tool definitions in one place.
"""

from pydantic import BaseModel, Field, field_validator  # noqa: I001

from .tool_definitions import ToolDefinition, ToolDict


# =============================================================================
# Input Models
# =============================================================================


class SkipInput(BaseModel):
    """Input for skip tool.

    Used when an agent decides to skip their turn.
    This tool has no required inputs.
    """

    pass


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


# =============================================================================
# Tool Definitions
# =============================================================================


ACTION_TOOLS: ToolDict = {
    "skip": ToolDefinition(
        name="mcp__action__skip",
        description=(
            "Skip this turn when {agent_name} has left the scene or the message "
            "doesn't warrant {agent_name}'s engagement. Others will continue without you."
        ),
        input_model=SkipInput,
        response="You have decided to skip this message. You will not respond.",
        enabled=True,
    ),
    "memorize": ToolDefinition(
        name="mcp__action__memorize",
        description=(
            "Record significant events as one-liners when 'TodoWrite' reminder is triggered. "
            'Format: "Event description - emotional core"'
        ),
        input_model=MemorizeInput,
        response=("Memory recorded: {memory_entry}\n\nThis event has been added to your memory for future reference."),
        # Can be overridden by ENABLE_MEMORY_TOOL environment variable
        enabled=True,
    ),
    "recall": ToolDefinition(
        name="mcp__action__recall",
        description=(
            "Retrieve a detailed memory entry by subtitle from {agent_name}'s long-term memories. "
            "Use this when {agent_name} is reacting to a past event, relationship, or promise "
            "and needs concrete details (and their current feelings about it) to respond in-character.\n"
            "Available memories: {memory_subtitles}"
        ),
        input_model=RecallInput,
        response="{memory_content}",
        # Automatically enabled for agents with long_term_memory.md file
        enabled=True,
    ),
}
