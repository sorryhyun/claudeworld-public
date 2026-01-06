"""
Subagent tool definitions.

Defines tools specific to sub-agents invoked via the Task tool.
Sub-agents (Item Designer, Character Designer, Location Designer) are invoked
by Action Manager or Onboarding Manager to create game content.

Combines input models and tool definitions in one place.
"""

from typing import Any, Optional  # noqa: I001

from pydantic import BaseModel, Field, field_validator

from .tool_definitions import ToolDefinition, ToolDict


# =============================================================================
# Item Component Models (for new world-agnostic item system)
# =============================================================================


class StatRequirement(BaseModel):
    """A stat requirement with min/max bounds."""

    min: float | None = None
    max: float | None = None


class StatChange(BaseModel):
    """A stat change (cost or effect)."""

    stat: str
    delta: float


class FlagChange(BaseModel):
    """A flag change."""

    flag: str
    value: bool


class ItemConsumption(BaseModel):
    """Item consumption specification."""

    item_id: str
    quantity: int = 1


class ChargeConfig(BaseModel):
    """Charge/uses configuration."""

    max: int | None = None
    consume: int = 1
    recharge: dict[str, Any] | None = None  # {event: str, amount: int}


class CooldownConfig(BaseModel):
    """Cooldown configuration."""

    domain: str
    value: int


class AffordanceRequirements(BaseModel):
    """Requirements to use an affordance."""

    stats: dict[str, StatRequirement] | None = None
    flags_all: list[str] | None = None
    flags_any: list[str] | None = None
    flags_none: list[str] | None = None
    items: list[str] | None = None


class AffordanceCost(BaseModel):
    """Costs of using an affordance."""

    stat_changes: list[StatChange] | None = None
    consume_items: list[ItemConsumption] | None = None


class AffordanceEffects(BaseModel):
    """Effects of using an affordance."""

    stat_changes: list[StatChange] | None = None
    set_flags: list[FlagChange] | None = None
    grant_items: list[ItemConsumption] | None = None
    remove_self: bool | None = None


class Affordance(BaseModel):
    """A single usable action an item provides."""

    id: str
    label: str
    requirements: AffordanceRequirements | None = None
    cost: AffordanceCost | None = None
    effects: AffordanceEffects | None = None
    charges: ChargeConfig | None = None
    cooldown: CooldownConfig | None = None


class StackingConfig(BaseModel):
    """Stacking behavior configuration."""

    stackable: bool = True
    max_stack: int | None = None
    unique: bool = False


class EquippableConfig(BaseModel):
    """Equipment configuration."""

    slot: str
    accepts_as: list[str] | None = None
    passive_effects: dict[str, float] | None = None


class UsableConfig(BaseModel):
    """Usable actions configuration."""

    affordances: list[Affordance]


# =============================================================================
# Input Models
# =============================================================================


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
    adjacent_to: Optional[list[str]] = Field(
        default=None,
        description="Name(s) of adjacent location(s) to connect to",
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

    @field_validator("adjacent_to", mode="before")
    @classmethod
    def normalize_adjacent_to(cls, v: str | list[str] | None) -> list[str] | None:
        """Accept both a single string or a list of strings."""
        if v is None:
            return None
        if isinstance(v, str):
            return [v]
        return v


class ItemDefinition(BaseModel):
    """A single item definition for persist_item tool.

    Supports both legacy format (properties dict) and new component-based format
    (category, tags, stacking, equippable, usable). All new fields are optional
    for backward compatibility.
    """

    # Required fields
    item_id: str = Field(..., min_length=1, description="Unique item identifier (snake_case)")
    name: str = Field(..., min_length=1, description="Display name for the item")
    description: str = Field(..., min_length=1, description="Item description with lore/visual details")

    # Optional: quantity for inventory operations
    quantity: int = Field(default=1, ge=1, description="Quantity to add to inventory (default: 1)")

    # NEW: Classification (optional, descriptive only)
    category: str | None = Field(
        default=None,
        description="Item category: gift, credential, clue, tool, ability, status, "
        "relationship, material, document, vehicle, equipment, consumable",
    )
    tags: list[str] | None = Field(
        default=None,
        description="Tags for filtering/behavior: [romance, combat, consumable, unique]",
    )
    rarity: str | None = Field(
        default=None,
        description="Rarity tier: common, uncommon, rare, epic, legendary",
    )
    icon: str | None = Field(
        default=None,
        description="UI hint for icon display",
    )

    # NEW: Behavior components (optional)
    stacking: StackingConfig | None = Field(
        default=None,
        description="Stacking rules: {stackable, max_stack, unique}",
    )
    equippable: EquippableConfig | None = Field(
        default=None,
        description="Equipment config: {slot, accepts_as, passive_effects}",
    )
    usable: UsableConfig | None = Field(
        default=None,
        description="Usable actions: {affordances: [...]}",
    )

    # EXISTING: Backward-compatible properties
    properties: dict = Field(
        default_factory=dict,
        description="Additional item properties (legacy format, also stored as default_properties)",
    )

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


# =============================================================================
# Tool Definitions
# =============================================================================


SUBAGENT_TOOLS: ToolDict = {
    "persist_character_design": ToolDefinition(
        name="mcp__subagents__persist_character_design",
        description="""\
Persist a character design to the game world.
Used by Character Designer sub-agent after designing a character.
Creates the character in filesystem and database.""",
        input_model=PersistCharacterDesignInput,
        response="{persist_result}",
        enabled=True,
    ),
    "persist_location_design": ToolDefinition(
        name="mcp__subagents__persist_location_design",
        description="""\
Persist a location design to the game world.
Used by Location Designer sub-agent after designing a location.
Creates the location in filesystem and database.""",
        input_model=PersistLocationDesignInput,
        response="{persist_result}",
        enabled=True,
    ),
    "persist_item": ToolDefinition(
        name="mcp__subagents__persist_item",
        description="""\
Persist an item design to the game world.
Used by Item Designer sub-agent after designing an item.
Creates the item template in filesystem (items/[item_id].yaml).

**Returns error if:**
- Item ID already exists (use existing item instead)
- Item ID contains invalid characters""",
        input_model=PersistItemInput,
        response="{persist_result}",
        enabled=True,
    ),
}
