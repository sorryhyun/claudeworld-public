"""
Location storage operations.

Handles location creation, loading, updating, and deletion on the filesystem.
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from domain.entities.world_models import LocationConfig

from .world_service import WorldService

logger = logging.getLogger("LocationStorage")


def _load_index(world_name: str) -> tuple[Path, dict]:
    """Load _index.yaml for a world. Returns (index_file_path, parsed_data)."""
    world_path = WorldService.get_world_path(world_name)
    index_file = world_path / "locations" / "_index.yaml"
    if not index_file.exists():
        return index_file, {}
    with open(index_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {"locations": {}}
    return index_file, data


def _save_index(index_file: Path, data: dict) -> None:
    """Write _index.yaml."""
    with open(index_file, "w", encoding="utf-8") as f:
        yaml.dump(data, f, allow_unicode=True, default_flow_style=False)


def _build_location_config(
    loc_name: str, loc_data: Dict[str, Any], loc_dir: Path
) -> LocationConfig:
    """Build a LocationConfig from index data and filesystem."""
    description = ""
    desc_file = loc_dir / "description.md"
    if desc_file.exists():
        with open(desc_file, "r", encoding="utf-8") as f:
            description = f.read()

    position = loc_data.get("position", [0, 0])
    return LocationConfig(
        name=loc_name,
        display_name=loc_data.get("name", loc_name),
        label=loc_data.get("label"),
        position=tuple(position) if isinstance(position, list) else position,
        is_discovered=loc_data.get("is_discovered", True),
        adjacent=loc_data.get("adjacent", []),
        description=description,
        is_draft=loc_data.get("is_draft", False),
    )


class LocationStorage:
    """Location filesystem storage operations."""

    @classmethod
    def create_location(
        cls,
        world_name: str,
        location_name: str,
        display_name: str,
        description: str,
        position: tuple,
        adjacent: Optional[List[str]] = None,
        is_draft: bool = False,
    ) -> None:
        """Create a new location in the world."""
        world_path = WorldService.get_world_path(world_name)
        location_path = world_path / "locations" / location_name

        location_path.mkdir(exist_ok=True)

        with open(location_path / "description.md", "w", encoding="utf-8") as f:
            f.write(f"# {display_name}\n\n{description}\n")

        with open(location_path / "events.md", "w", encoding="utf-8") as f:
            f.write(f"# Events at {display_name}\n\n")

        index_file, index = _load_index(world_name)
        if "locations" not in index:
            index["locations"] = {}

        index["locations"][location_name] = {
            "name": display_name,
            "label": None,
            "position": list(position),
            "is_discovered": True,
            "adjacent": adjacent or [],
            "is_draft": is_draft,
        }

        _save_index(index_file, index)
        logger.info(f"Created location '{location_name}' in world '{world_name}' (is_draft={is_draft})")

    @classmethod
    def load_location(cls, world_name: str, location_name: str) -> Optional[LocationConfig]:
        """Load a location configuration from filesystem.

        Returns None if location directory doesn't exist (stale entry).
        """
        world_path = WorldService.get_world_path(world_name)
        loc_dir = world_path / "locations" / location_name
        if not loc_dir.is_dir():
            logger.debug(f"Location '{location_name}' directory does not exist - stale entry")
            return None

        _, index = _load_index(world_name)
        if not index:
            return None

        loc_data = index.get("locations", {}).get(location_name)
        if not loc_data:
            return None

        return _build_location_config(location_name, loc_data, loc_dir)

    @classmethod
    def load_all_locations(cls, world_name: str) -> Dict[str, LocationConfig]:
        """Load all locations from filesystem.

        Only returns locations that have a corresponding directory on disk.
        """
        world_path = WorldService.get_world_path(world_name)
        _, index = _load_index(world_name)
        if not index:
            return {}

        locations = {}
        for loc_name, loc_data in index.get("locations", {}).items():
            loc_dir = world_path / "locations" / loc_name
            if not loc_dir.is_dir():
                logger.debug(f"Skipping stale location '{loc_name}' - directory does not exist")
                continue
            locations[loc_name] = _build_location_config(loc_name, loc_data, loc_dir)

        return locations

    @classmethod
    def update_location(
        cls,
        world_name: str,
        location_name: str,
        is_discovered: Optional[bool] = None,
        label: Optional[str] = None,
    ) -> bool:
        """Update location properties in the index."""
        index_file, index = _load_index(world_name)
        if not index:
            return False

        if location_name not in index.get("locations", {}):
            logger.warning(f"Location '{location_name}' not found in world '{world_name}'")
            return False

        if is_discovered is not None:
            index["locations"][location_name]["is_discovered"] = is_discovered
        if label is not None:
            index["locations"][location_name]["label"] = label

        _save_index(index_file, index)
        logger.info(f"Updated location '{location_name}' in world '{world_name}'")
        return True

    @classmethod
    def cleanup_stale_entries(cls, world_name: str) -> List[str]:
        """Remove stale entries from _index.yaml that don't have directories."""
        world_path = WorldService.get_world_path(world_name)
        index_file, index = _load_index(world_name)
        if not index:
            return []

        removed = []
        locations = index.get("locations", {})
        valid_locations = {}

        for loc_name, loc_data in locations.items():
            loc_dir = world_path / "locations" / loc_name
            if loc_dir.is_dir():
                valid_locations[loc_name] = loc_data
            else:
                removed.append(loc_name)
                logger.info(f"Removing stale location '{loc_name}' from _index.yaml")

        if removed:
            index["locations"] = valid_locations
            _save_index(index_file, index)

        return removed

    @classmethod
    def load_location_events(cls, world_name: str, location_name: str) -> str:
        """Load events.md content for a location."""
        world_path = WorldService.get_world_path(world_name)
        events_file = world_path / "locations" / location_name / "events.md"

        if not events_file.exists():
            return ""

        try:
            return events_file.read_text(encoding="utf-8").strip()
        except Exception as e:
            logger.warning(f"Failed to load events.md for {location_name}: {e}")
            return ""

    @classmethod
    def add_location_event(cls, world_name: str, location_name: str, turn: int, event: str) -> None:
        """Add an event to a location's history."""
        world_path = WorldService.get_world_path(world_name)
        events_file = world_path / "locations" / location_name / "events.md"

        if not events_file.exists():
            return

        with open(events_file, "r", encoding="utf-8") as f:
            content = f.read()

        content += f"\n## Turn {turn}\n{event}\n"

        with open(events_file, "w", encoding="utf-8") as f:
            f.write(content)
