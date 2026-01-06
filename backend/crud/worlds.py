"""
CRUD operations for World entities.

Handles world creation, retrieval, updates, and deletion.
"""

import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

import schemas
from domain.value_objects.enums import WorldPhase
from infrastructure.database import models
from infrastructure.database.connection import serialized_write
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload

logger = logging.getLogger("WorldCRUD")

# Gameplay agents that should be added to location rooms
# Only Action_Manager and Narrator are in the tape - sub-agents (Item_Designer,
# Character_Designer, Location_Designer) are invoked via tools, not added to rooms
GAMEPLAY_AGENT_NAMES = [
    "Action_Manager",
    "Narrator",
]


async def get_gameplay_agents(db: AsyncSession) -> List[models.Agent]:
    """Get all gameplay agents by name."""
    result = await db.execute(select(models.Agent).where(models.Agent.name.in_(GAMEPLAY_AGENT_NAMES)))
    return list(result.scalars().all())


async def add_gameplay_agents_to_room(db: AsyncSession, room_id: int) -> int:
    """
    Add all gameplay agents to a location room.

    Args:
        db: Database session
        room_id: ID of the room to add agents to

    Returns:
        Number of agents added
    """
    from crud.room_agents import add_agent_to_room

    agents = await get_gameplay_agents(db)
    added_count = 0

    for agent in agents:
        result = await add_agent_to_room(db, room_id, agent.id)
        if result:
            added_count += 1
            logger.debug(f"Added gameplay agent '{agent.name}' to room {room_id}")

    if added_count > 0:
        logger.info(f"Added {added_count} gameplay agents to room {room_id}")

    return added_count


async def create_world(
    db: AsyncSession,
    world: schemas.WorldCreate,
    owner_id: str,
) -> models.World:
    """Create a new world with an onboarding room and empty player state."""
    from crud.rooms import create_room

    # Check if onboarding room already exists (from failed previous attempt)
    onboarding_room_name = f"Onboarding: {world.name}"
    result = await db.execute(
        select(models.Room).where(
            models.Room.owner_id == owner_id,  # Scoped to world owner
            models.Room.name == onboarding_room_name,
        )
    )
    onboarding_room = result.scalar_one_or_none()

    # Create onboarding room if it doesn't exist
    if onboarding_room is None:
        onboarding_room = await create_room(
            db,
            schemas.RoomCreate(name=onboarding_room_name),
            owner_id=owner_id,  # Use world owner_id to scope rooms per world owner
        )
    else:
        logger.info(f"Reusing existing onboarding room: {onboarding_room_name}")

    db_world = models.World(
        name=world.name,
        owner_id=owner_id,
        user_name=world.user_name,
        language=world.language,
        phase=WorldPhase.ONBOARDING,
        onboarding_room_id=onboarding_room.id,
    )
    db.add(db_world)
    await db.flush()

    # Link onboarding room to world (for CASCADE delete)
    onboarding_room.world_id = db_world.id

    # Create empty player state
    player_state = models.PlayerState(
        world_id=db_world.id,
        turn_count=0,
        stats="{}",
        inventory="[]",
        effects="[]",
        action_history="[]",
    )
    db.add(player_state)

    async with serialized_write():
        await db.commit()

    await db.refresh(db_world, attribute_names=["locations", "player_state", "onboarding_room"])
    return db_world


async def get_world(db: AsyncSession, world_id: int) -> Optional[models.World]:
    """Get a world by ID with relationships."""
    result = await db.execute(
        select(models.World)
        .options(
            selectinload(models.World.locations),
            selectinload(models.World.player_state).selectinload(models.PlayerState.current_location),
            selectinload(models.World.onboarding_room),
        )
        .where(models.World.id == world_id)
    )
    return result.scalar_one_or_none()


async def get_world_by_name(
    db: AsyncSession,
    name: str,
    owner_id: str,
) -> Optional[models.World]:
    """Get a world by name and owner."""
    result = await db.execute(
        select(models.World).where(models.World.name == name).where(models.World.owner_id == owner_id)
    )
    return result.scalar_one_or_none()


async def get_worlds_by_owner(
    db: AsyncSession,
    owner_id: str,
) -> List[models.World]:
    """Get all worlds owned by a user, sorted by last activity."""
    result = await db.execute(
        select(models.World)
        .where(models.World.owner_id == owner_id)
        .order_by(models.World.last_played_at.desc().nullsfirst())
    )
    return list(result.scalars().all())


async def update_world(
    db: AsyncSession,
    world_id: int,
    update: schemas.WorldUpdate,
) -> Optional[models.World]:
    """Update world configuration."""
    result = await db.execute(select(models.World).where(models.World.id == world_id))
    world = result.scalar_one_or_none()

    if not world:
        return None

    if update.phase is not None:
        world.phase = update.phase
    if update.genre is not None:
        world.genre = update.genre
    if update.theme is not None:
        world.theme = update.theme
    if update.user_name is not None:
        world.user_name = update.user_name
    if update.stat_definitions is not None:
        world.stat_definitions = json.dumps(update.stat_definitions)

    world.updated_at = datetime.now(timezone.utc)

    async with serialized_write():
        await db.commit()

    await db.refresh(world)
    return world


async def update_world_last_played(
    db: AsyncSession,
    world_id: int,
) -> None:
    """Update the last_played_at timestamp."""
    result = await db.execute(select(models.World).where(models.World.id == world_id))
    world = result.scalar_one_or_none()

    if world:
        world.last_played_at = datetime.now(timezone.utc)
        async with serialized_write():
            await db.commit()


async def delete_world(db: AsyncSession, world_id: int) -> bool:
    """Delete a world and all associated data.

    In PostgreSQL, rooms are deleted via Room.world_id FK CASCADE.
    For SQLite (tests), we manually delete rooms to ensure cleanup.
    Also deletes all agents associated with the world.
    """
    result = await db.execute(select(models.World).where(models.World.id == world_id))
    world = result.scalar_one_or_none()

    if not world:
        return False

    world_name = world.name

    # Get all rooms associated with this world (for manual deletion in SQLite)
    rooms_result = await db.execute(select(models.Room).where(models.Room.world_id == world_id))
    rooms_to_delete = rooms_result.scalars().all()

    # Get all agents associated with this world (for deletion)
    agents_result = await db.execute(select(models.Agent).where(models.Agent.world_name == world_name))
    agents_to_delete = agents_result.scalars().all()

    # Break circular dependency: World.onboarding_room_id <-> Room.world_id
    world.onboarding_room_id = None
    await db.flush()

    # Delete all world-specific agents
    for agent in agents_to_delete:
        await db.delete(agent)
    if agents_to_delete:
        logger.info(f"Deleted {len(agents_to_delete)} agents for world '{world_name}'")

    # Delete the world - cascades to:
    # - locations (via World.locations cascade)
    # - player_state (via World.player_state cascade)
    await db.delete(world)
    await db.flush()

    # Manually delete rooms (needed for SQLite which doesn't enforce FK CASCADE)
    for room in rooms_to_delete:
        await db.delete(room)

    async with serialized_write():
        await db.commit()

    return True


async def import_world_from_filesystem(
    db: AsyncSession,
    fs_config,  # WorldConfig from domain.world_models
    owner_id: str,
) -> models.World:
    """
    Import a world from filesystem into the database.

    This creates:
    - A World record in database with filesystem metadata
    - A placeholder onboarding room (for structural consistency)
    - Empty player state

    The world's phase, genre, theme etc. come from filesystem config.
    """
    from services.location_service import LocationService
    from services.player_service import PlayerService

    from crud.rooms import create_room

    # Create a room for the world (needed for DB structure)
    # For active worlds, this is the "home" room
    room_name = f"World: {fs_config.name}"
    room = await create_room(
        db,
        schemas.RoomCreate(name=room_name),
        owner_id=owner_id,
    )

    # Determine phase from filesystem
    phase = fs_config.phase
    if isinstance(phase, str):
        phase = WorldPhase(phase)

    # Create the world record
    db_world = models.World(
        name=fs_config.name,
        owner_id=owner_id,
        user_name=fs_config.user_name,
        language=fs_config.language,
        phase=phase,
        genre=fs_config.genre,
        theme=fs_config.theme,
        onboarding_room_id=room.id,
        created_at=fs_config.created_at or datetime.now(timezone.utc),
        updated_at=fs_config.updated_at or datetime.now(timezone.utc),
    )
    db.add(db_world)
    await db.flush()

    # Link room to world (for CASCADE delete)
    room.world_id = db_world.id

    # Load player state from filesystem
    fs_player_state = PlayerService.load_player_state(fs_config.name)

    # Create player state from filesystem data
    import json

    player_state = models.PlayerState(
        world_id=db_world.id,
        turn_count=fs_player_state.turn_count if fs_player_state else 0,
        stats=json.dumps(fs_player_state.stats) if fs_player_state else "{}",
        inventory=json.dumps(fs_player_state.inventory) if fs_player_state else "[]",
        effects=json.dumps(fs_player_state.effects) if fs_player_state else "[]",
        action_history=json.dumps(fs_player_state.recent_actions) if fs_player_state else "[]",
    )
    db.add(player_state)

    # Store room mapping in _state.json for FS-first architecture
    if phase == WorldPhase.ACTIVE:
        LocationService.set_room_mapping(
            world_name=fs_config.name,
            room_key="main",
            db_room_id=room.id,
            agents=["Action_Manager", "Narrator"],
        )
    else:
        LocationService.set_room_mapping(
            world_name=fs_config.name,
            room_key="onboarding",
            db_room_id=room.id,
            agents=["Onboarding_Manager"],
        )

    async with serialized_write():
        await db.commit()

    await db.refresh(db_world, attribute_names=["locations", "player_state", "onboarding_room"])

    logger.info(f"Imported world '{fs_config.name}' from filesystem (phase={phase})")
    return db_world
