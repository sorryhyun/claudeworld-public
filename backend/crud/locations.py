"""
CRUD operations for Location entities and character-location relationships.

Location operations handle map locations within a world.
Character-location operations track which agents are present at each location via room membership.
"""

import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

import models
import schemas
from database import serialized_write
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload

logger = logging.getLogger("LocationCRUD")

# System agent groups to exclude when getting "characters" at a location
SYSTEM_AGENT_GROUPS = {"gameplay", "onboarding"}


async def create_location(
    db: AsyncSession,
    world_id: int,
    location: schemas.LocationCreate,
) -> models.Location:
    """Create a new location in a world with gameplay agents added to the room."""
    # Import here to avoid circular dependency
    from crud.worlds import add_gameplay_agents_to_room, get_world

    # Get world to use its owner_id for the location room (scoped to world owner, not global "system")
    world = await get_world(db, world_id)
    if not world:
        raise ValueError(f"World {world_id} not found")

    # Create a room for this location (with world_id set during creation for unique constraint)
    from crud.rooms import create_room

    room = await create_room(
        db,
        schemas.RoomCreate(name=f"Location: {location.display_name or location.name}"),
        owner_id=world.owner_id,  # Use world owner_id to scope rooms per world owner
        world_id=world_id,  # Set world_id during creation for unique constraint
    )

    # Add gameplay agents to the location room
    added_count = await add_gameplay_agents_to_room(db, room.id)
    if added_count == 0:
        logger.warning(f"No gameplay agents found to add to location room {room.id}")

    # Serialize adjacent locations
    adjacent_json = json.dumps(location.adjacent_to) if location.adjacent_to else None

    db_location = models.Location(
        world_id=world_id,
        name=location.name,
        display_name=location.display_name,
        description=location.description,
        position_x=location.position_x,
        position_y=location.position_y,
        adjacent_locations=adjacent_json,
        room_id=room.id,
        is_discovered=location.is_discovered,
    )
    db.add(db_location)

    async with serialized_write():
        await db.commit()

    await db.refresh(db_location)
    return db_location


async def create_new_room_for_location(
    db: AsyncSession,
    location: models.Location,
) -> models.Room:
    """
    Create a fresh room for an existing location (new visit).

    The old room remains in the database for history purposes.
    The location's room_id is updated to point to the new room.

    Args:
        db: Database session
        location: The location to create a new room for

    Returns:
        The newly created Room
    """
    from crud.rooms import create_room
    from crud.worlds import add_gameplay_agents_to_room, get_world

    # Get world for owner_id
    world = await get_world(db, location.world_id)
    if not world:
        raise ValueError(f"World {location.world_id} not found")

    # Create new room with unique name (timestamp ensures uniqueness across visits)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    room = await create_room(
        db,
        schemas.RoomCreate(name=f"Location: {location.display_name or location.name} [{timestamp}]"),
        owner_id=world.owner_id,
        world_id=location.world_id,
    )

    # Add gameplay agents to the new room
    await add_gameplay_agents_to_room(db, room.id)

    # Update location's room_id (old room remains for history)
    location.room_id = room.id

    async with serialized_write():
        await db.commit()

    await db.refresh(location)
    return room


async def get_location(
    db: AsyncSession,
    location_id: int,
) -> Optional[models.Location]:
    """Get a location by ID."""
    result = await db.execute(
        select(models.Location).options(selectinload(models.Location.room)).where(models.Location.id == location_id)
    )
    return result.scalar_one_or_none()


async def get_location_by_name(
    db: AsyncSession,
    world_id: int,
    location_name: str,
) -> Optional[models.Location]:
    """
    Find location by name or display_name (case-insensitive).

    Searches both `name` (folder name) and `display_name` (heading) columns,
    with whitespace/underscore normalization.

    Search order:
    1. Exact match on name
    2. Exact match on display_name
    3. Normalized match (spaces/underscores) on name
    4. Normalized match (spaces/underscores) on display_name
    """
    search_lower = location_name.lower()

    # 1. Try exact match on name (folder name)
    result = await db.execute(
        select(models.Location)
        .options(selectinload(models.Location.room))
        .where(models.Location.world_id == world_id)
        .where(func.lower(models.Location.name) == search_lower)
    )
    location = result.scalar_one_or_none()
    if location:
        return location

    # 2. Try exact match on display_name (heading)
    result = await db.execute(
        select(models.Location)
        .options(selectinload(models.Location.room))
        .where(models.Location.world_id == world_id)
        .where(func.lower(models.Location.display_name) == search_lower)
    )
    location = result.scalar_one_or_none()
    if location:
        return location

    # 3. Try normalized match on name (spaces <-> underscores)
    name_with_underscores = location_name.replace(" ", "_").lower()
    name_with_spaces = location_name.replace("_", " ").lower()

    for normalized in [name_with_underscores, name_with_spaces]:
        if normalized != search_lower:
            result = await db.execute(
                select(models.Location)
                .options(selectinload(models.Location.room))
                .where(models.Location.world_id == world_id)
                .where(func.lower(models.Location.name) == normalized)
            )
            location = result.scalar_one_or_none()
            if location:
                return location

    # 4. Try normalized match on display_name
    for normalized in [name_with_underscores, name_with_spaces]:
        if normalized != search_lower:
            result = await db.execute(
                select(models.Location)
                .options(selectinload(models.Location.room))
                .where(models.Location.world_id == world_id)
                .where(func.lower(models.Location.display_name) == normalized)
            )
            location = result.scalar_one_or_none()
            if location:
                return location

    return None


async def get_locations(
    db: AsyncSession,
    world_id: int,
) -> List[models.Location]:
    """Get all locations in a world."""
    result = await db.execute(
        select(models.Location).where(models.Location.world_id == world_id).order_by(models.Location.id)
    )
    return list(result.scalars().all())


async def delete_location(
    db: AsyncSession,
    location_id: int,
) -> bool:
    """
    Delete a location from the database.

    Also deletes the associated room if it exists.

    Args:
        db: Database session
        location_id: ID of the location to delete

    Returns:
        True if deleted, False if not found
    """
    location = await db.get(models.Location, location_id)
    if not location:
        return False

    room_id = location.room_id

    # Delete the location
    await db.delete(location)

    # Delete associated room if it exists
    if room_id:
        room = await db.get(models.Room, room_id)
        if room:
            await db.delete(room)

    async with serialized_write():
        await db.commit()

    logger.info(f"Deleted location {location_id} (room_id={room_id})")
    return True


async def sync_locations_with_filesystem(
    db: AsyncSession,
    world_id: int,
    world_name: str,
) -> int:
    """
    Sync database locations with filesystem _index.yaml.

    Deletes any locations from the database that no longer exist in the filesystem.

    Args:
        db: Database session
        world_id: ID of the world
        world_name: Name of the world (for filesystem path)

    Returns:
        Number of locations deleted
    """
    from services.location_service import LocationService

    # Get filesystem locations
    fs_locations = LocationService.load_all_locations(world_name)
    fs_location_names = set(fs_locations.keys())

    # Get database locations
    db_locations = await get_locations(db, world_id)

    # Find locations to delete (in DB but not in filesystem)
    deleted_count = 0
    for db_loc in db_locations:
        if db_loc.name not in fs_location_names:
            logger.info(f"Deleting orphaned location '{db_loc.name}' from world '{world_name}'")

            # Clean up room mapping in _state.json
            room_key = f"location:{db_loc.name}"
            LocationService.delete_room_mapping(world_name, room_key)

            # Delete from database
            await delete_location(db, db_loc.id)
            deleted_count += 1

    if deleted_count > 0:
        logger.info(f"Synced locations for world '{world_name}': deleted {deleted_count} orphaned locations")

    return deleted_count


async def update_location_label(
    db: AsyncSession,
    location_id: int,
    label: Optional[str],
) -> Optional[models.Location]:
    """Update a location's user-assigned label."""
    result = await db.execute(select(models.Location).where(models.Location.id == location_id))
    location = result.scalar_one_or_none()

    if not location:
        return None

    location.label = label

    async with serialized_write():
        await db.commit()

    await db.refresh(location)
    return location


async def add_adjacent_location(
    db: AsyncSession,
    location_id: int,
    adjacent_location_id: int,
) -> Optional[models.Location]:
    """Add an adjacent location connection."""
    result = await db.execute(select(models.Location).where(models.Location.id == location_id))
    location = result.scalar_one_or_none()

    if not location:
        return None

    # Parse existing adjacents
    adjacents = json.loads(location.adjacent_locations) if location.adjacent_locations else []

    # Add new adjacent if not already present
    if adjacent_location_id not in adjacents:
        adjacents.append(adjacent_location_id)
        location.adjacent_locations = json.dumps(adjacents)

        async with serialized_write():
            await db.commit()

    await db.refresh(location)
    return location


# =============================================================================
# Character Location Operations (via room membership)
# =============================================================================


async def add_character_to_location(
    db: AsyncSession,
    agent_id: int,
    location_id: int,
) -> bool:
    """
    Add a character (agent) to a location by adding them to the location's room.

    Args:
        db: Database session
        agent_id: ID of the agent to add
        location_id: ID of the location

    Returns:
        True if added successfully, False if location has no room
    """
    from crud.room_agents import add_agent_to_room

    location = await db.get(models.Location, location_id)
    if not location or not location.room_id:
        return False

    await add_agent_to_room(db, location.room_id, agent_id)
    return True


async def remove_character_from_location(
    db: AsyncSession,
    agent_id: int,
    location_id: int,
) -> bool:
    """
    Remove a character (agent) from a location by removing them from the location's room.

    Args:
        db: Database session
        agent_id: ID of the agent to remove
        location_id: ID of the location

    Returns:
        True if removed successfully, False if location has no room
    """
    from crud.room_agents import remove_agent_from_room

    location = await db.get(models.Location, location_id)
    if not location or not location.room_id:
        return False

    await remove_agent_from_room(db, location.room_id, agent_id)
    return True


async def move_character_to_location(
    db: AsyncSession,
    agent_id: int,
    from_location_id: Optional[int],
    to_location_id: int,
) -> bool:
    """
    Move a character from one location to another.

    Args:
        db: Database session
        agent_id: ID of the agent to move
        from_location_id: ID of the source location (can be None)
        to_location_id: ID of the destination location

    Returns:
        True if moved successfully
    """
    # Remove from old location
    if from_location_id:
        await remove_character_from_location(db, agent_id, from_location_id)

    # Add to new location
    return await add_character_to_location(db, agent_id, to_location_id)


async def get_agent_locations_in_world(
    db: AsyncSession,
    agent_id: int,
    world_id: int,
) -> List[models.Location]:
    """
    Get all locations where an agent is present in a specific world.

    Args:
        db: Database session
        agent_id: ID of the agent
        world_id: ID of the world

    Returns:
        List of Location models where the agent is present
    """
    # Query locations in this world where the agent is in the room
    result = await db.execute(
        select(models.Location)
        .where(models.Location.world_id == world_id)
        .options(selectinload(models.Location.room).selectinload(models.Room.agents))
    )
    locations = result.scalars().all()

    # Filter to locations where this agent is in the room
    agent_locations = []
    for location in locations:
        if not location.room:
            continue
        for agent in location.room.agents:
            if agent.id == agent_id:
                agent_locations.append(location)
                break

    return agent_locations


async def get_characters_at_location(
    db: AsyncSession,
    location_id: int,
    exclude_system_agents: bool = True,
) -> List[models.Agent]:
    """
    Get all character agents at a location (agents in the location's room).

    Args:
        db: Database session
        location_id: ID of the location
        exclude_system_agents: If True, excludes gameplay/onboarding agents

    Returns:
        List of Agent models at the location
    """
    # Chain selectinload to load room and its agents in a single query
    # This avoids issues with SQLAlchemy's identity map returning cached objects
    # that don't have the agents relationship loaded
    location = await db.get(
        models.Location,
        location_id,
        options=[selectinload(models.Location.room).selectinload(models.Room.agents)],
    )
    if not location or not location.room:
        return []

    agents = location.room.agents
    if exclude_system_agents:
        agents = [a for a in agents if a.group not in SYSTEM_AGENT_GROUPS]

    return agents


async def get_all_characters_in_world(
    db: AsyncSession,
    world_id: int,
    exclude_system_agents: bool = True,
) -> List[dict]:
    """
    Get all character agents across all locations in a world.

    Args:
        db: Database session
        world_id: ID of the world
        exclude_system_agents: If True, excludes gameplay/onboarding agents

    Returns:
        List of dicts with agent info and their location
    """
    # Get all locations with their rooms and room agents
    result = await db.execute(
        select(models.Location)
        .where(models.Location.world_id == world_id)
        .options(selectinload(models.Location.room).selectinload(models.Room.agents))
    )
    locations = result.scalars().all()

    # Collect unique characters with their location info
    characters = []
    seen_agent_ids = set()

    for location in locations:
        if not location.room:
            continue

        for agent in location.room.agents:
            # Skip if already seen (agent could be in multiple rooms)
            if agent.id in seen_agent_ids:
                continue

            # Skip system agents if requested
            if exclude_system_agents and agent.group in SYSTEM_AGENT_GROUPS:
                continue

            seen_agent_ids.add(agent.id)
            characters.append(
                {
                    "id": agent.id,
                    "name": agent.name,
                    "profile_pic": agent.profile_pic,
                    "in_a_nutshell": agent.in_a_nutshell,
                    "location_id": location.id,
                    "location_name": location.display_name or location.name,
                }
            )

    return characters
