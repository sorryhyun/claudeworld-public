"""
Service for handling agent configuration file operations.

This service separates file I/O operations from database CRUD operations,
providing a cleaner separation of concerns and making the code more testable.
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


class AgentConfigService:
    """
    Handles all agent configuration file operations.
    Keeps file I/O separate from database operations in CRUD layer.
    """

    @staticmethod
    def get_project_root() -> Path:
        """Get the project root directory (parent of backend/)."""
        backend_dir = Path(__file__).parent.parent
        return backend_dir.parent

    @staticmethod
    def append_to_recent_events(config_file: str, memory_entry: str, timestamp: Optional[datetime] = None) -> bool:
        """
        Append a memory entry to the agent's recent_events.md file.

        Args:
            config_file: Path to the agent's config file (relative to project root)
            memory_entry: One-liner memory to append
            timestamp: Optional timestamp (defaults to now)

        Returns:
            True if successful, False otherwise
        """
        if not config_file:
            return False

        if timestamp is None:
            timestamp = datetime.utcnow()

        # Format the memory entry with bullet point and timestamp
        formatted_entry = f"- [{timestamp.strftime('%Y-%m-%d')}] {memory_entry}"

        project_root = AgentConfigService.get_project_root()
        config_path = project_root / config_file

        # Check if it's a folder-based config
        if not config_path.is_dir():
            logger.warning(f"Warning: Config path {config_path} is not a directory")
            return False

        recent_events_file = config_path / "recent_events.md"

        try:
            # Use file locking to prevent race conditions
            # Mode 'a' for simple append - just add new line at end
            with file_lock(str(recent_events_file), "a") as f:
                # Append with double newline for better readability
                # file_lock ensures the file exists and handle is at end
                f.write("\n" + formatted_entry + "\n")

            logger.debug(f"Appended memory entry to {recent_events_file}")
            return True

        except FileNotFoundError:
            # File doesn't exist, create it with the entry (no leading newline for first entry)
            try:
                with file_lock(str(recent_events_file), "w") as f:
                    f.write(formatted_entry + "\n")
                logger.debug(f"Created {recent_events_file} with memory entry")
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

        # Map common MIME types to file extensions
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
            # Decode base64 data
            image_data = base64.b64decode(encoded_data)

            # Determine file path
            project_root = AgentConfigService.get_project_root()
            agents_dir = project_root / "agents"
            agent_folder = agents_dir / agent_name

            # Create agent folder if it doesn't exist
            agent_folder.mkdir(parents=True, exist_ok=True)

            # Save to profile.{ext}
            profile_path = agent_folder / f"profile{file_ext}"

            # Remove any existing profile pictures with different extensions
            for old_file in agent_folder.glob("profile.*"):
                if old_file != profile_path:
                    old_file.unlink()

            # Write the new profile picture
            profile_path.write_bytes(image_data)
            logger.info(f"Saved profile picture for {agent_name} to {profile_path}")
            return True

        except Exception as e:
            logger.error(f"Failed to save profile picture for {agent_name}: {e}")
            return False
