"""
World filesystem service - primary data source for worlds.
Database is cache only.

This module implements the filesystem-primary architecture for world data,
matching the existing agent configuration approach.

Includes file-based caching with mtime invalidation for frequently accessed
data like lore and world config.
"""

import logging
import os
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import yaml
from domain.entities.world_models import WorldConfig

logger = logging.getLogger("WorldService")


@dataclass
class CachedFile:
    """Cache entry with file mtime for invalidation."""

    content: str
    mtime: float


# Module-level caches with mtime tracking
_lore_cache: Dict[str, CachedFile] = {}
_config_cache: Dict[str, tuple[WorldConfig, float]] = {}  # (config, mtime)
_history_cache: Dict[str, CachedFile] = {}  # World history cache


def _get_worlds_dir() -> Path:
    """Get worlds directory, handling PyInstaller bundled mode."""
    from core.settings import get_settings

    return get_settings().worlds_dir


class WorldService:
    """Filesystem-primary world data service."""

    @staticmethod
    def get_world_path(world_name: str) -> Path:
        """Get the path to a world's directory."""
        # Sanitize name for filesystem
        safe_name = "".join(c for c in world_name if c.isalnum() or c in "._- ")
        safe_name = safe_name.strip()
        return _get_worlds_dir() / safe_name

    @classmethod
    def ensure_worlds_dir(cls) -> None:
        """Ensure the worlds directory exists."""
        _get_worlds_dir().mkdir(parents=True, exist_ok=True)

    @classmethod
    def create_world(
        cls, name: str, owner_id: str, user_name: Optional[str] = None, language: str = "en"
    ) -> WorldConfig:
        """Create a new world directory structure."""
        cls.ensure_worlds_dir()
        world_path = cls.get_world_path(name)

        if world_path.exists():
            raise ValueError(f"World '{name}' already exists")

        # Create directory structure
        world_path.mkdir(parents=True)
        (world_path / "agents").mkdir()
        (world_path / "locations").mkdir()
        (world_path / "maps").mkdir()
        (world_path / "items").mkdir()

        # Create initial files
        now = datetime.utcnow().isoformat() + "Z"

        # Convert enum to string if needed
        language_str = language
        if hasattr(language, "value"):
            language_str = language.value
        elif not isinstance(language, str):
            language_str = str(language)

        world_config = {
            "name": name,
            "owner_id": owner_id,
            "user_name": user_name,
            "language": language_str,
            "genre": None,
            "theme": None,
            "phase": "onboarding",
            "created_at": now,
            "updated_at": now,
            "settings": {
                "allow_death": True,
                "difficulty": "normal",
                "narrator_style": "atmospheric",
            },
        }

        with open(world_path / "world.yaml", "w", encoding="utf-8") as f:
            yaml.dump(world_config, f, allow_unicode=True, default_flow_style=False)

        # Empty stats (filled by World Seed Generator)
        with open(world_path / "stats.yaml", "w", encoding="utf-8") as f:
            yaml.dump({"stats": [], "derived": []}, f, allow_unicode=True)

        # Initial player state
        player_state = {
            "current_location": None,
            "turn_count": 0,
            "stats": {},
            "inventory": [],
            "effects": [],
            "recent_actions": [],
        }

        with open(world_path / "player.yaml", "w", encoding="utf-8") as f:
            yaml.dump(player_state, f, allow_unicode=True, default_flow_style=False)

        # Empty lore (filled by World Seed Generator)
        with open(world_path / "lore.md", "w", encoding="utf-8") as f:
            f.write("# World Lore\n\n*To be written...*\n")

        # Empty location index
        with open(world_path / "locations" / "_index.yaml", "w", encoding="utf-8") as f:
            yaml.dump({"locations": {}}, f, allow_unicode=True)

        # Initialize world history
        with open(world_path / "history.md", "w", encoding="utf-8") as f:
            f.write("# World History\n\n")

        logger.info(f"Created world '{name}' at {world_path}")
        return cls.load_world_config(name)

    @classmethod
    def load_world_config(cls, name: str) -> Optional[WorldConfig]:
        """
        Load world configuration from filesystem with mtime-based caching.

        Cache is automatically invalidated when file is modified.
        """
        world_path = cls.get_world_path(name)

        if not world_path.exists():
            # Remove from cache if world was deleted
            if name in _config_cache:
                del _config_cache[name]
            return None

        config_file = world_path / "world.yaml"
        if not config_file.exists():
            return None

        # Check file mtime for cache invalidation
        current_mtime = os.path.getmtime(config_file)

        # Check cache
        if name in _config_cache:
            cached_config, cached_mtime = _config_cache[name]
            if cached_mtime >= current_mtime:
                logger.debug(f"WorldConfig CACHE HIT for '{name}'")
                return cached_config
            else:
                logger.debug(f"WorldConfig CACHE STALE for '{name}' (file modified)")

        # Cache miss or stale - read from disk
        logger.debug(f"WorldConfig CACHE MISS for '{name}' - reading from disk")

        with open(config_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        if not data:
            return None

        # Parse timestamps
        created_at = data.get("created_at", datetime.utcnow().isoformat() + "Z")
        updated_at = data.get("updated_at", created_at)

        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at.rstrip("Z"))
        if isinstance(updated_at, str):
            updated_at = datetime.fromisoformat(updated_at.rstrip("Z"))

        config = WorldConfig(
            name=data.get("name", name),
            owner_id=data.get("owner_id"),
            user_name=data.get("user_name"),
            language=data.get("language", "en"),
            genre=data.get("genre"),
            theme=data.get("theme"),
            phase=data.get("phase", "onboarding"),
            created_at=created_at,
            updated_at=updated_at,
            settings=data.get("settings", {}),
            pending_phase=data.get("pending_phase"),
        )

        # Update cache
        _config_cache[name] = (config, current_mtime)
        return config

    @classmethod
    def save_world_config(cls, name: str, config: WorldConfig) -> None:
        """Save world configuration to filesystem."""
        world_path = cls.get_world_path(name)

        # Convert enum values to strings to avoid Python-specific YAML tags
        language = config.language
        if hasattr(language, "value"):
            language = language.value
        elif not isinstance(language, str):
            language = str(language)

        data = {
            "name": config.name,
            "owner_id": config.owner_id,
            "user_name": config.user_name,
            "language": language,
            "genre": config.genre,
            "theme": config.theme,
            "phase": config.phase,
            "created_at": config.created_at.isoformat() + "Z",
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "settings": config.settings,
        }

        # Only write pending_phase if it exists
        if config.pending_phase:
            data["pending_phase"] = config.pending_phase

        with open(world_path / "world.yaml", "w", encoding="utf-8") as f:
            yaml.dump(data, f, allow_unicode=True, default_flow_style=False)

        # Invalidate cache - will be re-read on next load_world_config() call
        if name in _config_cache:
            del _config_cache[name]
            logger.debug(f"WorldConfig cache invalidated for '{name}' (save_world_config)")

    @classmethod
    def apply_pending_phase(cls, world_name: str) -> bool:
        """
        Apply pending phase change if one exists.

        This is called after an agent's turn completes to apply deferred phase changes.
        The pending_phase is set by the `complete` tool during onboarding, and applied
        after the Onboarding Manager finishes its turn.

        Args:
            world_name: Name of the world

        Returns:
            True if a pending phase was applied, False otherwise
        """
        config = cls.load_world_config(world_name)
        if not config or not config.pending_phase:
            return False

        old_phase = config.phase
        config.phase = config.pending_phase
        config.pending_phase = None
        cls.save_world_config(world_name, config)

        logger.info(f"✅ Applied pending phase change for '{world_name}': {old_phase} -> {config.phase}")
        return True

    @classmethod
    def load_lore(cls, world_name: str) -> str:
        """
        Load world lore from filesystem with mtime-based caching.

        Cache is automatically invalidated when file is modified.
        This eliminates per-turn FS reads when lore hasn't changed.
        """
        world_path = cls.get_world_path(world_name)
        lore_file = world_path / "lore.md"

        if not lore_file.exists():
            # Remove from cache if file was deleted
            if world_name in _lore_cache:
                del _lore_cache[world_name]
            return ""

        # Check file mtime for cache invalidation
        current_mtime = os.path.getmtime(lore_file)

        # Check cache
        if world_name in _lore_cache:
            cached = _lore_cache[world_name]
            if cached.mtime >= current_mtime:
                logger.debug(f"Lore CACHE HIT for '{world_name}'")
                return cached.content
            else:
                logger.debug(f"Lore CACHE STALE for '{world_name}' (file modified)")

        # Cache miss or stale - read from disk
        logger.debug(f"Lore CACHE MISS for '{world_name}' - reading from disk")
        with open(lore_file, "r", encoding="utf-8") as f:
            content = f.read()

        # Update cache
        _lore_cache[world_name] = CachedFile(content=content, mtime=current_mtime)
        return content

    @classmethod
    def save_lore(cls, world_name: str, lore: str) -> None:
        """Save world lore to filesystem."""
        world_path = cls.get_world_path(world_name)

        with open(world_path / "lore.md", "w", encoding="utf-8") as f:
            f.write(lore)

        # Invalidate cache - will be re-read on next load_lore() call
        if world_name in _lore_cache:
            del _lore_cache[world_name]
            logger.debug(f"Lore cache invalidated for '{world_name}' (save_lore)")

    @classmethod
    def load_history(cls, world_name: str) -> str:
        """
        Load world history from filesystem with mtime-based caching.

        Cache is automatically invalidated when file is modified.
        """
        world_path = cls.get_world_path(world_name)
        history_file = world_path / "history.md"

        if not history_file.exists():
            # Remove from cache if file was deleted
            if world_name in _history_cache:
                del _history_cache[world_name]
            return ""

        # Check file mtime for cache invalidation
        current_mtime = os.path.getmtime(history_file)

        # Check cache
        if world_name in _history_cache:
            cached = _history_cache[world_name]
            if cached.mtime >= current_mtime:
                logger.debug(f"History CACHE HIT for '{world_name}'")
                return cached.content
            else:
                logger.debug(f"History CACHE STALE for '{world_name}' (file modified)")

        # Cache miss or stale - read from disk
        logger.debug(f"History CACHE MISS for '{world_name}' - reading from disk")
        with open(history_file, "r", encoding="utf-8") as f:
            content = f.read()

        # Update cache
        _history_cache[world_name] = CachedFile(content=content, mtime=current_mtime)
        return content

    @classmethod
    def add_history_entry(cls, world_name: str, turn: int, location_name: str, summary: str) -> None:
        """
        Add an entry to the world's history.md file.

        Includes deduplication to prevent identical entries from being written twice
        (can happen if the model calls the travel tool multiple times in one turn).

        Args:
            world_name: Name of the world
            turn: Current turn number
            location_name: Name of the location where events occurred
            summary: Summary of what happened
        """
        world_path = cls.get_world_path(world_name)
        history_file = world_path / "history.md"

        # Create file if it doesn't exist
        if not history_file.exists():
            with open(history_file, "w", encoding="utf-8") as f:
                f.write("# World History\n\n")

        # Load existing history
        with open(history_file, "r", encoding="utf-8") as f:
            content = f.read()

        # Build the new entry
        new_entry = f"\n## Turn {turn} - {location_name}\n{summary}\n"

        # Deduplication: check if the last entry is identical to what we're about to write
        # This prevents duplicate entries when the model calls travel twice
        if content.rstrip().endswith(summary.rstrip()):
            logger.warning(
                f"⚠️ Duplicate history entry detected for '{world_name}' at Turn {turn} - {location_name}, skipping"
            )
            return

        # Append new entry with location context
        content += new_entry

        with open(history_file, "w", encoding="utf-8") as f:
            f.write(content)

        # Invalidate cache
        if world_name in _history_cache:
            del _history_cache[world_name]
            logger.debug(f"History cache invalidated for '{world_name}' (add_history_entry)")

        logger.info(f"📝 Added history entry to {world_name}/history.md (Turn {turn} at {location_name})")

    @classmethod
    def list_worlds(cls, owner_id: Optional[str] = None) -> List[WorldConfig]:
        """List all worlds, optionally filtered by owner."""
        worlds = []
        worlds_dir = _get_worlds_dir()

        if not worlds_dir.exists():
            return worlds

        for world_dir in worlds_dir.iterdir():
            if world_dir.is_dir() and (world_dir / "world.yaml").exists():
                config = cls.load_world_config(world_dir.name)
                if config:
                    if owner_id is None or config.owner_id == owner_id:
                        worlds.append(config)

        return sorted(worlds, key=lambda w: w.updated_at, reverse=True)

    @classmethod
    def delete_world(cls, world_name: str) -> bool:
        """Delete a world and all its data."""
        world_path = cls.get_world_path(world_name)

        if not world_path.exists():
            return False

        shutil.rmtree(world_path)

        # Invalidate all caches for this world
        if world_name in _lore_cache:
            del _lore_cache[world_name]
        if world_name in _config_cache:
            del _config_cache[world_name]
        if world_name in _history_cache:
            del _history_cache[world_name]

        logger.info(f"Deleted world '{world_name}'")
        return True

    @classmethod
    def world_exists(cls, world_name: str) -> bool:
        """Check if a world exists."""
        world_path = cls.get_world_path(world_name)
        return world_path.exists() and (world_path / "world.yaml").exists()

    @classmethod
    def ensure_world_exists(cls, world_name: str, owner_id: str = "system") -> WorldConfig:
        """
        Ensure a world exists, creating it if necessary.

        Args:
            world_name: Name of the world
            owner_id: Owner ID if creating (default: "system")

        Returns:
            WorldConfig for the world
        """
        if cls.world_exists(world_name):
            return cls.load_world_config(world_name)
        else:
            return cls.create_world(world_name, owner_id)
