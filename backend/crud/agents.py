"""
CRUD operations for Agent entities.

This module contains pure database operations only.
Business logic (config loading, prompt building) is in services/agent_factory.py.
"""

import logging
from typing import List, Optional

import models
from database import retry_on_db_lock, serialized_write
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

logger = logging.getLogger("CRUD")


@retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2)
async def create_agent(
    db: AsyncSession,
    name: str,
    system_prompt: str,
    profile_pic: Optional[str] = None,
    in_a_nutshell: Optional[str] = None,
    characteristics: Optional[str] = None,
    recent_events: Optional[str] = None,
    group: Optional[str] = None,
    config_file: Optional[str] = None,
    interrupt_every_turn: bool = False,
    priority: int = 0,
    transparent: bool = False,
    world_name: Optional[str] = None,
) -> models.Agent:
    """
    Create an agent in the database.

    This is a pure CRUD operation. For creating agents from config files,
    use AgentFactory.create_from_config() instead.

    Args:
        db: Database session
        name: Agent name
        system_prompt: Pre-built system prompt
        profile_pic: Profile picture URL or path
        in_a_nutshell: Brief agent summary
        characteristics: Agent personality traits
        recent_events: Recent events text
        group: Optional group name
        config_file: Optional config file path
        interrupt_every_turn: Whether agent interrupts every turn
        priority: Agent priority (higher = responds first)
        transparent: Whether agent's responses don't trigger others
        world_name: World name for world-specific characters (NULL for system agents)

    Returns:
        Created Agent model
    """
    db_agent = models.Agent(
        name=name,
        world_name=world_name,
        group=group,
        config_file=config_file,
        profile_pic=profile_pic,
        in_a_nutshell=in_a_nutshell,
        characteristics=characteristics,
        recent_events=recent_events,
        system_prompt=system_prompt,
        interrupt_every_turn=bool(interrupt_every_turn),
        priority=priority,
        transparent=bool(transparent),
    )
    db.add(db_agent)
    async with serialized_write():
        await db.commit()
    await db.refresh(db_agent)
    return db_agent


async def get_all_agents(db: AsyncSession) -> List[models.Agent]:
    """Get all agents globally."""
    result = await db.execute(select(models.Agent))
    return result.scalars().all()


async def get_agent(db: AsyncSession, agent_id: int) -> Optional[models.Agent]:
    """Get a specific agent by ID."""
    result = await db.execute(select(models.Agent).where(models.Agent.id == agent_id))
    return result.scalar_one_or_none()


async def get_agent_by_name(db: AsyncSession, name: str, world_name: Optional[str] = None) -> Optional[models.Agent]:
    """
    Get a specific agent by name, handling whitespace/underscore variations.

    Args:
        db: Database session
        name: Agent name to search for
        world_name: Optional world name to filter by (required when multiple
                    agents with same name exist across different worlds)

    Tries multiple name formats:
    1. Original name as-is
    2. Spaces replaced with underscores
    3. Underscores replaced with spaces
    """

    def _build_query(agent_name: str):
        """Build query with optional world_name filter."""
        query = select(models.Agent).where(models.Agent.name == agent_name)
        if world_name is not None:
            query = query.where(models.Agent.world_name == world_name)
        return query

    # Try original name first
    result = await db.execute(_build_query(name))
    agent = result.scalar_one_or_none()
    if agent:
        return agent

    # Try with spaces -> underscores
    name_with_underscores = name.replace(" ", "_")
    if name_with_underscores != name:
        result = await db.execute(_build_query(name_with_underscores))
        agent = result.scalar_one_or_none()
        if agent:
            return agent

    # Try with underscores -> spaces
    name_with_spaces = name.replace("_", " ")
    if name_with_spaces != name:
        result = await db.execute(_build_query(name_with_spaces))
        agent = result.scalar_one_or_none()
        if agent:
            return agent

    return None


@retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2)
async def delete_agent(db: AsyncSession, agent_id: int) -> bool:
    """Delete an agent permanently."""
    result = await db.execute(select(models.Agent).where(models.Agent.id == agent_id))
    agent = result.scalar_one_or_none()
    if agent:
        await db.delete(agent)
        async with serialized_write():
            await db.commit()
        return True
    return False


@retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2)
async def delete_agents_by_world(db: AsyncSession, world_name: str) -> int:
    """
    Delete all agents associated with a specific world.

    Args:
        db: Database session
        world_name: The world name to delete agents for

    Returns:
        Number of agents deleted
    """
    result = await db.execute(select(models.Agent).where(models.Agent.world_name == world_name))
    agents = result.scalars().all()

    count = len(agents)
    for agent in agents:
        await db.delete(agent)

    if count > 0:
        async with serialized_write():
            await db.commit()
        logger.info(f"Deleted {count} agents for world '{world_name}'")

    return count


async def get_agents_by_world(db: AsyncSession, world_name: str) -> List[models.Agent]:
    """Get all agents for a specific world."""
    result = await db.execute(select(models.Agent).where(models.Agent.world_name == world_name))
    return list(result.scalars().all())


@retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2)
async def sync_agents_with_filesystem(db: AsyncSession, world_name: str) -> int:
    """
    Sync agents with filesystem - delete agents whose config directories no longer exist.

    This handles the case where agent folders are removed from the filesystem
    but database entries remain (stale agents).

    Args:
        db: Database session
        world_name: The world name to sync agents for

    Returns:
        Number of stale agents deleted
    """
    from pathlib import Path

    agents = await get_agents_by_world(db, world_name)
    deleted_count = 0

    for agent in agents:
        if agent.config_file:
            config_path = Path(agent.config_file)
            # Check if config directory exists (for folder-based configs)
            # or if config file exists (for single-file configs)
            if not config_path.exists() and not config_path.with_suffix(".md").exists():
                logger.info(f"Deleting stale agent '{agent.name}' - config not found at '{agent.config_file}'")
                await db.delete(agent)
                deleted_count += 1

    if deleted_count > 0:
        async with serialized_write():
            await db.commit()
        logger.info(f"Cleaned up {deleted_count} stale agents for world '{world_name}'")

    return deleted_count


@retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2)
async def update_agent(
    db: AsyncSession,
    agent_id: int,
    system_prompt: Optional[str] = None,
    profile_pic: Optional[str] = None,
    in_a_nutshell: Optional[str] = None,
    characteristics: Optional[str] = None,
    recent_events: Optional[str] = None,
    interrupt_every_turn: Optional[bool] = None,
    priority: Optional[int] = None,
    transparent: Optional[bool] = None,
) -> Optional[models.Agent]:
    """
    Update an agent's fields in the database.

    This is a pure CRUD operation. For reloading from config files,
    use AgentFactory.reload_from_config() instead.

    Only updates fields that are explicitly provided (not None).

    Args:
        db: Database session
        agent_id: Agent ID
        system_prompt: New system prompt
        profile_pic: New profile picture
        in_a_nutshell: New nutshell summary
        characteristics: New characteristics
        recent_events: New recent events
        interrupt_every_turn: Whether agent interrupts every turn
        priority: Agent priority
        transparent: Whether agent is transparent

    Returns:
        Updated Agent model or None if not found
    """
    result = await db.execute(select(models.Agent).where(models.Agent.id == agent_id))
    agent = result.scalar_one_or_none()

    if not agent:
        return None

    # Update fields if provided
    if system_prompt is not None:
        agent.system_prompt = system_prompt
    if profile_pic is not None:
        # Check if it's a base64 data URL - save to filesystem
        if profile_pic.startswith("data:image/"):
            from services.agent_config_service import AgentConfigService

            AgentConfigService.save_base64_profile_pic(agent.name, profile_pic)
            agent.profile_pic = None  # Clear DB field - images served from filesystem
        else:
            agent.profile_pic = profile_pic
    if in_a_nutshell is not None:
        agent.in_a_nutshell = in_a_nutshell
    if characteristics is not None:
        agent.characteristics = characteristics
    if recent_events is not None:
        agent.recent_events = recent_events
    if interrupt_every_turn is not None:
        agent.interrupt_every_turn = bool(interrupt_every_turn)
    if priority is not None:
        agent.priority = priority
    if transparent is not None:
        agent.transparent = bool(transparent)

    async with serialized_write():
        await db.commit()
    await db.refresh(agent)

    # Invalidate agent caches
    from infrastructure.cache import agent_config_key, agent_object_key, get_cache

    cache = get_cache()
    cache.invalidate(agent_config_key(agent_id))
    cache.invalidate(agent_object_key(agent_id))

    return agent
