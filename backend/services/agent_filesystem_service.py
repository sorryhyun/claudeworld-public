"""
Agent filesystem service.

Handles agent file operations (create, archive) for worlds.
"""

import logging
import os
import shutil
from datetime import datetime
from typing import Optional

from services.world_service import WorldService

logger = logging.getLogger("AgentFilesystemService")


class AgentFilesystemService:
    """Agent filesystem management service."""

    @classmethod
    def create_agent(
        cls,
        world_name: str,
        agent_name: str,
        in_a_nutshell: str,
        characteristics: str,
        profile_pic_path: Optional[str] = None,
    ) -> None:
        """Create a new character agent in the world."""
        world_path = WorldService.get_world_path(world_name)
        agent_path = world_path / "agents" / agent_name

        agent_path.mkdir(exist_ok=True)

        with open(agent_path / "in_a_nutshell.md", "w", encoding="utf-8") as f:
            f.write(in_a_nutshell)

        with open(agent_path / "characteristics.md", "w", encoding="utf-8") as f:
            f.write(characteristics)

        if profile_pic_path and os.path.exists(profile_pic_path):
            ext = os.path.splitext(profile_pic_path)[1]
            shutil.copy(profile_pic_path, agent_path / f"profile{ext}")

        logger.info(f"Created agent '{agent_name}' in world '{world_name}'")

    @classmethod
    def archive_agent(cls, world_name: str, agent_name: str) -> bool:
        """
        Archive a character agent (move to archived folder).

        Used when a character dies, departs, or is manually removed.

        Args:
            world_name: Name of the world
            agent_name: Name of the agent to archive

        Returns:
            True if archived successfully, False if agent not found
        """
        world_path = WorldService.get_world_path(world_name)
        agent_path = world_path / "agents" / agent_name
        archived_path = world_path / "agents" / "_archived"

        if not agent_path.exists():
            logger.warning(f"Agent '{agent_name}' not found in world '{world_name}'")
            return False

        # Create archived directory if it doesn't exist
        archived_path.mkdir(exist_ok=True)

        # Move agent folder to archived (with timestamp to avoid collisions)
        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        archived_agent_path = archived_path / f"{agent_name}_{timestamp}"

        shutil.move(str(agent_path), str(archived_agent_path))
        logger.info(f"Archived agent '{agent_name}' in world '{world_name}' to {archived_agent_path}")
        return True

    @classmethod
    def list_world_agents(cls, world_name: str) -> list[str]:
        """
        List all agent names in a world's agents folder.

        Excludes archived agents and internal folders (starting with _).

        Args:
            world_name: Name of the world

        Returns:
            List of agent names (folder names)
        """
        world_path = WorldService.get_world_path(world_name)
        agents_path = world_path / "agents"

        if not agents_path.exists():
            return []

        agent_names = []
        for item in agents_path.iterdir():
            # Skip non-directories and internal folders (e.g., _archived)
            if item.is_dir() and not item.name.startswith("_"):
                # Verify it's a valid agent folder (has at least in_a_nutshell.md)
                if (item / "in_a_nutshell.md").exists() or (item / "characteristics.md").exists():
                    agent_names.append(item.name)

        return agent_names

    @classmethod
    def get_agent_details(cls, world_name: str, agent_name: str) -> Optional[dict]:
        """
        Get agent details from filesystem.

        Args:
            world_name: Name of the world
            agent_name: Name of the agent folder

        Returns:
            Dict with agent details or None if not found:
            - name: Agent name (display name, underscores replaced with spaces)
            - in_a_nutshell: Brief description
            - profile_pic: Path to profile picture (if exists)
        """
        world_path = WorldService.get_world_path(world_name)
        agent_path = world_path / "agents" / agent_name

        if not agent_path.exists():
            return None

        # Read in_a_nutshell
        in_a_nutshell = ""
        nutshell_file = agent_path / "in_a_nutshell.md"
        if nutshell_file.exists():
            try:
                in_a_nutshell = nutshell_file.read_text(encoding="utf-8").strip()
            except Exception as e:
                logger.warning(f"Failed to read in_a_nutshell.md for {agent_name}: {e}")

        # Find profile picture
        profile_pic = None
        profile_names = ["profile", "avatar", "picture", "photo"]
        profile_exts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
        for name in profile_names:
            for ext in profile_exts:
                pic_path = agent_path / f"{name}{ext}"
                if pic_path.exists():
                    profile_pic = str(pic_path)
                    break
            if profile_pic:
                break

        return {
            "name": agent_name,
            "folder_name": agent_name,
            "in_a_nutshell": in_a_nutshell,
            "profile_pic": profile_pic,
        }

    @classmethod
    def list_world_agents_with_details(cls, world_name: str) -> list[dict]:
        """
        List all agents in a world with their details.

        Args:
            world_name: Name of the world

        Returns:
            List of agent detail dicts
        """
        agent_names = cls.list_world_agents(world_name)
        agents = []
        for name in agent_names:
            details = cls.get_agent_details(world_name, name)
            if details:
                agents.append(details)
        return agents
