"""
Domain rules for player state mutations.

Pure functions for stat clamping, inventory management, and other player state business logic.
These rules are used by both CRUD (DB) and PlayerService (FS) to ensure consistent behavior.
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class InventoryItem:
    """Domain representation of an inventory item.

    Supports both reference-based format (item_id + instance_properties)
    and legacy embedded format (full item data in player.yaml).
    """

    id: str
    name: str
    description: Optional[str] = None
    quantity: int = 1
    properties: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization (legacy embedded format)."""
        return {
            "item_id": self.id,
            "name": self.name,
            "description": self.description,
            "quantity": self.quantity,
            "properties": self.properties or {},
        }

    def to_reference_dict(self) -> Dict[str, Any]:
        """Convert to reference format for player.yaml (new format).

        Only stores item_id, quantity, and instance_properties.
        """
        result: Dict[str, Any] = {
            "item_id": self.id,
            "quantity": self.quantity,
        }
        if self.properties:
            result["instance_properties"] = self.properties
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "InventoryItem":
        """Create from dictionary (handles both 'id' and 'item_id' formats)."""
        return cls(
            id=data.get("id") or data.get("item_id", ""),
            name=data.get("name", ""),
            description=data.get("description"),
            quantity=data.get("quantity", 1),
            properties=data.get("properties") or data.get("instance_properties"),
        )

    @classmethod
    def from_reference(
        cls,
        ref_data: Dict[str, Any],
        template: Optional[Dict[str, Any]] = None,
    ) -> "InventoryItem":
        """Create from reference format, merging with item template.

        Args:
            ref_data: Reference data from player.yaml (item_id, quantity, instance_properties)
            template: Item template from items/{item_id}.yaml (id, name, description, default_properties)

        Returns:
            InventoryItem with merged data
        """
        item_id = ref_data.get("item_id") or ref_data.get("id", "")
        quantity = ref_data.get("quantity", 1)
        instance_props = ref_data.get("instance_properties") or ref_data.get("properties") or {}

        if template:
            # Merge template defaults with instance overrides
            default_props = template.get("default_properties") or template.get("properties") or {}
            merged_props = {**default_props, **instance_props}

            return cls(
                id=item_id,
                name=template.get("name", item_id),
                description=template.get("description"),
                quantity=quantity,
                properties=merged_props if merged_props else None,
            )
        else:
            # Legacy format: full data embedded in player.yaml
            return cls(
                id=item_id,
                name=ref_data.get("name", item_id),
                description=ref_data.get("description"),
                quantity=quantity,
                properties=instance_props if instance_props else None,
            )


def build_stat_map(stat_definitions: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    Build a lookup map from stat definitions.

    Args:
        stat_definitions: Dict with 'stats' key containing list of stat configs

    Returns:
        Dict mapping stat_name -> stat_config (with min, max, default, etc.)
    """
    if not stat_definitions:
        return {}
    return {stat["name"]: stat for stat in stat_definitions.get("stats", [])}


def clamp_stat_value(
    value: int,
    stat_name: str,
    stat_map: Dict[str, Dict[str, Any]],
) -> int:
    """
    Clamp a stat value to its min/max bounds.

    Args:
        value: The raw stat value
        stat_name: Name of the stat
        stat_map: Stat definitions lookup (from build_stat_map)

    Returns:
        Clamped value within bounds, or original if no bounds defined
    """
    if stat_name not in stat_map:
        return value

    stat_def = stat_map[stat_name]
    if stat_def.get("min") is not None:
        value = max(stat_def["min"], value)
    if stat_def.get("max") is not None:
        value = min(stat_def["max"], value)

    return value


def apply_stat_changes(
    current_stats: Dict[str, int],
    changes: Dict[str, int],
    stat_definitions: Optional[Dict[str, Any]] = None,
) -> Dict[str, int]:
    """
    Apply stat changes with clamping.

    Args:
        current_stats: Current stat values
        changes: Dict of stat_name -> delta (can be positive or negative)
        stat_definitions: Optional stat definitions for clamping

    Returns:
        New stats dict with changes applied and clamped
    """
    stat_map = build_stat_map(stat_definitions)
    new_stats = current_stats.copy()

    for stat_name, change in changes.items():
        old_value = new_stats.get(stat_name, 0)
        new_value = old_value + change
        new_stats[stat_name] = clamp_stat_value(new_value, stat_name, stat_map)

    return new_stats


def find_inventory_item(
    inventory: List[Dict[str, Any]],
    item_id: str,
) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
    """
    Find an item in inventory by ID (handles both 'id' and 'item_id' formats).

    Args:
        inventory: List of inventory item dicts
        item_id: ID to search for

    Returns:
        Tuple of (item_dict, index) if found, (None, None) if not found
    """
    for idx, item in enumerate(inventory):
        if item.get("id") == item_id or item.get("item_id") == item_id:
            return item, idx
    return None, None


def merge_inventory_item(
    inventory: List[Dict[str, Any]],
    item: InventoryItem,
) -> List[Dict[str, Any]]:
    """
    Add or merge an item into inventory.

    If item with same ID exists, increments quantity.
    Otherwise, appends new item.

    Args:
        inventory: Current inventory list (will be copied, not mutated)
        item: Item to add/merge

    Returns:
        New inventory list with item added/merged
    """
    new_inventory = [i.copy() for i in inventory]

    existing, _ = find_inventory_item(new_inventory, item.id)
    if existing is not None:
        existing["quantity"] = existing.get("quantity", 0) + item.quantity
    else:
        new_inventory.append(item.to_dict())

    return new_inventory


def remove_inventory_item(
    inventory: List[Dict[str, Any]],
    item_id: str,
    quantity: int = 1,
) -> Tuple[List[Dict[str, Any]], bool, int]:
    """
    Remove quantity of an item from inventory.

    Args:
        inventory: Current inventory list (will be copied, not mutated)
        item_id: ID of item to remove
        quantity: Amount to remove (default 1)

    Returns:
        Tuple of (new_inventory, success, remaining_quantity)
        - success is False if item not found or insufficient quantity
        - remaining_quantity is what's left after removal (0 if item removed entirely)
    """
    new_inventory = [i.copy() for i in inventory]

    existing, idx = find_inventory_item(new_inventory, item_id)
    if existing is None:
        return inventory, False, 0

    current_quantity = existing.get("quantity", 0)
    if current_quantity < quantity:
        return inventory, False, current_quantity

    remaining = current_quantity - quantity
    if remaining <= 0:
        new_inventory.pop(idx)
        return new_inventory, True, 0
    else:
        existing["quantity"] = remaining
        return new_inventory, True, remaining


def initialize_stats_from_definitions(
    stat_definitions: Dict[str, Any],
    initial_overrides: Optional[Dict[str, int]] = None,
) -> Dict[str, int]:
    """
    Build initial stats dict from definitions.

    Args:
        stat_definitions: Dict with 'stats' key containing list of stat configs
        initial_overrides: Optional dict of stat values to override defaults

    Returns:
        Dict of stat_name -> initial_value
    """
    stats = {}
    for stat in stat_definitions.get("stats", []):
        stats[stat["name"]] = stat.get("default", 0)

    if initial_overrides:
        stats.update(initial_overrides)

    return stats


# =============================================================================
# Property Normalization (higher_is_better metadata)
# =============================================================================

# Known property names where lower values are better
LOWER_IS_BETTER_PROPERTIES = frozenset(
    {
        "weight",
        "cursed_level",
        "corruption",
        "decay",
        "fragility",
        "cooldown",
        "cost",
        "mana_cost",
        "stamina_cost",
    }
)


def normalize_property_value(prop: Any, prop_name: str = "") -> Dict[str, Any]:
    """
    Normalize a property value to include higher_is_better metadata.

    Args:
        prop: Property value - either a simple value or dict with 'value' key
        prop_name: Property name (used to infer higher_is_better for simple values)

    Returns:
        Dict with 'value' and 'higher_is_better' keys

    Examples:
        >>> normalize_property_value(10, "damage")
        {"value": 10, "higher_is_better": True}

        >>> normalize_property_value(3, "weight")
        {"value": 3, "higher_is_better": False}

        >>> normalize_property_value({"value": 80, "higher_is_better": True})
        {"value": 80, "higher_is_better": True}
    """
    # Already normalized dict format
    if isinstance(prop, dict) and "value" in prop:
        return {
            "value": prop["value"],
            "higher_is_better": prop.get("higher_is_better", True),
        }

    # Simple value - infer higher_is_better from property name
    higher_is_better = prop_name.lower() not in LOWER_IS_BETTER_PROPERTIES
    return {
        "value": prop,
        "higher_is_better": higher_is_better,
    }


def normalize_properties(properties: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Normalize all properties in a dict to include higher_is_better metadata.

    Args:
        properties: Dict of property_name -> value (simple or structured)

    Returns:
        Dict with all properties normalized to {value, higher_is_better} format
    """
    if not properties:
        return {}

    return {name: normalize_property_value(value, name) for name, value in properties.items()}
