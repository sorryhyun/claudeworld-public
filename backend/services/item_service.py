"""
Item template service.

Handles item template persistence for worlds.
Items are stored in the items/ directory as the source of truth.
Player inventory (player.yaml) only stores references to items.
"""

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import yaml

from services.world_service import WorldService

logger = logging.getLogger("ItemService")


@dataclass
class CachedItemTemplates:
    """Cache entry with directory mtime for invalidation."""

    templates: Dict[str, Dict[str, Any]]
    mtime: float


# Module-level cache
_item_templates_cache: Dict[str, CachedItemTemplates] = {}


class ItemService:
    """Item template management service.

    Items/ directory is the source of truth for all item definitions.
    player.yaml inventory only stores references (item_id, quantity, instance_properties).
    """

    @classmethod
    def _get_items_dir_mtime(cls, world_name: str) -> float:
        """Get the latest mtime of the items directory and its contents."""
        world_path = WorldService.get_world_path(world_name)
        items_dir = world_path / "items"

        if not items_dir.exists():
            return 0.0

        # Get max mtime of directory and all yaml files
        max_mtime = os.path.getmtime(items_dir)
        for item_file in items_dir.glob("*.yaml"):
            file_mtime = os.path.getmtime(item_file)
            max_mtime = max(max_mtime, file_mtime)

        return max_mtime

    @classmethod
    def save_item_template(
        cls,
        world_name: str,
        item_id: str,
        name: str,
        description: Optional[str] = None,
        properties: Optional[Dict[str, Any]] = None,
        overwrite: bool = False,
    ) -> bool:
        """
        Save an item template to items/{item_id}.yaml.

        Args:
            world_name: Name of the world
            item_id: Unique item identifier (used as filename)
            name: Display name of the item
            description: Item description
            properties: Item properties (stored as default_properties)
            overwrite: If True, overwrite existing template

        Returns:
            True if saved, False if already exists and overwrite=False
        """
        world_path = WorldService.get_world_path(world_name)
        items_dir = world_path / "items"

        # Ensure items directory exists
        items_dir.mkdir(exist_ok=True)

        # Sanitize item_id for filename
        safe_id = "".join(c for c in item_id if c.isalnum() or c in "._-")
        item_file = items_dir / f"{safe_id}.yaml"

        # Don't overwrite existing templates unless explicitly requested
        if item_file.exists() and not overwrite:
            logger.debug(f"Item template '{item_id}' already exists, skipping")
            return False

        template = {
            "id": item_id,
            "name": name,
            "description": description or "",
            "default_properties": properties or {},
        }

        with open(item_file, "w", encoding="utf-8") as f:
            yaml.dump(template, f, allow_unicode=True, default_flow_style=False)

        # Invalidate cache
        if world_name in _item_templates_cache:
            del _item_templates_cache[world_name]

        logger.info(f"Saved item template '{item_id}' in world '{world_name}'")
        return True

    @classmethod
    def load_item_template(cls, world_name: str, item_id: str) -> Optional[Dict[str, Any]]:
        """
        Load an item template from items/{item_id}.yaml.

        Uses cached templates for efficiency.

        Args:
            world_name: Name of the world
            item_id: Item identifier

        Returns:
            Item template dict if found, None otherwise
        """
        templates = cls.load_all_item_templates(world_name)
        return templates.get(item_id)

    @classmethod
    def load_all_item_templates(cls, world_name: str) -> Dict[str, Dict[str, Any]]:
        """
        Load all item templates for a world with mtime-based caching.

        Returns:
            Dict of item_id -> template data
        """
        current_mtime = cls._get_items_dir_mtime(world_name)

        # Check cache
        if world_name in _item_templates_cache:
            cached = _item_templates_cache[world_name]
            if cached.mtime >= current_mtime:
                logger.debug(f"ItemTemplates CACHE HIT for '{world_name}'")
                return cached.templates

        # Cache miss or stale - read from disk
        logger.debug(f"ItemTemplates CACHE MISS for '{world_name}' - reading from disk")

        world_path = WorldService.get_world_path(world_name)
        items_dir = world_path / "items"

        if not items_dir.exists():
            _item_templates_cache[world_name] = CachedItemTemplates(templates={}, mtime=current_mtime)
            return {}

        templates = {}
        for item_file in items_dir.glob("*.yaml"):
            try:
                with open(item_file, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f)
                    if data and "id" in data:
                        templates[data["id"]] = data
            except Exception as e:
                logger.warning(f"Failed to load item template {item_file}: {e}")

        # Update cache
        _item_templates_cache[world_name] = CachedItemTemplates(templates=templates, mtime=current_mtime)
        return templates

    @classmethod
    def resolve_inventory(
        cls,
        world_name: str,
        inventory_refs: List[Dict[str, Any]],
        normalize_props: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Resolve inventory references to full item data.

        Merges item templates from items/ with instance data from player.yaml.
        Supports both reference format (item_id + instance_properties) and
        legacy embedded format (full item data).

        Args:
            world_name: Name of the world
            inventory_refs: List of inventory entries from player.yaml
            normalize_props: If True, normalize properties to include higher_is_better metadata

        Returns:
            List of resolved inventory items with full data
        """
        from domain.services.player_rules import InventoryItem, normalize_properties

        templates = cls.load_all_item_templates(world_name)
        resolved = []

        for ref in inventory_refs:
            item_id = ref.get("item_id") or ref.get("id", "")
            template = templates.get(item_id)

            # Use from_reference to handle both formats
            item = InventoryItem.from_reference(ref, template)
            item_dict = item.to_dict()

            # Normalize properties to include higher_is_better metadata
            if normalize_props and item_dict.get("properties"):
                item_dict["properties"] = normalize_properties(item_dict["properties"])

            resolved.append(item_dict)

        return resolved

    @classmethod
    def to_reference_format(
        cls,
        world_name: str,
        inventory_items: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Convert inventory items to reference format for saving.

        Also ensures templates exist in items/ directory.

        Args:
            world_name: Name of the world
            inventory_items: List of full inventory item dicts

        Returns:
            List of reference-format dicts (item_id, quantity, instance_properties)
        """
        from domain.services.player_rules import InventoryItem

        references = []
        templates = cls.load_all_item_templates(world_name)

        for item_data in inventory_items:
            item = InventoryItem.from_dict(item_data)

            # Ensure template exists
            if item.id not in templates:
                cls.save_item_template(
                    world_name,
                    item_id=item.id,
                    name=item.name,
                    description=item.description,
                    properties=item.properties,
                )

            references.append(item.to_reference_dict())

        return references

    @classmethod
    def get_all_items_in_world(cls, world_name: str) -> List[Dict[str, Any]]:
        """
        Get all item definitions in a world (from items/ directory).

        Returns:
            List of item template dicts
        """
        templates = cls.load_all_item_templates(world_name)
        return list(templates.values())

    @classmethod
    def delete_item_template(cls, world_name: str, item_id: str) -> bool:
        """
        Delete an item template from items/ directory.

        Args:
            world_name: Name of the world
            item_id: Item identifier to delete

        Returns:
            True if deleted, False if not found
        """
        world_path = WorldService.get_world_path(world_name)
        safe_id = "".join(c for c in item_id if c.isalnum() or c in "._-")
        item_file = world_path / "items" / f"{safe_id}.yaml"

        if not item_file.exists():
            return False

        item_file.unlink()

        # Invalidate cache
        if world_name in _item_templates_cache:
            del _item_templates_cache[world_name]

        logger.info(f"Deleted item template '{item_id}' from world '{world_name}'")
        return True
