"""
Onboarding tool definitions.

Defines tools for the onboarding phase (world initialization).
Used by Onboarding Manager to create worlds, set up stats, and complete onboarding.

Combines input models and tool definitions in one place.

The onboarding flow:
1. draft_world - Quick summary to unblock sub-agents
2. Sub-agents run in background with draft context
3. persist_world - Full lore + stats (overwrites draft)
4. complete - Phase transition
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator  # noqa: I001

from .tool_definitions import ToolDefinition, ToolDict

# =============================================================================
# Lore Guidelines Tool Input (Read-only reference)
# =============================================================================


class ReadLoreGuidelinesInput(BaseModel):
    """Input for read_lore_guidelines tool - no required fields."""

    pass


# =============================================================================
# Shared Models (used by multiple tools)
# =============================================================================


class StatDefinition(BaseModel):
    """A single stat definition for the game world."""

    name: str = Field(..., description="Internal stat name (e.g., 'health', 'mana')")
    display: str = Field(..., description="Display name shown to player (e.g., 'HP', 'MP')")
    min: int | None = Field(0, description="Minimum value (default: 0)")
    max: int | None = Field(100, description="Maximum value (null for unlimited)")
    default: int = Field(..., description="Starting value for new players")
    color: str | None = Field(None, description="Optional hex color for UI (e.g., '#ff0000')")


class StatSystem(BaseModel):
    """Complete stat system definition."""

    stats: list[StatDefinition] = Field(..., description="List of stat definitions", min_length=1)
    derived: list[dict[str, Any]] | None = Field(
        default_factory=list, description="Optional derived stats (computed from base stats)"
    )


class InventoryItem(BaseModel):
    """An inventory item representation.

    Used throughout the codebase to represent items in player inventory.
    For creating item templates via item_designer, use PersistItemInput.
    """

    item_id: str = Field(..., description="Unique item identifier (snake_case recommended)")
    name: str = Field(..., description="Display name")
    description: str | None = Field(None, description="Item description")
    quantity: int = Field(1, description="Number of this item (default: 1)")
    properties: dict[str, Any] | None = Field(default_factory=dict, description="Custom properties")

    @field_validator("item_id", mode="before")
    @classmethod
    def validate_item_id(cls, v: str | None) -> str:
        """Ensure item_id is provided, stripped, and filesystem-safe."""
        if v is None:
            raise ValueError("Item ID is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Item ID cannot be empty")
        # Sanitize for filesystem safety
        safe_chars = set("abcdefghijklmnopqrstuvwxyz0123456789_-")
        if not all(c in safe_chars for c in v.lower()):
            raise ValueError("Item ID must contain only alphanumeric characters, underscores, and hyphens")
        return v

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, v: str | None) -> str:
        """Ensure name is provided and stripped."""
        if v is None:
            raise ValueError("Item name is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Item name cannot be empty")
        return v

    @field_validator("description", mode="before")
    @classmethod
    def strip_description(cls, v: str | None) -> str | None:
        """Strip whitespace and handle None values."""
        if v is None:
            return None
        return str(v).strip() or None


# =============================================================================
# Draft World Tool Input (Lightweight - unblocks sub-agents)
# =============================================================================


class DraftWorldInput(BaseModel):
    """Input for draft_world tool.

    Lightweight world draft that provides enough context for sub-agents
    to start creating content. Called BEFORE sub-agents, which run in
    background while OM refines the full lore.
    """

    genre: str = Field(
        ...,
        min_length=1,
        description="World genre (e.g., 'dark fantasy', 'sci-fi horror', 'cozy mystery')",
    )
    theme: str = Field(
        ...,
        min_length=1,
        description="Thematic elements (e.g., 'survival and redemption', 'political intrigue')",
    )
    lore_summary: str = Field(
        ...,
        min_length=50,
        max_length=1000,
        description="One-paragraph summary of the world concept (50-1000 chars). "
        "Captures the essential setting, conflict, and atmosphere. "
        "Sub-agents use this context to create thematically consistent content.",
    )

    @field_validator("genre", "theme", mode="before")
    @classmethod
    def validate_required_string(cls, v: str | None) -> str:
        """Ensure required string fields are provided and stripped."""
        if v is None:
            raise ValueError("Field is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Field cannot be empty")
        return v

    @field_validator("lore_summary", mode="before")
    @classmethod
    def validate_lore_summary(cls, v: str | None) -> str:
        """Ensure lore summary is provided and within bounds."""
        if v is None:
            raise ValueError("Lore summary is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Lore summary cannot be empty")
        if len(v) < 50:
            raise ValueError("Lore summary must be at least 50 characters")
        if len(v) > 1000:
            raise ValueError("Lore summary must be at most 1000 characters")
        return v


# =============================================================================
# Persist World Tool Input (Comprehensive - consolidates everything)
# =============================================================================


class PersistWorldInput(BaseModel):
    """Input for persist_world tool.

    Comprehensive world persistence that consolidates full lore with
    stat system and player state. Called AFTER sub-agents have started
    with draft context. Overwrites the draft lore with full version.
    """

    # Full lore (overwrites draft)
    lore: str = Field(
        ...,
        min_length=100,
        description="Comprehensive world lore (8-15 paragraphs). "
        "Call read_lore_guidelines first for structure and checklist.",
    )

    # Stat system
    stat_system: StatSystem = Field(..., description="The stat system for this world (4-6 stats)")

    # Optional overrides
    initial_stats: dict[str, int] | None = Field(
        None, description="Override starting stat values (uses defaults if not provided)"
    )
    world_notes: str | None = Field(None, description="Additional notes about the world for other agents")

    @field_validator("lore", mode="before")
    @classmethod
    def validate_lore(cls, v: str | None) -> str:
        """Ensure lore is provided, stripped, and has substantial content."""
        if v is None:
            raise ValueError("Lore is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Lore cannot be empty")
        if len(v) < 100:
            raise ValueError("Lore must be at least 100 characters")
        return v


# =============================================================================
# Onboarding Complete Tool Input
# =============================================================================


class CompleteOnboardingInput(BaseModel):
    """Input for complete onboarding tool (lightweight phase transition).

    Used by Onboarding Manager to finalize onboarding and transition
    from onboarding phase to active gameplay.

    This is called AFTER:
    - draft_world (genre, theme, lore summary)
    - Sub-agents (location_designer, character_designer, item_designer)
    - persist_world (full lore, stats)
    """

    player_name: str = Field(
        ...,
        min_length=1,
        description="The name the player wants to be called in the world",
    )
    starting_location: str = Field(
        ...,
        min_length=1,
        description="The location name (internal name, not display name) where the player's adventure begins. "
        "Must match one of the locations created by location_designer.",
    )
    starting_hour: int = Field(
        default=8,
        ge=0,
        le=23,
        description="The hour of day to start the adventure (0-23, default: 8 for morning)",
    )

    @field_validator("player_name", mode="before")
    @classmethod
    def validate_player_name(cls, v: str | None) -> str:
        """Ensure player_name is provided and stripped."""
        if v is None:
            raise ValueError("Player name is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Player name cannot be empty")
        return v

    @field_validator("starting_location", mode="before")
    @classmethod
    def validate_starting_location(cls, v: str | None) -> str:
        """Ensure starting_location is provided and stripped."""
        if v is None:
            raise ValueError("Starting location is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Starting location cannot be empty")
        return v

    @field_validator("starting_hour", mode="before")
    @classmethod
    def validate_starting_hour(cls, v: int | None) -> int:
        """Ensure starting_hour is valid."""
        if v is None:
            return 8  # Default to 8 AM
        v = int(v)
        if v < 0 or v > 23:
            raise ValueError("Starting hour must be between 0 and 23")
        return v


# =============================================================================
# Tool Definitions
# =============================================================================


ONBOARDING_TOOLS: ToolDict = {
    "read_lore_guidelines": ToolDefinition(
        name="mcp__onboarding__read_lore_guidelines",
        description="""\
Return the lore writing guidelines for world creation.
Call this tool to review the recommended structure, layers, and checklist
for creating comprehensive world lore before calling draft_world or persist_world.""",
        input_model=ReadLoreGuidelinesInput,
        # Response content is loaded from lore_guidelines.yaml via get_tool_description("lore_guidelines")
        response="{lore_guidelines_content}",
        enabled=True,
    ),
    "draft_world": ToolDefinition(
        name="mcp__onboarding__draft_world",
        description="""\
Create a lightweight world draft with genre, theme, and lore summary.
Call this FIRST to unblock sub-agents. They will use this context to
create thematically consistent content while you refine the full lore.""",
        input_model=DraftWorldInput,
        response="""\
World draft created.
Genre: {genre}
Theme: {theme}
Sub-agents can now start with this context.""",
        enabled=True,
    ),
    "persist_world": ToolDefinition(
        name="mcp__onboarding__persist_world",
        description="""\
Persist comprehensive world data: full lore + stat system + player state.
Call this AFTER sub-agents have started with draft_world context.
Overwrites the draft lore with the full version.""",
        input_model=PersistWorldInput,
        response="""\
World persisted successfully.
Stats: {stat_count}
Lore: {lore_length} characters""",
        enabled=True,
    ),
    "complete": ToolDefinition(
        name="mcp__onboarding__complete",
        description="""\
Complete the onboarding phase and transition the world to active.
This is a lightweight tool that finalizes the onboarding process.

Call this tool LAST, after:
1. draft_world (genre, theme, lore summary)
2. Sub-agents (location_designer, character_designer, item_designer)
3. persist_world (full lore, stats)

You MUST specify the starting_location - use the internal name (not display name)
of the location where the player's adventure begins.""",
        input_model=CompleteOnboardingInput,
        response="""\
World initialized successfully.
Player: {player_name}
Starting location: {starting_location}
Starting time: {starting_hour}:00
Phase: active

The world is now ready for adventure!""",
        enabled=True,
    ),
}
