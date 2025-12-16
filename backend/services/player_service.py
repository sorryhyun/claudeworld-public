"""
Player state and stats service.

Handles player state persistence and stat management for worlds.
Business rules (clamping, merging) are delegated to domain/services/player_rules.py.

Includes mtime-based caching to avoid per-turn FS reads.
"""

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

import yaml
from domain.entities.world_models import PlayerState
from domain.services.player_rules import apply_stat_changes

from services.world_service import WorldService

logger = logging.getLogger("PlayerService")


@dataclass
class CachedPlayerState:
    """Cache entry with file mtime for invalidation."""

    state: PlayerState
    mtime: float


# Module-level cache
_player_state_cache: Dict[str, CachedPlayerState] = {}


class PlayerService:
    """Player state and stats management service."""

    @classmethod
    def load_player_state(cls, world_name: str) -> Optional[PlayerState]:
        """
        Load player state from filesystem with mtime-based caching.

        Cache is automatically invalidated when file is modified.
        """
        world_path = WorldService.get_world_path(world_name)
        player_file = world_path / "player.yaml"

        if not player_file.exists():
            # Remove from cache if file was deleted
            if world_name in _player_state_cache:
                del _player_state_cache[world_name]
            return None

        # Check file mtime for cache invalidation
        current_mtime = os.path.getmtime(player_file)

        # Check cache
        if world_name in _player_state_cache:
            cached = _player_state_cache[world_name]
            if cached.mtime >= current_mtime:
                logger.debug(f"PlayerState CACHE HIT for '{world_name}'")
                return cached.state
            else:
                logger.debug(f"PlayerState CACHE STALE for '{world_name}' (file modified)")

        # Cache miss or stale - read from disk
        logger.debug(f"PlayerState CACHE MISS for '{world_name}' - reading from disk")

        with open(player_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        if not data:
            state = PlayerState(current_location=None, turn_count=0)
        else:
            state = PlayerState(
                current_location=data.get("current_location"),
                turn_count=data.get("turn_count", 0),
                stats=data.get("stats", {}),
                inventory=data.get("inventory", []),
                effects=data.get("effects", []),
                recent_actions=data.get("recent_actions", []),
                game_time=data.get("game_time", {"hour": 8, "minute": 0, "day": 1}),
            )

        # Update cache
        _player_state_cache[world_name] = CachedPlayerState(state=state, mtime=current_mtime)
        return state

    @classmethod
    def save_player_state(cls, world_name: str, state: PlayerState) -> None:
        """Save player state to filesystem.

        Inventory is saved in reference format (item_id, quantity, instance_properties).
        Full item definitions are stored in items/ directory.
        """
        from services.item_service import ItemService

        world_path = WorldService.get_world_path(world_name)

        # Convert inventory to reference format (also ensures templates exist)
        inventory_refs = ItemService.to_reference_format(world_name, state.inventory)

        data = {
            "current_location": state.current_location,
            "turn_count": state.turn_count,
            "stats": state.stats,
            "inventory": inventory_refs,
            "effects": state.effects,
            "recent_actions": state.recent_actions[-10:],  # Keep last 10
            "game_time": state.game_time,
        }

        with open(world_path / "player.yaml", "w", encoding="utf-8") as f:
            yaml.dump(data, f, allow_unicode=True, default_flow_style=False)

        # Invalidate cache - will be re-read on next load_player_state() call
        if world_name in _player_state_cache:
            del _player_state_cache[world_name]
            logger.debug(f"PlayerState cache invalidated for '{world_name}' (save_player_state)")

    @classmethod
    def get_resolved_inventory(cls, world_name: str) -> list:
        """Get player inventory with full item data resolved from templates.

        Use this for display/context where full item details are needed.

        Returns:
            List of inventory items with full data (name, description, properties)
        """
        from services.item_service import ItemService

        state = cls.load_player_state(world_name)
        if not state or not state.inventory:
            return []

        return ItemService.resolve_inventory(world_name, state.inventory)

    @classmethod
    def load_stat_definitions(cls, world_name: str) -> Dict[str, Any]:
        """Load stat definitions from filesystem."""
        world_path = WorldService.get_world_path(world_name)
        stats_file = world_path / "stats.yaml"

        if not stats_file.exists():
            return {"stats": [], "derived": []}

        with open(stats_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        return data or {"stats": [], "derived": []}

    @classmethod
    def save_stat_definitions(cls, world_name: str, definitions: Dict[str, Any]) -> None:
        """Save stat definitions to filesystem."""
        world_path = WorldService.get_world_path(world_name)
        world_path.mkdir(parents=True, exist_ok=True)

        with open(world_path / "stats.yaml", "w", encoding="utf-8") as f:
            yaml.dump(definitions, f, allow_unicode=True, default_flow_style=False)

    @classmethod
    def update_stats(cls, world_name: str, changes: Dict[str, int]) -> Dict[str, int]:
        """Update player stats and return new values."""
        state = cls.load_player_state(world_name)
        if not state:
            return {}

        # Load stat definitions and apply changes with clamping (delegated to domain rules)
        stat_defs = cls.load_stat_definitions(world_name)
        state.stats = apply_stat_changes(state.stats, changes, stat_defs)

        cls.save_player_state(world_name, state)
        return state.stats
