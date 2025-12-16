"""
Player state serialization domain logic.

This module centralizes JSON serialization/deserialization for player state fields
to provide a single source of truth for conversion logic.
"""

import json
from typing import Any, Dict, List, Optional


class PlayerStateSerializer:
    """Domain logic for player state JSON serialization."""

    @staticmethod
    def parse_stats(stats_data: Optional[str | dict]) -> Dict[str, Any]:
        """
        Parse stats from JSON string or dict.

        Args:
            stats_data: JSON string, dict, or None

        Returns:
            Parsed stats dictionary (empty if None or invalid)
        """
        if stats_data is None:
            return {}
        if isinstance(stats_data, dict):
            return stats_data
        if isinstance(stats_data, str):
            try:
                return json.loads(stats_data)
            except (json.JSONDecodeError, TypeError):
                return {}
        return {}

    @staticmethod
    def serialize_stats(stats: Dict[str, Any]) -> str:
        """
        Serialize stats dictionary to JSON string.

        Args:
            stats: Stats dictionary

        Returns:
            JSON string representation
        """
        return json.dumps(stats)

    @staticmethod
    def parse_inventory(inventory_data: Optional[str | list]) -> List[Any]:
        """
        Parse inventory from JSON string or list.

        Args:
            inventory_data: JSON string, list, or None

        Returns:
            Parsed inventory list (empty if None or invalid)
        """
        if inventory_data is None:
            return []
        if isinstance(inventory_data, list):
            return inventory_data
        if isinstance(inventory_data, str):
            try:
                return json.loads(inventory_data)
            except (json.JSONDecodeError, TypeError):
                return []
        return []

    @staticmethod
    def serialize_inventory(inventory: List[Any]) -> str:
        """
        Serialize inventory list to JSON string.

        Args:
            inventory: Inventory list

        Returns:
            JSON string representation
        """
        return json.dumps(inventory)

    @staticmethod
    def parse_effects(effects_data: Optional[str | list]) -> List[Any]:
        """
        Parse effects from JSON string or list.

        Args:
            effects_data: JSON string, list, or None

        Returns:
            Parsed effects list (empty if None or invalid)
        """
        if effects_data is None:
            return []
        if isinstance(effects_data, list):
            return effects_data
        if isinstance(effects_data, str):
            try:
                return json.loads(effects_data)
            except (json.JSONDecodeError, TypeError):
                return []
        return []

    @staticmethod
    def serialize_effects(effects: List[Any]) -> str:
        """
        Serialize effects list to JSON string.

        Args:
            effects: Effects list

        Returns:
            JSON string representation
        """
        return json.dumps(effects)

    @staticmethod
    def parse_action_history(history_data: Optional[str | list]) -> List[Any]:
        """
        Parse action history from JSON string or list.

        Args:
            history_data: JSON string, list, or None

        Returns:
            Parsed action history list (empty if None or invalid)
        """
        if history_data is None:
            return []
        if isinstance(history_data, list):
            return history_data
        if isinstance(history_data, str):
            try:
                return json.loads(history_data)
            except (json.JSONDecodeError, TypeError):
                return []
        return []

    @staticmethod
    def serialize_action_history(history: List[Any]) -> str:
        """
        Serialize action history list to JSON string.

        Args:
            history: Action history list

        Returns:
            JSON string representation
        """
        return json.dumps(history)
