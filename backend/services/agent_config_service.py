"""
Service for handling agent configuration file operations.

This service separates file I/O operations from database CRUD operations,
providing a cleaner separation of concerns and making the code more testable.

Note: When agent configs are modified (recent_events, profile pics, etc.),
the MCP cache is invalidated to ensure hot-reloading works correctly.
"""

import base64
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from infrastructure.locking import file_lock

if TYPE_CHECKING:
    from domain.entities.agent_config import AgentConfigData

logger = logging.getLogger("AgentConfigService")


def _invalidate_mcp_cache() -> None:
    """
    Invalidate the MCP config cache after agent config changes.

    This ensures hot-reloading works correctly - when agent configs change
    (e.g., memories updated, profile pics changed), the cached MCP
    configurations are cleared so the next request rebuilds them.
    """
    try:
        from sdk.client.mcp_registry import get_mcp_registry

        count = get_mcp_registry().invalidate_cache()
        if count > 0:
            logger.info(f"Invalidated MCP cache ({count} entries) due to agent config change")
    except Exception as e:
        logger.warning(f"Failed to invalidate MCP cache: {e}")


class AgentConfigService:
    """
    Handles all agent configuration file operations.
    Keeps file I/O separate from database operations in CRUD layer.
    """

    @staticmethod
    def get_project_root() -> Path:
        """Get the project root directory (handles PyInstaller bundles)."""
        from core.settings import get_settings

        return get_settings().project_root

    @staticmethod
    def append_to_recent_events(
        config_file: str,
        memory_entry: str,
        game_time: Optional[dict] = None,
    ) -> bool:
        """
        Append a memory entry to the agent's recent_events.md file.

        Args:
            config_file: Path to the agent's config file (relative to project root)
            memory_entry: One-liner memory to append
            game_time: Optional game time dict with 'day', 'hour', 'minute' keys

        Returns:
            True if successful, False otherwise
        """
        if not config_file:
            return False

        # Format timestamp using game time (Day X, HH:MM) or fallback to real date
        if game_time:
            day = game_time.get("day", 1)
            hour = game_time.get("hour", 0)
            minute = game_time.get("minute", 0)
            formatted_entry = f"- [Day {day}, {hour:02d}:{minute:02d}] {memory_entry}"
        else:
            from datetime import timezone

            timestamp = datetime.now(timezone.utc)
            formatted_entry = f"- [{timestamp.strftime('%Y-%m-%d')}] {memory_entry}"

        project_root = AgentConfigService.get_project_root()
        config_path = project_root / config_file

        if not config_path.is_dir():
            logger.warning(f"Warning: Config path {config_path} is not a directory")
            return False

        recent_events_file = config_path / "recent_events.md"

        try:
            with file_lock(str(recent_events_file), "a") as f:
                f.write("\n" + formatted_entry + "\n")

            logger.debug(f"Appended memory entry to {recent_events_file}")
            _invalidate_mcp_cache()
            return True

        except FileNotFoundError:
            # File doesn't exist, create it with the entry (no leading newline for first entry)
            try:
                with file_lock(str(recent_events_file), "w") as f:
                    f.write(formatted_entry + "\n")
                logger.debug(f"Created {recent_events_file} with memory entry")
                _invalidate_mcp_cache()
                return True
            except Exception as e:
                logger.error(f"Error: Could not create recent_events file: {e}")
                return False
        except Exception as e:
            logger.error(f"Error: Could not update recent_events file: {e}")
            return False

    @staticmethod
    def load_agent_config(config_file: str) -> Optional["AgentConfigData"]:
        """
        Load agent configuration from file.

        Args:
            config_file: Path to the agent's config file (relative to project root)

        Returns:
            AgentConfigData object or None if loading failed
        """
        if not config_file:
            return None

        try:
            from sdk.parsing import parse_agent_config

            # parse_agent_config now returns AgentConfigData directly
            return parse_agent_config(config_file)
        except Exception as e:
            logger.error(f"Error: Could not load agent config from {config_file}: {e}")
            return None

    @staticmethod
    def save_base64_profile_pic(agent_name: str, base64_data: str) -> bool:
        """
        Save a base64-encoded profile picture to the filesystem.

        Args:
            agent_name: The agent's name
            base64_data: Base64 data URL (e.g., "data:image/png;base64,...")

        Returns:
            True if saved successfully, False otherwise
        """
        # Match data URL format: data:image/{type};base64,{data}
        match = re.match(r"data:image/(\w+);base64,(.+)", base64_data)
        if not match:
            logger.warning(f"Invalid base64 data URL format for agent {agent_name}")
            return False

        image_type = match.group(1).lower()
        encoded_data = match.group(2)

        ext_map = {
            "png": ".png",
            "jpg": ".jpg",
            "jpeg": ".jpg",
            "gif": ".gif",
            "webp": ".webp",
            "svg+xml": ".svg",
            "svg": ".svg",
        }

        file_ext = ext_map.get(image_type, ".png")

        try:
            image_data = base64.b64decode(encoded_data)

            project_root = AgentConfigService.get_project_root()
            agents_dir = project_root / "agents"
            agent_folder = agents_dir / agent_name

            agent_folder.mkdir(parents=True, exist_ok=True)

            profile_path = agent_folder / f"profile{file_ext}"

            for old_file in agent_folder.glob("profile.*"):
                if old_file != profile_path:
                    old_file.unlink()

            profile_path.write_bytes(image_data)
            logger.info(f"Saved profile picture for {agent_name} to {profile_path}")
            _invalidate_mcp_cache()
            return True

        except Exception as e:
            logger.error(f"Failed to save profile picture for {agent_name}: {e}")
            return False
