"""
Item tool definitions.

Defines tools for inventory management, equipment, and item usage.
Used by Action Manager for all item-related operations.
"""

from pydantic import BaseModel, Field, field_validator

from .tool_definitions import ToolDefinition, ToolDict

# =============================================================================
# Inventory Tool Inputs
# =============================================================================


class ListInventoryInput(BaseModel):
    """Input for list_inventory tool.

    Used for listing all items in the player's inventory.
    This tool takes no required inputs.
    """

    pass


class ListWorldItemInput(BaseModel):
    """Input for list_world_item tool.

    Used for listing all item templates in the world or filtering by keyword.
    """

    keyword: str = Field(
        default="",
        description="Optional keyword to filter items by name or description. Leave empty to list all items.",
    )

    @field_validator("keyword", mode="before")
    @classmethod
    def strip_keyword(cls, v: str | None) -> str:
        """Strip whitespace and handle None values."""
        if v is None:
            return ""
        return str(v).strip().lower()


# =============================================================================
# Equipment Tool Inputs
# =============================================================================


class EquipItemInput(BaseModel):
    """Input for equip_item tool.

    Used for equipping items from inventory to equipment slots.
    """

    item_id: str = Field(
        ...,
        min_length=1,
        description="ID of the item to equip",
    )
    slot: str | None = Field(
        default=None,
        description="Target equipment slot. If not specified, auto-detects from item template.",
    )

    @field_validator("item_id", mode="before")
    @classmethod
    def validate_item_id(cls, v: str | None) -> str:
        """Ensure item_id is provided and stripped."""
        if v is None:
            raise ValueError("item_id is required")
        v = str(v).strip()
        if not v:
            raise ValueError("item_id cannot be empty")
        return v

    @field_validator("slot", mode="before")
    @classmethod
    def strip_slot(cls, v: str | None) -> str | None:
        """Strip whitespace from slot."""
        if v is None:
            return None
        v = str(v).strip()
        return v if v else None


class UnequipItemInput(BaseModel):
    """Input for unequip_item tool.

    Used for unequipping items from equipment slots.
    """

    slot: str = Field(
        ...,
        min_length=1,
        description="Equipment slot to unequip from",
    )

    @field_validator("slot", mode="before")
    @classmethod
    def validate_slot(cls, v: str | None) -> str:
        """Ensure slot is provided and stripped."""
        if v is None:
            raise ValueError("slot is required")
        v = str(v).strip()
        if not v:
            raise ValueError("slot cannot be empty")
        return v


class UseItemInput(BaseModel):
    """Input for use_item tool.

    Used for activating item affordances (abilities/effects).
    """

    item_id: str = Field(
        ...,
        min_length=1,
        description="ID of the item to use",
    )
    affordance_id: str = Field(
        ...,
        min_length=1,
        description="ID of the affordance (action) to invoke",
    )
    context: dict | None = Field(
        default=None,
        description="Optional context for the action (e.g., target character)",
    )

    @field_validator("item_id", mode="before")
    @classmethod
    def validate_item_id(cls, v: str | None) -> str:
        """Ensure item_id is provided and stripped."""
        if v is None:
            raise ValueError("item_id is required")
        v = str(v).strip()
        if not v:
            raise ValueError("item_id cannot be empty")
        return v

    @field_validator("affordance_id", mode="before")
    @classmethod
    def validate_affordance_id(cls, v: str | None) -> str:
        """Ensure affordance_id is provided and stripped."""
        if v is None:
            raise ValueError("affordance_id is required")
        v = str(v).strip()
        if not v:
            raise ValueError("affordance_id cannot be empty")
        return v


class ListEquipmentInput(BaseModel):
    """Input for list_equipment tool.

    No parameters required - lists all equipment slots.
    """

    pass


# =============================================================================
# Tool Definitions
# =============================================================================


ITEM_TOOLS: ToolDict = {
    "list_inventory": ToolDefinition(
        name="mcp__action_manager__list_inventory",
        description="""\
List all items in the player's inventory.
Returns item names, descriptions, and quantities.
Use this to check what items the player has before making decisions.""",
        input_model=ListInventoryInput,
        response="{inventory_list}",
        enabled=True,
    ),
    "list_world_item": ToolDefinition(
        name="mcp__action_manager__list_world_item",
        description="""\
List all item templates available in this world's item dictionary.
Returns item IDs, names, descriptions, and properties.

**Use Cases:**
- Check what items exist before adding to player inventory
- Find specific items by keyword search
- Review available items for quest design or rewards""",
        input_model=ListWorldItemInput,
        response="{items_list}",
        enabled=True,
    ),
    "equip_item": ToolDefinition(
        name="mcp__action_manager__equip_item",
        description="""\
Equip an item from inventory to an equipment slot.

**Requirements:**
- Item must be in player's inventory
- Item must have an 'equippable' component with a valid slot
- The target slot must be defined in the world's equipment_slots catalog

**Behavior:**
- If an item is already equipped in that slot, it's returned to inventory
- Passive effects from equipped items are automatically applied to stats
- Slot can be auto-detected from item template if not specified""",
        input_model=EquipItemInput,
        response="{equip_result}",
        enabled=True,
    ),
    "unequip_item": ToolDefinition(
        name="mcp__action_manager__unequip_item",
        description="""\
Unequip an item from an equipment slot, returning it to inventory.

**Behavior:**
- The item's passive effects are removed
- Item is added back to inventory""",
        input_model=UnequipItemInput,
        response="{unequip_result}",
        enabled=True,
    ),
    "use_item": ToolDefinition(
        name="mcp__action_manager__use_item",
        description="""\
Use an item's affordance (action/ability).

**Process:**
1. Check if affordance is off cooldown
2. Check if item has charges remaining (if applicable)
3. Check requirements (stats, flags, items)
4. Apply costs (deduct stats, consume items)
5. Apply effects (stat changes, flag changes, grant items)
6. Update charges and cooldown
7. Remove item if 'remove_self: true'

**Use Cases:**
- Consumables: Use a potion to heal
- Abilities: Cast a spell or use a skill
- Key items: Use a key to unlock a door
- Gifts: Give an item to an NPC for affection bonus""",
        input_model=UseItemInput,
        response="{use_result}",
        enabled=True,
    ),
    "list_equipment": ToolDefinition(
        name="mcp__action_manager__list_equipment",
        description="""\
List all currently equipped items and their passive effects.

Returns all equipment slots (defined in world config) with:
- Slot name
- Equipped item name (or empty)
- Passive stat effects from equipped items""",
        input_model=ListEquipmentInput,
        response="{equipment_list}",
        enabled=True,
    ),
}
