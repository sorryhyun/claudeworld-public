"""
Agent Factory - Orchestrates agent creation and configuration.

This service separates business logic (config loading, prompt building, group settings)
from CRUD operations, providing cleaner separation of concerns.
"""

import logging
from dataclasses import dataclass
from typing import Dict, Optional

import crud
from core import get_settings
from domain.entities.agent_config import AgentConfigData
from infrastructure.database import models
from sdk.loaders import get_group_config
from sqlalchemy.ext.asyncio import AsyncSession

from .agent_config_service import AgentConfigService
from .prompt_builder import build_system_prompt

logger = logging.getLogger("AgentFactory")


@dataclass
class AgentSettings:
    """Resolved agent settings from group config and environment."""

    interrupt_every_turn: bool = False
    priority: int = 0
    transparent: bool = False


def merge_agent_configs(provided_config: AgentConfigData, file_config: Optional[AgentConfigData]) -> AgentConfigData:
    """
    Merge provided config values with file config values.
    Provided values take precedence over file values.

    Args:
        provided_config: AgentConfigData with user-provided values
        file_config: AgentConfigData from config file (or None)

    Returns:
        AgentConfigData with merged values
    """
    # Convert to dicts for merging
    provided_dict = {
        "in_a_nutshell": provided_config.in_a_nutshell or "",
        "characteristics": provided_config.characteristics or "",
        "recent_events": provided_config.recent_events or "",
        "profile_pic": provided_config.profile_pic or "",
    }

    file_dict = {}
    if file_config:
        file_dict = {
            "in_a_nutshell": file_config.in_a_nutshell or "",
            "characteristics": file_config.characteristics or "",
            "recent_events": file_config.recent_events or "",
            "profile_pic": file_config.profile_pic or "",
        }

    # Use the better merging logic: strip whitespace and prefer non-empty values
    merged = {}
    for field in provided_dict.keys():
        provided_val = provided_dict.get(field, "").strip()
        file_val = file_dict.get(field, "").strip()
        merged[field] = provided_val if provided_val else file_val

    return AgentConfigData(**merged)


def _resolve_group_settings(name: str, group: Optional[str]) -> AgentSettings:
    """
    Resolve agent settings from group config and environment variables.

    Args:
        name: Agent name
        group: Optional group name

    Returns:
        AgentSettings with resolved values
    """
    settings = AgentSettings()

    # Load group config if agent belongs to a group
    if group:
        group_config = get_group_config(group)
        if "interrupt_every_turn" in group_config:
            settings.interrupt_every_turn = bool(group_config["interrupt_every_turn"])
        if "priority" in group_config:
            settings.priority = group_config["priority"]
        if "transparent" in group_config:
            settings.transparent = bool(group_config["transparent"])

    # Apply PRIORITY_AGENTS env var (takes precedence over group config)
    priority_agent_names = get_settings().get_priority_agent_names()
    if name in priority_agent_names:
        # Set priority based on position in list (1-indexed, so first agent has highest priority)
        settings.priority = len(priority_agent_names) - priority_agent_names.index(name)
        logger.info(f"Agent '{name}' priority set to {settings.priority} from PRIORITY_AGENTS env var")

    return settings


class AgentFactory:
    """
    Factory for creating and managing agents.
    Orchestrates config loading, prompt building, and CRUD operations.
    """

    @staticmethod
    async def create_from_config(
        db: AsyncSession,
        name: str,
        config_file: str,
        group: Optional[str] = None,
        provided_config: Optional[AgentConfigData] = None,
        world_name: Optional[str] = None,
    ) -> models.Agent:
        """
        Create or update an agent from a config file.

        If an agent with the same name and world_name already exists, it will be
        updated instead of created. This handles cases where worlds are reset
        but database entries remain.

        Args:
            db: Database session
            name: Agent name
            config_file: Path to config file (relative to project root)
            group: Optional group name
            provided_config: Optional user-provided config values (override file)
            world_name: World name for world-specific characters (auto-detected from config_file if not provided)

        Returns:
            Created or updated Agent model
        """
        # 1. Load config from filesystem
        file_config = AgentConfigService.load_agent_config(config_file)

        # 2. Merge configs (provided values take precedence)
        if provided_config:
            final_config = merge_agent_configs(provided_config, file_config)
        else:
            final_config = file_config or AgentConfigData()

        # 3. Get profile_pic from provided or file config
        profile_pic = None
        if provided_config and provided_config.profile_pic:
            profile_pic = provided_config.profile_pic
        elif file_config and file_config.profile_pic:
            profile_pic = file_config.profile_pic

        # 4. Build system prompt
        system_prompt = build_system_prompt(name, final_config)

        # 5. Resolve group settings
        settings = _resolve_group_settings(name, group)

        # 6. Auto-detect world_name from config_file if not provided
        # Config files for world-specific agents are like: worlds/{world_name}/agents/{agent_name}
        effective_world_name = world_name
        if not effective_world_name and config_file and config_file.startswith("worlds/"):
            parts = config_file.split("/")
            if len(parts) >= 2:
                effective_world_name = parts[1]
                logger.debug(f"Auto-detected world_name '{effective_world_name}' from config_file")

        # 7. Check if agent already exists (handles stale DB entries after world reset)
        existing_agent = await crud.get_agent_by_name(db, name, world_name=effective_world_name)
        if existing_agent:
            logger.info(
                f"Agent '{name}' already exists in world '{effective_world_name}', updating instead of creating"
            )
            return await crud.update_agent(
                db=db,
                agent_id=existing_agent.id,
                system_prompt=system_prompt,
                profile_pic=profile_pic,
                in_a_nutshell=final_config.in_a_nutshell,
                characteristics=final_config.characteristics,
                recent_events=final_config.recent_events,
                interrupt_every_turn=settings.interrupt_every_turn,
                priority=settings.priority,
                transparent=settings.transparent,
            )

        # 8. Create via pure CRUD
        return await crud.create_agent(
            db=db,
            name=name,
            system_prompt=system_prompt,
            profile_pic=profile_pic,
            in_a_nutshell=final_config.in_a_nutshell,
            characteristics=final_config.characteristics,
            recent_events=final_config.recent_events,
            group=group,
            config_file=config_file,
            interrupt_every_turn=settings.interrupt_every_turn,
            priority=settings.priority,
            transparent=settings.transparent,
            world_name=effective_world_name,
        )

    @staticmethod
    async def reload_from_config(db: AsyncSession, agent_id: int) -> Optional[models.Agent]:
        """
        Reload an agent's data from its config file.

        Args:
            db: Database session
            agent_id: Agent ID

        Returns:
            Updated Agent model or None if not found

        Raises:
            ValueError: If agent has no config file
        """
        # Get the agent
        agent = await crud.get_agent(db, agent_id)
        if not agent:
            return None

        if not agent.config_file:
            raise ValueError(f"Agent {agent.name} does not have a config file to reload from")

        # Load config from filesystem
        config_data = AgentConfigService.load_agent_config(agent.config_file)
        if not config_data:
            raise ValueError(f"Failed to load config from {agent.config_file}")

        # Build new system prompt
        system_prompt = build_system_prompt(agent.name, config_data)

        # Resolve group settings
        settings = _resolve_group_settings(agent.name, agent.group)

        # Update via CRUD
        return await crud.update_agent(
            db=db,
            agent_id=agent_id,
            system_prompt=system_prompt,
            profile_pic=config_data.profile_pic,
            in_a_nutshell=config_data.in_a_nutshell,
            characteristics=config_data.characteristics,
            recent_events=config_data.recent_events,
            interrupt_every_turn=settings.interrupt_every_turn,
            priority=settings.priority,
            transparent=settings.transparent,
        )

    @staticmethod
    async def append_memory(db: AsyncSession, agent_id: int, memory_entry: str) -> Optional[models.Agent]:
        """
        Append a memory entry to an agent's recent_events file.
        FILESYSTEM-PRIMARY: Only writes to filesystem, database loaded fresh on next read.

        Args:
            db: Database session
            agent_id: Agent ID
            memory_entry: One-liner memory to append

        Returns:
            Agent object or None if not found
        """
        # Get the agent
        agent = await crud.get_agent(db, agent_id)
        if not agent:
            return None

        if not agent.config_file:
            logger.warning(f"Agent {agent.name} has no config file, cannot append memory")
            return agent

        # Write to filesystem (uses real-time fallback since no world context)
        success = AgentConfigService.append_to_recent_events(
            config_file=agent.config_file,
            memory_entry=memory_entry,
        )

        if success:
            # Invalidate agent config cache since recent_events changed
            from infrastructure.cache import agent_config_key, get_cache

            cache = get_cache()
            cache.invalidate(agent_config_key(agent_id))
        else:
            logger.warning(f"Failed to append memory to {agent.config_file}")

        return agent

    @staticmethod
    async def seed_from_configs(db: AsyncSession) -> Dict[str, models.Agent]:
        """
        Seed agents from config files at startup if they don't exist.

        Args:
            db: Database session

        Returns:
            Dict of agent_name -> Agent for created agents
        """
        from sdk.parsing import list_available_configs  # Lazy import to avoid circular dependency
        from sqlalchemy.future import select

        available_configs = list_available_configs()
        created_agents: Dict[str, models.Agent] = {}

        for agent_name, config_info in available_configs.items():
            config_path = config_info["path"]
            group_name = config_info["group"]

            # Check if agent already exists
            result = await db.execute(select(models.Agent).where(models.Agent.name == agent_name))
            existing_agent = result.scalar_one_or_none()

            if not existing_agent:
                # Create agent from config file
                agent = await AgentFactory.create_from_config(
                    db=db,
                    name=agent_name,
                    config_file=config_path,
                    group=group_name,
                )

                group_info = f" (group: {group_name})" if group_name else ""
                logger.info(f"Created agent '{agent_name}'{group_info} from config file: {config_path}")

                created_agents[agent_name] = agent

        return created_agents
