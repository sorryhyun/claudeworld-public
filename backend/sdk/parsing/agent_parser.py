"""
Agent configuration parser for markdown files.

This module handles loading agent configurations from markdown files
following a specific format with standardized sections.
"""

import logging
from pathlib import Path
from typing import Dict, Optional

import yaml
from domain.entities.agent_config import AgentConfigData

from sdk.memory_parser import parse_long_term_memory

logger = logging.getLogger("ConfigParser")


def parse_agent_config(file_path: str) -> Optional[AgentConfigData]:
    """
    Parse an agent configuration from a folder with separate markdown files.

    Expected folder structure:
       agents/agent_name/
         ├── in_a_nutshell.md
         ├── characteristics.md
         ├── recent_events.md
         └── consolidated_memory.md (or long_term_memory.md)

    Args:
        file_path: Path to the agent folder (can be relative to project root)

    Returns:
        AgentConfigData object or None if folder doesn't exist
    """
    # Import here to avoid circular dependency
    from core.settings import get_settings

    # Resolve path relative to project root if not absolute
    path = Path(file_path)
    if not path.is_absolute():
        project_root = get_settings().project_root
        path = project_root / file_path

    if not path.exists() or not path.is_dir():
        return None

    try:
        return _parse_folder_config(path)
    except Exception as e:
        logger.error(f"Error parsing agent config {path}: {e}")
        return None


def _parse_folder_config(folder_path: Path) -> AgentConfigData:
    """Parse agent configuration from folder with separate .md files and optional config.yaml."""

    def read_section(filename: str) -> str:
        file_path = folder_path / filename
        if file_path.exists():
            with open(file_path, "r", encoding="utf-8") as f:
                return f.read().strip()
        return ""

    def read_yaml_config() -> dict:
        """Read optional config.yaml for additional settings like home_location."""
        config_file = folder_path / "config.yaml"
        if config_file.exists():
            try:
                with open(config_file, "r", encoding="utf-8") as f:
                    return yaml.safe_load(f) or {}
            except Exception as e:
                logger.warning(f"Failed to parse config.yaml in {folder_path}: {e}")
        return {}

    def find_profile_pic() -> Optional[str]:
        """Find profile picture file in the agent folder."""
        # Common image extensions to look for
        image_extensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
        # Common profile pic filenames
        common_names = ["profile", "avatar", "picture", "photo"]

        # First, try common profile pic filenames
        for name in common_names:
            for ext in image_extensions:
                pic_path = folder_path / f"{name}{ext}"
                if pic_path.exists():
                    return pic_path.name

        # If no common name found, look for any image file
        for ext in image_extensions:
            for file in folder_path.glob(f"*{ext}"):
                return file.name

        return None

    # Import here to avoid circular dependency
    from core.settings import get_settings

    settings = get_settings()

    # Parse long-term memory file based on environment configuration
    # Support both "long_term_memory.md" and "consolidated_memory.md"
    memory_filename = f"{settings.recall_memory_file}.md"
    long_term_memory_file = folder_path / memory_filename
    long_term_memory_index = None
    long_term_memory_subtitles = None

    # Load memory index for recall tool
    if long_term_memory_file.exists():
        long_term_memory_index = parse_long_term_memory(long_term_memory_file)
        if long_term_memory_index:
            # Create a comma-separated list of subtitles for context injection
            long_term_memory_subtitles = ", ".join(f"'{s}'" for s in long_term_memory_index.keys())

    # Read optional config.yaml for additional settings
    yaml_config = read_yaml_config()

    return AgentConfigData(
        in_a_nutshell=read_section("in_a_nutshell.md"),
        characteristics=read_section("characteristics.md"),
        recent_events=read_section("recent_events.md"),
        profile_pic=find_profile_pic(),
        long_term_memory_index=long_term_memory_index,
        long_term_memory_subtitles=long_term_memory_subtitles,
        home_location=yaml_config.get("home_location"),
    )


def list_available_configs() -> Dict[str, Dict[str, Optional[str]]]:
    """
    List all available agent configurations in folder format.

    Supports both direct agent folders and group-based organization:
    - agents/agent_name/ -> ungrouped agent
    - agents/group_체인소맨/agent_name/ -> agent in "체인소맨" group

    Returns:
        Dictionary mapping agent names to config info with keys:
        - "path": str (relative path to agent folder)
        - "group": Optional[str] (group name if in a group folder, None otherwise)
    """
    # Import here to avoid circular dependency
    from core.settings import get_settings

    settings = get_settings()
    project_root = settings.project_root
    agents_dir = settings.agents_dir

    if not agents_dir.exists():
        return {}

    configs = {}
    required_files = ["in_a_nutshell.md", "characteristics.md"]

    # Check for folder-based configs
    for item in agents_dir.iterdir():
        if not item.is_dir() or item.name.startswith("."):
            continue

        # Check if this is a group folder (starts with "group_")
        if item.name.startswith("group_"):
            # Extract group name (remove "group_" prefix)
            group_name = item.name[6:]  # Remove "group_" prefix

            # Scan for agent folders inside the group folder
            for agent_item in item.iterdir():
                if agent_item.is_dir() and not agent_item.name.startswith("."):
                    # Verify it has at least one required config file
                    if any((agent_item / f).exists() for f in required_files):
                        agent_name = agent_item.name
                        relative_path = agent_item.relative_to(project_root)
                        configs[agent_name] = {"path": str(relative_path), "group": group_name}
        else:
            # Regular agent folder (not in a group)
            if any((item / f).exists() for f in required_files):
                agent_name = item.name
                relative_path = item.relative_to(project_root)
                configs[agent_name] = {"path": str(relative_path), "group": None}

    return configs
