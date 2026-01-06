"""
Domain services - pure domain logic (stateless, no I/O).
"""

from .access_control import AccessControl
from .item_validation import ItemValidator
from .localization import Localization
from .memory import MemoryEntry
from .player_rules import (
    InventoryItem as DomainInventoryItem,
)
from .player_rules import (
    apply_stat_changes,
    build_stat_map,
    clamp_stat_value,
    find_inventory_item,
    initialize_stats_from_definitions,
    merge_inventory_item,
    remove_inventory_item,
)
from .player_state_serializer import PlayerStateSerializer

__all__ = [
    "MemoryEntry",
    "AccessControl",
    "ItemValidator",
    "Localization",
    "PlayerStateSerializer",
    "DomainInventoryItem",
    "apply_stat_changes",
    "build_stat_map",
    "clamp_stat_value",
    "find_inventory_item",
    "initialize_stats_from_definitions",
    "merge_inventory_item",
    "remove_inventory_item",
]
