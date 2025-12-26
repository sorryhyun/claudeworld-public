"""
Input models for subagent tools.

This module defines Pydantic models for validating subagent tool inputs.
These models are used by sub-agents (Character Designer, Location Designer,
Item Designer) invoked via the Task tool.

Note: These models are for internal validation only. YAML configurations
remain the source of truth for tool schemas shown to Claude.
"""

from typing import Optional

from pydantic import BaseModel, Field, field_validator


class PersistCharacterDesignInput(BaseModel):
    """Input for persist_character_design tool.

    Used by Character Designer sub-agent to persist designed character
    to filesystem and database.
    """

    name: str = Field(..., min_length=1, description="Character's name")
    role: str = Field(..., min_length=1, description="Character's role (e.g., merchant, guard)")
    appearance: str = Field(..., min_length=1, description="Physical description")
    personality: str = Field(..., min_length=1, description="Personality traits")
    which_location: str = Field(
        default="current",
        description="Where to place: 'current' or location name",
    )
    secret: Optional[str] = Field(default=None, description="Hidden detail or motivation")
    initial_disposition: str = Field(
        default="neutral",
        description="Initial attitude: friendly, neutral, wary, hostile",
    )

    @field_validator("name", "role", "appearance", "personality", mode="before")
    @classmethod
    def validate_required(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Field is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Field cannot be empty")
        return v


class PersistLocationDesignInput(BaseModel):
    """Input for persist_location_design tool.

    Used by Location Designer sub-agent to persist designed location
    to filesystem and database.
    """

    name: str = Field(..., min_length=1, description="Location slug (snake_case)")
    display_name: str = Field(..., min_length=1, description="Human-readable name")
    description: str = Field(..., min_length=1, description="Rich description")
    position_x: int = Field(default=0, description="X coordinate on map")
    position_y: int = Field(default=0, description="Y coordinate on map")
    adjacent_to: Optional[str] = Field(
        default=None,
        description="Name of adjacent location to connect to",
    )
    is_starting: bool = Field(
        default=False,
        description="Whether this is the starting location (sets player's current_location)",
    )

    @field_validator("name", "display_name", "description", mode="before")
    @classmethod
    def validate_required(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Field is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Field cannot be empty")
        return v


class ItemDefinition(BaseModel):
    """A single item definition for persist_item tool."""

    item_id: str = Field(..., min_length=1, description="Unique item identifier (snake_case)")
    name: str = Field(..., min_length=1, description="Display name for the item")
    description: str = Field(..., min_length=1, description="Item description with lore/visual details")
    quantity: int = Field(default=1, ge=1, description="Quantity to add to inventory (default: 1)")
    properties: dict = Field(default_factory=dict, description="Item properties (damage, armor, heal, etc.)")

    @field_validator("item_id", "name", "description", mode="before")
    @classmethod
    def validate_required(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Field is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Field cannot be empty")
        return v


class PersistItemInput(BaseModel):
    """Input for persist_item tool.

    Used by Item Designer sub-agent to persist one or more item templates to the game world.
    Supports creating multiple items in a single call for efficiency during onboarding.
    """

    items: list[ItemDefinition] = Field(
        ...,
        min_length=1,
        description="List of items to create. Each item will be saved as a template.",
    )
    add_to_inventory: bool = Field(
        default=False,
        description="If true, also add items to player inventory. Use during onboarding for starting items.",
    )
