"""
World catalog service for loading slot, time domain, and recharge event definitions.

These catalogs are optional and world-defined, enabling world-agnostic mechanics.
"""

import logging
from typing import Any, Dict

import yaml

from services.world_service import WorldService

logger = logging.getLogger("CatalogService")


class CatalogService:
    """Loads world-defined catalogs for equipment slots, time domains, etc."""

    @classmethod
    def _load_world_config(cls, world_name: str) -> Dict[str, Any]:
        """Load world.yaml configuration."""
        world_path = WorldService.get_world_path(world_name)
        config_file = world_path / "world.yaml"

        if not config_file.exists():
            return {}

        with open(config_file, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    @classmethod
    def load_equipment_slots(cls, world_name: str) -> Dict[str, Dict[str, Any]]:
        """
        Load equipment slot definitions from world config.

        Returns:
            Dict of slot_name -> {display_name, accepts_as}
            Empty dict if no slots defined (equipment system disabled)
        """
        config = cls._load_world_config(world_name)
        return config.get("equipment_slots", {})

    @classmethod
    def load_time_domains(cls, world_name: str) -> Dict[str, Dict[str, Any]]:
        """
        Load time domain definitions from world config.

        Returns:
            Dict of domain_name -> {display_name}
            Empty dict if no domains defined
        """
        config = cls._load_world_config(world_name)
        return config.get("time_domains", {})

    @classmethod
    def load_recharge_events(cls, world_name: str) -> Dict[str, Dict[str, Any]]:
        """
        Load recharge event definitions from world config.

        Returns:
            Dict of event_name -> {display_name}
            Empty dict if no events defined
        """
        config = cls._load_world_config(world_name)
        return config.get("recharge_events", {})

    @classmethod
    def get_all_catalogs(cls, world_name: str) -> Dict[str, Any]:
        """
        Load all catalogs for a world.

        Returns:
            Dict with keys: equipment_slots, time_domains, recharge_events
        """
        return {
            "equipment_slots": cls.load_equipment_slots(world_name),
            "time_domains": cls.load_time_domains(world_name),
            "recharge_events": cls.load_recharge_events(world_name),
        }
