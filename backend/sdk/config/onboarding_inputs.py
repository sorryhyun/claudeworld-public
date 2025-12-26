"""
Input models for onboarding tools.

This module defines Pydantic models for validating onboarding tool inputs.
These models provide type-safe validation and consistent error messages.

Includes:
- DraftWorldInput: Lightweight world draft (genre, theme, lore summary)
- PersistWorldInput: Comprehensive world persistence (full lore + stats)
- CompleteOnboardingInput: Phase transition
- Shared models (StatDefinition, StatSystem, InventoryItem)

The onboarding flow:
1. draft_world - Quick summary to unblock sub-agents
2. Sub-agents run in background with draft context
3. persist_world - Full lore + stats (overwrites draft)
4. complete - Phase transition

Note: These models are for internal validation only. YAML configurations
remain the source of truth for tool schemas shown to Claude.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

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
        description="""Comprehensive world lore (8-15 paragraphs) that establishes:

**Foundation Layer:**
- Origin/creation myth or historical foundation
- Core metaphysics (how magic/technology/power works and its costs)
- Geography overview (continents, key regions, climate)

**Power & Society:**
- Major factions, nations, or organizations and their tensions
- Social hierarchy and class dynamics
- Economy basics (what's valuable, trade, currency)

**Current State:**
- Recent history (past 50-100 years of major events)
- The current crisis, tension, or situation driving the world
- Where power currently sits and who threatens it

**Culture & Daily Life:**
- Dominant religions, philosophies, or belief systems
- Common people's lives, fears, and aspirations
- Taboos, laws, or cultural practices that shape behavior

**Mystery & Wonder:**
- Unexplained phenomena or ancient mysteries
- Legendary places, artifacts, or figures
- What the world whispers about but doesn't understand

The lore should feel lived-in—specific names, places, and details that make it tangible. Include at least 5-8 proper nouns (people, places, organizations) that the player might encounter.""",
    )

    # Stat system
    stat_system: "StatSystem" = Field(..., description="The stat system for this world (4-6 stats)")

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


# NOTE: InitialLocation moved to location_designer subagent
# Location creation is now handled by the location_designer subagent invoked via Task tool


class InventoryItem(BaseModel):
    """An inventory item representation.

    Used throughout the codebase to represent items in player inventory.
    For creating item templates via item_designer, use PersistItemInput
    from subagent_inputs.py.
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
