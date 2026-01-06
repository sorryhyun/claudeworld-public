"""
World reset service for restoring worlds to initial state.

This module handles saving and loading the initial state snapshot
used for the "reset world" functionality.
"""

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from services.world_service import WorldService

logger = logging.getLogger("WorldResetService")

# Filename for initial state snapshot
INITIAL_STATE_FILE = "_initial.json"


class WorldResetService:
    """Handles world reset operations."""

    @staticmethod
    def get_initial_state_path(world_name: str) -> Path:
        """Get the path to a world's initial state file."""
        return WorldService.get_world_path(world_name) / INITIAL_STATE_FILE

    @staticmethod
    def load_initial_state(world_name: str) -> Optional[dict[str, Any]]:
        """
        Load initial state from _initial.json.

        Args:
            world_name: Name of the world

        Returns:
            Initial state dict or None if not found
        """
        initial_file = WorldResetService.get_initial_state_path(world_name)

        if not initial_file.exists():
            logger.warning(f"No {INITIAL_STATE_FILE} found for world '{world_name}'")
            return None

        try:
            with open(initial_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.error(f"Failed to load {INITIAL_STATE_FILE}: {e}")
            return None

    @staticmethod
    def save_initial_state(world_name: str, initial_state: dict[str, Any]) -> bool:
        """
        Save initial state to _initial.json.

        Args:
            world_name: Name of the world
            initial_state: State to save (starting_location, initial_stats, initial_inventory)

        Returns:
            True if successful, False otherwise
        """
        initial_file = WorldResetService.get_initial_state_path(world_name)

        try:
            with open(initial_file, "w", encoding="utf-8") as f:
                json.dump(initial_state, f, ensure_ascii=False, indent=2)
            logger.info(f"Saved initial state for world '{world_name}'")
            return True
        except IOError as e:
            logger.error(f"Failed to save {INITIAL_STATE_FILE}: {e}")
            return False

    @staticmethod
    def has_initial_state(world_name: str) -> bool:
        """
        Check if a world has saved initial state.

        Args:
            world_name: Name of the world

        Returns:
            True if _initial.json exists
        """
        return WorldResetService.get_initial_state_path(world_name).exists()

    @staticmethod
    def create_initial_state_snapshot(
        starting_location: str,
        initial_stats: dict[str, Any],
        initial_inventory: list[dict[str, Any]],
        initial_game_time: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        """
        Create an initial state snapshot dict.

        Args:
            starting_location: Name of the starting location
            initial_stats: Initial stat values
            initial_inventory: Initial inventory items
            initial_game_time: Initial game time (hour, minute, day)

        Returns:
            Initial state dict ready to be saved
        """
        snapshot = {
            "starting_location": starting_location,
            "initial_stats": initial_stats,
            "initial_inventory": initial_inventory,
            "captured_at": datetime.utcnow().isoformat() + "Z",
        }
        if initial_game_time:
            snapshot["initial_game_time"] = initial_game_time
        return snapshot
