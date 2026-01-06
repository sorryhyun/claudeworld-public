"""
Unified context for tool handlers.

This module provides a ToolContext dataclass that consolidates the many parameters
previously passed to tool factory functions, improving type safety and reducing boilerplate.

Sub-agent invocation now uses SDK native Task tool + persist tools pattern.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from sdk.agent.agent_manager import AgentManager


@dataclass
class ToolContext:
    """Unified context passed to all tool handlers.

    This dataclass consolidates parameters that were previously passed individually
    to tool factory functions. It provides type-safe access to dependencies and
    helper methods to ensure required dependencies are available.

    Attributes:
        agent_name: Name of the agent using the tools
        agent_id: Database ID of the agent (for cache invalidation)
        config_file: Path to agent's configuration folder
        group_name: Optional group name for tool config overrides
        room_id: Optional room ID for current chatroom
        world_name: Optional world name for filesystem operations
        world_id: Optional world ID for database operations
        long_term_memory_index: Optional mapping of memory subtitles to content
        db: Optional async database session
        npc_reactions: Optional list of NPC reactions from the reaction cell
    """

    agent_name: str
    agent_id: Optional[int] = None
    config_file: Optional[Path] = None
    group_name: Optional[str] = None
    room_id: Optional[int] = None
    world_name: Optional[str] = None
    world_id: Optional[int] = None
    long_term_memory_index: Optional[dict[str, str]] = field(default_factory=dict)

    # Optional dependencies (set by factory functions that need them)
    db: Optional["AsyncSession"] = None
    npc_reactions: Optional[List[Dict[str, Any]]] = None

    # AgentManager for pre-connection in tools (e.g., travel tool pre-connects destination NPCs)
    agent_manager: Optional["AgentManager"] = None

    def require_db(self) -> "AsyncSession":
        """Get database session, raising if not configured.

        Returns:
            The async database session.

        Raises:
            RuntimeError: If database session is not configured.
        """
        if self.db is None:
            raise RuntimeError("Database session not configured for this context")
        return self.db

    def require_world_name(self) -> str:
        """Get world name, raising if not configured.

        Returns:
            The world name string.

        Raises:
            RuntimeError: If world_name is not configured.
        """
        if self.world_name is None:
            raise RuntimeError("World name not configured for this context")
        return self.world_name

    def require_world_id(self) -> int:
        """Get world ID, raising if not configured.

        Returns:
            The world ID integer.

        Raises:
            RuntimeError: If world_id is not configured.
        """
        if self.world_id is None:
            raise RuntimeError("World ID not configured for this context")
        return self.world_id

    def require_room_id(self) -> int:
        """Get room ID, raising if not configured.

        Returns:
            The room ID integer.

        Raises:
            RuntimeError: If room_id is not configured.
        """
        if self.room_id is None:
            raise RuntimeError("Room ID not configured for this context")
        return self.room_id

    def require_config_file(self) -> Path:
        """Get config file path, raising if not configured.

        Returns:
            The config file Path.

        Raises:
            RuntimeError: If config_file is not configured.
        """
        if self.config_file is None:
            raise RuntimeError("Config file path not configured for this context")
        return self.config_file

    def require_agent_id(self) -> int:
        """Get agent ID, raising if not configured.

        Returns:
            The agent ID integer.

        Raises:
            RuntimeError: If agent_id is not configured.
        """
        if self.agent_id is None:
            raise RuntimeError("Agent ID not configured for this context")
        return self.agent_id

    def require_player_facade(self) -> "PlayerFacade":
        """Get PlayerFacade instance for this context's world.

        Creates a PlayerFacade with the context's world_name, db, and world_id.

        Returns:
            PlayerFacade instance for FS-first player state management.

        Raises:
            RuntimeError: If world_name is not configured.
        """
        from services.facades.player_facade import PlayerFacade

        world_name = self.require_world_name()
        return PlayerFacade(
            world_name=world_name,
            db=self.db,
            world_id=self.world_id,
        )


# For type hints
if TYPE_CHECKING:
    from services.facades.player_facade import PlayerFacade
