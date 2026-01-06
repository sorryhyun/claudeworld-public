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


# =============================================================================
# EQUIPMENT FUNCTIONS (Phase 2)
# =============================================================================


def equip_item(
    inventory: List[Dict[str, Any]],
    equipment: Dict[str, Optional[str]],
    item_id: str,
    slot: str,
    item_template: Dict[str, Any],
    slot_catalog: Dict[str, Any],
) -> Tuple[Dict[str, Optional[str]], Optional[str], str]:
    """
    Equip an item from inventory to a slot.

    Args:
        inventory: Current inventory list
        equipment: Current equipment dict
        item_id: Item to equip
        slot: Target slot
        item_template: Template for the item
        slot_catalog: World's slot definitions

    Returns:
        Tuple of (new_equipment, unequipped_item_id, message)
    """
    # Validate slot exists
    if slot_catalog and slot not in slot_catalog:
        return equipment, None, f"Invalid slot: {slot}"

    # Validate item is in inventory
    item_in_inventory = any(inv.get("item_id") == item_id or inv.get("id") == item_id for inv in inventory)
    if not item_in_inventory:
        return equipment, None, f"Item not in inventory: {item_id}"

    # Validate item is equippable to this slot
    equippable = item_template.get("equippable", {})
    if not equippable:
        return equipment, None, f"Item is not equippable: {item_id}"

    item_slot = equippable.get("slot")
    if item_slot != slot:
        return equipment, None, f"Item cannot be equipped to {slot} (requires {item_slot})"

    # Check accepts_as compatibility
    if slot_catalog:
        slot_def = slot_catalog.get(slot, {})
        slot_accepts = slot_def.get("accepts_as", [])
        item_accepts_as = equippable.get("accepts_as", [])

        if slot_accepts and item_accepts_as:
            if not any(t in slot_accepts for t in item_accepts_as):
                return equipment, None, f"Slot {slot} does not accept this item type"

    # Unequip current item in slot (if any)
    new_equipment = equipment.copy()
    unequipped_id = new_equipment.get(slot)

    # Equip new item
    new_equipment[slot] = item_id

    item_name = item_template.get("name", item_id)
    if unequipped_id:
        return new_equipment, unequipped_id, f"Equipped {item_name} to {slot} (unequipped previous)"
    else:
        return new_equipment, None, f"Equipped {item_name} to {slot}"


def unequip_slot(
    equipment: Dict[str, Optional[str]],
    slot: str,
) -> Tuple[Dict[str, Optional[str]], Optional[str], str]:
    """
    Unequip an item from a slot.

    Returns:
        Tuple of (new_equipment, unequipped_item_id, message)
    """
    new_equipment = equipment.copy()
    unequipped_id = new_equipment.get(slot)

    if not unequipped_id:
        return equipment, None, f"Nothing equipped in {slot}"

    new_equipment[slot] = None
    return new_equipment, unequipped_id, f"Unequipped item from {slot}"


def get_equipped_passive_effects(
    equipment: Dict[str, Optional[str]],
    item_templates: Dict[str, Dict[str, Any]],
) -> Dict[str, float]:
    """
    Calculate total passive effects from all equipped items.

    Returns:
        Dict of stat_name -> total_modifier
    """
    total_effects: Dict[str, float] = {}

    for slot, item_id in equipment.items():
        if not item_id:
            continue

        template = item_templates.get(item_id, {})
        equippable = template.get("equippable", {})
        passive_effects = equippable.get("passive_effects", {})

        for stat, modifier in passive_effects.items():
            total_effects[stat] = total_effects.get(stat, 0) + modifier

    return total_effects


# =============================================================================
# AFFORDANCE FUNCTIONS (Phase 2)
# =============================================================================


def check_affordance_requirements(
    affordance: Dict[str, Any],
    current_stats: Dict[str, int],
    flags: Dict[str, bool],
    inventory: List[Dict[str, Any]],
) -> Tuple[bool, str]:
    """
    Check if affordance requirements are met.

    Returns:
        Tuple of (can_use, reason)
    """
    requirements = affordance.get("requirements", {})

    if not requirements:
        return True, "No requirements"

    # Check stat requirements
    stat_reqs = requirements.get("stats", {})
    for stat_name, bounds in stat_reqs.items():
        current_value = current_stats.get(stat_name, 0)

        min_val = bounds.get("min")
        max_val = bounds.get("max")

        if min_val is not None and current_value < min_val:
            return False, f"Requires {stat_name} >= {min_val} (current: {current_value})"
        if max_val is not None and current_value > max_val:
            return False, f"Requires {stat_name} <= {max_val} (current: {current_value})"

    # Check flags_all (all must be true)
    flags_all = requirements.get("flags_all", [])
    for flag in flags_all:
        if not flags.get(flag, False):
            return False, f"Requires flag: {flag}"

    # Check flags_any (at least one must be true)
    flags_any = requirements.get("flags_any", [])
    if flags_any:
        if not any(flags.get(flag, False) for flag in flags_any):
            return False, f"Requires one of: {', '.join(flags_any)}"

    # Check flags_none (none can be true)
    flags_none = requirements.get("flags_none", [])
    for flag in flags_none:
        if flags.get(flag, False):
            return False, f"Cannot have flag: {flag}"

    # Check required items
    required_items = requirements.get("items", [])
    inventory_ids = {inv.get("item_id") or inv.get("id") for inv in inventory}
    for item_id in required_items:
        if item_id not in inventory_ids:
            return False, f"Requires item: {item_id}"

    return True, "Requirements met"


def apply_affordance_costs(
    affordance: Dict[str, Any],
    current_stats: Dict[str, int],
    stat_definitions: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, int], bool, str]:
    """
    Apply affordance costs (deduct stats).

    Returns:
        Tuple of (new_stats, success, message)
    """
    cost = affordance.get("cost", {})
    stat_changes = cost.get("stat_changes", [])

    if not stat_changes:
        return current_stats, True, "No costs"

    stat_map = build_stat_map(stat_definitions)
    new_stats = current_stats.copy()

    for change in stat_changes:
        stat_name = change.get("stat")
        delta = change.get("delta", 0)

        current_value = new_stats.get(stat_name, 0)
        new_value = current_value + delta

        # Check stat bounds
        stat_def = stat_map.get(stat_name, {})
        min_val = stat_def.get("min")
        max_val = stat_def.get("max")

        if min_val is not None and new_value < min_val:
            return (
                current_stats,
                False,
                f"Not enough {stat_name} (need {abs(delta)}, have {current_value})",
            )

        if max_val is not None:
            new_value = min(new_value, max_val)

        new_stats[stat_name] = new_value

    return new_stats, True, "Costs applied"


def apply_affordance_effects(
    affordance: Dict[str, Any],
    current_stats: Dict[str, int],
    flags: Dict[str, bool],
    stat_definitions: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, int], Dict[str, bool], str]:
    """
    Apply affordance effects (stat changes, flag changes).

    Returns:
        Tuple of (new_stats, new_flags, message)
    """
    effects = affordance.get("effects", {})

    stat_map = build_stat_map(stat_definitions)
    new_stats = current_stats.copy()
    new_flags = flags.copy()
    effect_messages = []

    # Apply stat changes
    stat_changes = effects.get("stat_changes", [])
    for change in stat_changes:
        stat_name = change.get("stat")
        delta = change.get("delta", 0)

        current_value = new_stats.get(stat_name, 0)
        new_value = current_value + delta

        # Clamp to stat bounds
        stat_def = stat_map.get(stat_name, {})
        min_val = stat_def.get("min")
        max_val = stat_def.get("max")

        if min_val is not None:
            new_value = max(new_value, min_val)
        if max_val is not None:
            new_value = min(new_value, max_val)

        new_stats[stat_name] = new_value

        sign = "+" if delta > 0 else ""
        effect_messages.append(f"{stat_name} {sign}{delta}")

    # Apply flag changes
    flag_changes = effects.get("set_flags", [])
    for flag_change in flag_changes:
        flag_name = flag_change.get("flag")
        flag_value = flag_change.get("value", True)
        new_flags[flag_name] = flag_value
        effect_messages.append(f"{flag_name} = {flag_value}")

    message = ", ".join(effect_messages) if effect_messages else "No effects"
    return new_stats, new_flags, message


def update_charges_and_cooldown(
    instance_properties: Dict[str, Any],
    affordance: Dict[str, Any],
    current_time: Dict[str, int],
    time_domain_value: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Update charges and cooldown in instance properties after using an affordance.

    Returns:
        Updated instance properties dict
    """
    new_props = instance_properties.copy()
    affordance_id = affordance.get("id", "default")

    # Handle charges
    charges_config = affordance.get("charges", {})
    if charges_config.get("max") is not None:
        charges_key = f"charges_{affordance_id}"
        current_charges = new_props.get(charges_key, charges_config.get("max", 0))
        consume = charges_config.get("consume", 1)
        new_props[charges_key] = max(0, current_charges - consume)

    # Handle cooldown
    cooldown_config = affordance.get("cooldown", {})
    if cooldown_config.get("domain") and cooldown_config.get("value"):
        cooldown_key = f"cooldown_{affordance_id}"
        domain = cooldown_config.get("domain")
        value = cooldown_config.get("value")

        # Store when the cooldown expires
        if time_domain_value is not None:
            new_props[cooldown_key] = {
                "domain": domain,
                "expires_at": time_domain_value + value,
            }

    return new_props


def check_cooldown_ready(
    instance_properties: Dict[str, Any],
    affordance: Dict[str, Any],
    current_domain_value: int,
) -> Tuple[bool, str]:
    """
    Check if an affordance is off cooldown.

    Returns:
        Tuple of (is_ready, message)
    """
    affordance_id = affordance.get("id", "default")
    cooldown_key = f"cooldown_{affordance_id}"
    cooldown_data = instance_properties.get(cooldown_key)

    if not cooldown_data:
        return True, "Ready"

    expires_at = cooldown_data.get("expires_at", 0)
    domain = cooldown_data.get("domain", "turn")

    if current_domain_value >= expires_at:
        return True, "Ready"

    remaining = expires_at - current_domain_value
    return False, f"On cooldown ({remaining} {domain}s remaining)"


def check_charges_available(
    instance_properties: Dict[str, Any],
    affordance: Dict[str, Any],
) -> Tuple[bool, int, str]:
    """
    Check if an affordance has charges available.

    Returns:
        Tuple of (has_charges, current_charges, message)
    """
    charges_config = affordance.get("charges", {})
    max_charges = charges_config.get("max")

    if max_charges is None:
        return True, -1, "Unlimited uses"

    affordance_id = affordance.get("id", "default")
    charges_key = f"charges_{affordance_id}"
    current_charges = instance_properties.get(charges_key, max_charges)
    consume = charges_config.get("consume", 1)

    if current_charges >= consume:
        return True, current_charges, f"{current_charges} charges remaining"
    else:
        return False, current_charges, f"No charges remaining ({current_charges}/{max_charges})"


def update_inventory_item_props(
    inventory: List[Dict[str, Any]],
    item_id: str,
    new_props: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Update instance_properties for a specific inventory item.

    Returns:
        New inventory list with updated item properties
    """
    new_inventory = [i.copy() for i in inventory]

    for item in new_inventory:
        if item.get("item_id") == item_id or item.get("id") == item_id:
            item["instance_properties"] = new_props
            break

    return new_inventory
