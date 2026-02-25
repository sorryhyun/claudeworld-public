"""
World management routes for TRPG gameplay.

Handles world CRUD operations:
- Create, list, get, delete worlds
- Enter world (start gameplay)
- Reset world to initial state
- Import worlds from filesystem
"""

import logging
from typing import Optional

import crud
import schemas
from core.dependencies import (
    RequestIdentity,
    get_agent_manager,
    get_request_identity,
)
from domain.services.localization import Localization
from domain.value_objects.enums import Language, MessageRole, WorldPhase
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from infrastructure.database import models
from infrastructure.database.connection import async_session_maker, get_db, serialized_write
from orchestration import get_trpg_orchestrator
from sdk import AgentManager
from services.location_storage import LocationStorage
from services.player_service import PlayerService
from services.room_mapping_service import RoomMappingService
from services.world_reset_service import WorldResetService
from services.world_service import WorldService
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

logger = logging.getLogger("GameRouter.Worlds")

router = APIRouter()


# =============================================================================
# FS↔DB SYNC HELPERS (formerly WorldFacade)
# =============================================================================


async def _sync_world_from_fs(db: AsyncSession, world: models.World) -> bool:
    """Sync DB state from FS (source of truth). Returns True if anything changed."""
    fs_config = WorldService.load_world_config(world.name)
    if not fs_config:
        logger.warning(f"FS config not found for world '{world.name}'")
        return False

    updates = {}
    if fs_config.phase != world.phase:
        updates["phase"] = fs_config.phase
    if fs_config.user_name and fs_config.user_name != world.user_name:
        updates["user_name"] = fs_config.user_name
    if fs_config.genre and fs_config.genre != world.genre:
        updates["genre"] = fs_config.genre
    if fs_config.theme and fs_config.theme != world.theme:
        updates["theme"] = fs_config.theme

    if updates:
        await crud.update_world(db, world.id, schemas.WorldUpdate(**updates))
        logger.info(f"Synced {len(updates)} fields for world '{world.name}'")
        return True
    return False


async def _create_location_from_filesystem(
    db: AsyncSession, world_name: str, world_id: int, location_name: str
) -> Optional[models.Location]:
    """Create a location in the database from filesystem data."""
    from crud.room_agents import add_agent_to_room

    try:
        loc_config = LocationStorage.load_location(world_name, location_name)
        if not loc_config:
            logger.warning(f"Location '{location_name}' not found in filesystem")
            return None

        # Check for existing room mapping to preserve agents added during onboarding
        room_key = RoomMappingService.location_to_room_key(location_name)
        existing_mapping = RoomMappingService.get_room_mapping(world_name, room_key)
        existing_agents = existing_mapping.agents if existing_mapping else []

        position = loc_config.position if isinstance(loc_config.position, tuple) else (0, 0)
        location_create = schemas.LocationCreate(
            name=location_name,
            display_name=loc_config.display_name,
            description=loc_config.description or "",
            position_x=position[0],
            position_y=position[1],
            adjacent_to=None,
            is_discovered=loc_config.is_discovered,
            is_draft=loc_config.is_draft,
        )

        db_location = await crud.create_location(db, world_id, location_create)
        logger.info(f"Created location '{location_name}' in database (id={db_location.id})")

        # Store room mapping and add agents
        if db_location.room_id:
            RoomMappingService.set_room_mapping(
                world_name=world_name,
                room_key=room_key,
                db_room_id=db_location.room_id,
                agents=existing_agents,
            )
            for agent_name in existing_agents:
                agent = await crud.get_agent_by_name(db, agent_name)
                if agent:
                    await add_agent_to_room(db, db_location.room_id, agent.id)
            if existing_agents:
                logger.info(f"Added {len(existing_agents)} agents to room {db_location.room_id}")

        return db_location
    except Exception as e:
        logger.error(f"Failed to create location '{location_name}' from filesystem: {e}")
        return None


def _build_world_response(world: models.World) -> schemas.World:
    """Build a full World response with lore and stat definitions from FS."""
    lore = WorldService.load_lore(world.name)
    stat_defs = PlayerService.load_stat_definitions(world.name)

    world_schema = schemas.World.model_validate(world)
    world_schema.lore = lore
    world_schema.stat_definitions = schemas.StatDefinitions(
        stats=[schemas.StatDefinition(**s) for s in stat_defs.get("stats", [])]
    )
    return world_schema


# =============================================================================
# WORLD MANAGEMENT
# =============================================================================


@router.post("/", response_model=schemas.WorldSummary)
async def create_world(
    world: schemas.WorldCreate,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Create a new game world and start onboarding.

    This creates:
    - Filesystem structure for the world (primary)
    - A World record in database (cache)
    - Room mapping in _state.json (links FS to DB)
    - Adds Onboarding Manager to the room
    - Sends "Start onboarding" system message to trigger the agent
    """
    # Check if world with same name exists
    existing = await crud.get_world_by_name(db, world.name, identity.user_id)
    if existing:
        raise HTTPException(status_code=400, detail=f"World '{world.name}' already exists")

    # Create filesystem structure first (source of truth)
    try:
        WorldService.create_world(world.name, identity.user_id, world.user_name, world.language)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Create database record (cache for queries + room/message storage)
    db_world = await crud.create_world(db, world, identity.user_id)

    # Store onboarding room mapping in _state.json (Phase 1.3 - FS-first architecture)
    if db_world.onboarding_room_id:
        RoomMappingService.set_room_mapping(
            world_name=world.name,
            room_key="onboarding",
            db_room_id=db_world.onboarding_room_id,
            agents=["Onboarding_Manager"],
        )
        RoomMappingService.set_current_room(world.name, "onboarding")
        logger.info(f"Stored onboarding room mapping for world '{world.name}'")

    # Find and add Onboarding Manager to the onboarding room
    result = await db.execute(select(models.Agent).where(models.Agent.name == "Onboarding_Manager"))
    onboarding_agent = result.scalar_one_or_none()

    if onboarding_agent and db_world.onboarding_room_id:
        # Add agent to the onboarding room
        await crud.add_agent_to_room(db, db_world.onboarding_room_id, onboarding_agent.id)

        # Create system message to trigger onboarding
        # Include user_name if provided for personalized greeting
        onboarding_content = Localization.get_onboarding_message(world.language)
        # System message to trigger onboarding - Onboarding_Manager's group has
        # can_see_system_messages: true, so it will see this in conversation context
        system_message = schemas.MessageCreate(
            content=onboarding_content,
            role=MessageRole.USER,
            participant_type="system",
            participant_name="System",
        )
        await crud.create_message(
            db, db_world.onboarding_room_id, system_message, update_room_activity=True
        )

        logger.info(f"Onboarding room ready for world '{world.name}' (trigger via /start-onboarding)")

    logger.info(f"Created world '{world.name}' for user '{identity.user_id}'")
    return db_world


@router.post("/{world_id}/start-onboarding")
async def start_onboarding(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
):
    """
    Trigger the Onboarding Manager to send its first message.

    Called by frontend after SSE connection is established, so that
    thinking stream is visible from the very first message.
    """
    import asyncio

    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.phase != WorldPhase.ONBOARDING:
        raise HTTPException(status_code=400, detail="World is not in onboarding phase")
    if not world.onboarding_room_id:
        raise HTTPException(status_code=400, detail="World has no onboarding room")

    onboarding_content = Localization.get_onboarding_message(world.language)

    async def trigger():
        async with async_session_maker() as session:
            trpg_orchestrator = get_trpg_orchestrator()
            task_world = await crud.get_world(session, world_id)
            if task_world:
                await trpg_orchestrator.handle_player_action(
                    db=session,
                    room_id=task_world.onboarding_room_id,
                    action_text=onboarding_content,
                    agent_manager=agent_manager,
                    world=task_world,
                )

    asyncio.create_task(trigger())
    return {"status": "started"}


@router.get("/", response_model=list[schemas.WorldSummary])
async def list_worlds(
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """List all worlds owned by the current user."""
    return await crud.get_worlds_by_owner(db, identity.user_id)


@router.get("/importable", response_model=list[schemas.ImportableWorld])
async def list_importable_worlds(
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    List worlds that exist in filesystem but not in database.
    These are worlds that can be imported/loaded.
    """
    fs_worlds = WorldService.list_worlds()
    db_worlds = await crud.get_worlds_by_owner(db, identity.user_id)
    db_world_names = {w.name for w in db_worlds}
    importable = [w for w in fs_worlds if w.name not in db_world_names]

    return [
        schemas.ImportableWorld(
            name=w.name,
            owner_id=w.owner_id,
            user_name=w.user_name,
            language=w.language,
            phase=w.phase,
            genre=w.genre,
            theme=w.theme,
            created_at=w.created_at,
        )
        for w in importable
    ]


@router.post("/import/{world_name}", response_model=schemas.WorldSummary)
async def import_world(
    world_name: str,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Import a world from filesystem into the database.
    This creates the database records for an existing filesystem world.
    """
    # Check FS
    fs_config = WorldService.load_world_config(world_name)
    if not fs_config:
        raise HTTPException(status_code=404, detail=f"World '{world_name}' not found in filesystem")

    # Check DB
    existing = await crud.get_world_by_name(db, world_name, identity.user_id)
    if existing:
        raise HTTPException(status_code=400, detail=f"World '{world_name}' already exists in database")

    db_world = await crud.import_world_from_filesystem(db, fs_config, identity.user_id)
    logger.info(f"Imported world '{world_name}' for user '{identity.user_id}'")
    return db_world


@router.get("/{world_id}", response_model=schemas.World)
async def get_world(
    world_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
):
    """Get world details including phase, lore, and stat definitions."""
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not your world")

    # Sync from filesystem (source of truth)
    synced = await _sync_world_from_fs(db, world)
    if synced:
        world = await crud.get_world(db, world_id)

    # Pre-connect agents for active worlds (reduces first-action latency)
    if world.phase == WorldPhase.ACTIVE:
        # Get current location's room_id for pre-connect
        player_state = await crud.get_player_state(db, world_id)
        if player_state and player_state.current_location_id:
            location = await crud.get_location(db, player_state.current_location_id)
            if location and location.room_id:
                target_room_id = location.room_id
                current_location_id = player_state.current_location_id

                async def pre_connect_agents():
                    async with async_session_maker() as session:
                        # Pre-connect Action Manager
                        am_agent = await crud.get_agent_by_name(session, "Action_Manager")
                        if am_agent:
                            await agent_manager.pre_connect(
                                db=session,
                                room_id=target_room_id,
                                agent_id=am_agent.id,
                                agent_name="Action_Manager",
                                world_name=world.name,
                                world_id=world.id,
                                config_file=am_agent.config_file,
                                group_name=am_agent.group,
                            )

                        # Pre-connect NPCs at current location (max 5)
                        npcs = await crud.get_characters_at_location(
                            session, current_location_id, exclude_system_agents=True
                        )
                        for npc in npcs[:5]:
                            await agent_manager.pre_connect(
                                db=session,
                                room_id=target_room_id,
                                agent_id=npc.id,
                                agent_name=npc.name,
                                world_name=world.name,
                                world_id=world.id,
                                config_file=npc.config_file,
                                group_name=npc.group,
                            )

                background_tasks.add_task(pre_connect_agents)

    # Build full response with lore and stat definitions from FS
    return _build_world_response(world)


@router.delete("/{world_id}")
async def delete_world(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """Delete a world and all associated data (FS + DB)."""
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized to delete this world")

    world_name = world.name

    # Delete DB records (CASCADE deletes rooms)
    await crud.delete_world(db, world_id)

    # Delete FS data
    WorldService.delete_world(world_name)

    logger.info(f"Deleted world '{world_name}' (FS + DB)")
    return {"status": "deleted"}


@router.get("/{world_id}/characters")
async def get_world_characters(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Get all characters (non-system agents) in the world.

    Returns characters from all locations with their location info.
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not your world")

    characters = await crud.get_all_characters_in_world(db, world_id)
    return {"characters": characters}


@router.get("/{world_id}/history")
async def get_world_history(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Get the history.md content for a world.

    Returns the world's history as markdown text (read-only).
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not your world")

    history = WorldService.load_history(world.name)
    return {"history": history}


@router.post("/{world_id}/history/compress")
async def compress_world_history(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
):
    """
    Compress history.md into consolidated_history.md.

    Groups turns into batches of 3 and uses History_Summarizer agent
    to create consolidated sections with meaningful subtitles.
    Clears history.md after compression.

    Returns:
        - success: bool
        - turns_compressed: number of turns processed
        - sections_created: number of consolidated sections created
        - message: status message
    """
    from services.history_compression_service import HistoryCompressionService

    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not your world")

    try:
        result = await HistoryCompressionService.compress_history(
            db=db,
            world_name=world.name,
            agent_manager=agent_manager,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to compress history for world '{world.name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to compress history: {str(e)}")


async def _perform_world_reset(
    db: AsyncSession,
    world: models.World,
    agent_manager: AgentManager,
) -> tuple[models.Location, str]:
    """
    Perform world reset logic (shared by enter_world and reset_world).

    Returns:
        Tuple of (starting_location, arrival_content)
    """
    import json

    from domain.entities.world_models import PlayerState as FSPlayerState

    # Load initial state from _initial.json
    initial_state = WorldResetService.load_initial_state(world.name)
    if not initial_state:
        raise ValueError("No initial state found for this world")

    starting_location_name = initial_state["starting_location"]
    initial_stats = initial_state["initial_stats"]
    initial_inventory = initial_state["initial_inventory"]
    initial_game_time = initial_state.get("initial_game_time", {"hour": 8, "minute": 0, "day": 1})

    logger.info(f"Resetting world '{world.name}' to initial state")

    # Clean up stale entries from _index.yaml (entries without directories)
    stale_entries = LocationStorage.cleanup_stale_entries(world.name)
    if stale_entries:
        logger.info(f"Cleaned up {len(stale_entries)} stale entries from _index.yaml: {stale_entries}")

    # Sync database locations with filesystem (delete orphaned locations)
    from crud.locations import sync_locations_with_filesystem

    deleted_count = await sync_locations_with_filesystem(db, world.id, world.name)
    if deleted_count > 0:
        logger.info(f"Cleaned up {deleted_count} orphaned locations during reset")

    # Sync database agents with filesystem (delete stale agents whose config files were removed)
    stale_agents_count = await crud.sync_agents_with_filesystem(db, world.name)
    if stale_agents_count > 0:
        logger.info(f"Cleaned up {stale_agents_count} stale agents during reset")

    # Get all room mappings for this world
    room_mappings = RoomMappingService.get_all_room_mappings(world.name)

    # Create fresh rooms for each location (clears conversation context completely)
    for room_key, mapping in room_mappings.items():
        if room_key.startswith("location:"):
            old_room_id = mapping.db_room_id
            location_name = room_key.replace("location:", "")

            if old_room_id:
                # Cleanup client pool connections for the old room
                await agent_manager.client_pool.cleanup_room(old_room_id)

            # Get the location from database
            location = await crud.get_location_by_name(db, world.id, location_name)
            if location:
                # Create a fresh room for this location (new conversation context)
                from crud.locations import create_new_room_for_location

                new_room = await create_new_room_for_location(db, location)
                new_room_id = new_room.id

                # Update room mapping in _state.json with new room_id
                # Only keep system agent names (no characters)
                RoomMappingService.set_room_mapping(
                    world_name=world.name,
                    room_key=room_key,
                    db_room_id=new_room_id,
                    agents=[],  # Start fresh with no characters (gameplay agents are in DB room)
                )

                logger.info(f"Created fresh room for {room_key} (old={old_room_id}, new={new_room_id})")
            else:
                # Location doesn't exist in DB, just clear the mapping
                RoomMappingService.delete_room_mapping(world.name, room_key)
                logger.info(f"Removed stale room mapping {room_key}")

    # Get starting location from database, or create it from filesystem if not found
    starting_location = await crud.get_location_by_name(db, world.id, starting_location_name)
    if not starting_location:
        # Try to create the location from filesystem
        starting_location = await _create_location_from_filesystem(db, world.name, world.id, starting_location_name)
        if not starting_location:
            raise ValueError(f"Starting location '{starting_location_name}' not found in database or filesystem")
        logger.info(f"Created starting location '{starting_location_name}' from filesystem during reset")

    # Reset player state in database
    player_state = await crud.get_player_state(db, world.id)
    if player_state:
        player_state.turn_count = 0
        player_state.current_location_id = starting_location.id
        player_state.stats = json.dumps(initial_stats)
        player_state.inventory = json.dumps(initial_inventory)
        player_state.effects = "[]"
        player_state.action_history = "[]"
        player_state.is_chat_mode = False
        player_state.chat_mode_start_message_id = None
        async with serialized_write():
            await db.commit()
        logger.info("Reset player state in database")

    # Reset player.yaml in filesystem
    fs_player_state = FSPlayerState(
        current_location=starting_location_name,
        turn_count=0,
        stats=initial_stats,
        inventory=initial_inventory,
        effects=[],
        recent_actions=[],
        game_time=initial_game_time,
    )
    PlayerService.save_player_state(world.name, fs_player_state)
    logger.info(f"Reset player.yaml in filesystem (game_time: {initial_game_time['hour']}:00)")

    # Reset _state.json to only contain onboarding room and starting location
    state = RoomMappingService.load_state(world.name)
    starting_room_key = f"location:{starting_location_name}"

    # Keep only onboarding and starting location rooms
    preserved_rooms = {}
    if "onboarding" in state.rooms:
        preserved_rooms["onboarding"] = state.rooms["onboarding"]
    if starting_room_key in state.rooms:
        preserved_rooms[starting_room_key] = state.rooms[starting_room_key]

    state.rooms = preserved_rooms
    state.suggestions = []
    state.current_room = starting_room_key
    # Clear stale arrival context from previous travel
    if "arrival_context" in state.ui:
        del state.ui["arrival_context"]
    RoomMappingService.save_state(world.name, state)
    logger.info(f"Reset _state.json rooms to: {list(preserved_rooms.keys())}")

    # Reset is_discovered for all locations except starting location
    all_locations = await crud.get_locations(db, world.id)
    for loc in all_locations:
        if loc.id == starting_location.id:
            # Keep starting location discovered
            if not loc.is_discovered:
                loc.is_discovered = True
        else:
            # Reset other locations to undiscovered
            if loc.is_discovered:
                loc.is_discovered = False
    async with serialized_write():
        await db.commit()
    logger.info(f"Reset is_discovered for {len(all_locations)} locations (starting location: {starting_location.name})")

    # Clear events.md files in all locations
    world_path = WorldService.get_world_path(world.name)
    locations_path = world_path / "locations"
    if locations_path.exists():
        for loc_dir in locations_path.iterdir():
            if loc_dir.is_dir():
                events_file = loc_dir / "events.md"
                if events_file.exists():
                    # Reset to empty (will be regenerated)
                    with open(events_file, "w", encoding="utf-8") as f:
                        f.write("")
        logger.info("Cleared events.md files")

    # Reset history.md to initial state
    history_file = world_path / "history.md"
    if history_file.exists():
        with open(history_file, "w", encoding="utf-8") as f:
            f.write("# World History\n\n")
        logger.info("Reset history.md")

    # Clear recent_events.md for all agents in this world
    agents_path = world_path / "agents"
    if agents_path.exists():
        cleared_count = 0
        for agent_dir in agents_path.iterdir():
            if agent_dir.is_dir():
                recent_events_file = agent_dir / "recent_events.md"
                if recent_events_file.exists():
                    recent_events_file.unlink()
                    cleared_count += 1
        if cleared_count > 0:
            logger.info(f"Cleared {cleared_count} agent recent_events.md files")

    # Prepare arrival message
    location_display = starting_location.display_name or starting_location.name
    default_name = "여행자" if world.language == Language.KOREAN else "The traveler"
    user_name = world.user_name if world.user_name else default_name
    arrival_content = Localization.get_arrival_message(user_name, location_display, world.language)

    # Send arrival message to starting location
    if starting_location.room_id:
        arrival_msg = schemas.MessageCreate(
            content=arrival_content,
            role="user",
            participant_type="system",
            participant_name="System",
        )
        await crud.create_message(db, starting_location.room_id, arrival_msg, update_room_activity=True)
        logger.info("Sent arrival message for reset")

    logger.info(f"Successfully reset world '{world.name}'")
    return starting_location, arrival_content


@router.post("/{world_id}/enter")
async def enter_world(
    world_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
):
    """
    Enter an active world (triggered when user clicks 'Enter World').

    This endpoint:
    1. Syncs phase from filesystem (source of truth)
    2. Resets world to initial state (clears messages, resets player)
    3. Triggers Action Manager to generate initial scene
    """
    # Check ownership first
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not your world")

    # Apply pending phase change and sync FS→DB
    WorldService.apply_pending_phase(world.name)
    await _sync_world_from_fs(db, world)

    # Refresh and validate world is active
    world = await crud.get_world(db, world_id)
    if world.phase != WorldPhase.ACTIVE:
        raise HTTPException(status_code=400, detail="World is not ready yet (still in onboarding phase)")

    # Perform reset and trigger initial scene
    try:
        starting_location, arrival_content = await _perform_world_reset(db, world, agent_manager)

        # Trigger initial scene generation in background
        if starting_location.room_id:
            target_room_id = starting_location.room_id

            # Pre-connect Action Manager for faster first action
            async def pre_connect_am():
                async with async_session_maker() as session:
                    am_agent = await crud.get_agent_by_name(session, "Action_Manager")
                    if am_agent:
                        await agent_manager.pre_connect(
                            db=session,
                            room_id=target_room_id,
                            agent_id=am_agent.id,
                            agent_name="Action_Manager",
                            world_name=world.name,
                            world_id=world.id,
                            config_file=am_agent.config_file,
                            group_name=am_agent.group,
                        )

            background_tasks.add_task(pre_connect_am)

            async def trigger_initial_scene():
                async with async_session_maker() as session:
                    trpg_orchestrator = get_trpg_orchestrator()
                    task_world = await crud.get_world(session, world_id)
                    if task_world:
                        await trpg_orchestrator.handle_player_action(
                            db=session,
                            room_id=target_room_id,
                            action_text=arrival_content,
                            agent_manager=agent_manager,
                            world=task_world,
                        )

            background_tasks.add_task(trigger_initial_scene)
            logger.info("Enter: Triggered initial scene generation (with AM pre-connect)")

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to reset world during enter: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to enter world: {str(e)}")

    # Build response
    return {
        "world": _build_world_response(world),
        "arrival_message_sent": True,
    }


@router.post("/{world_id}/reset", response_model=schemas.WorldResetResponse)
async def reset_world(
    world_id: int,
    request: schemas.WorldResetRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
):
    """
    Reset a world to its initial state (right after onboarding).

    This endpoint:
    1. Validates the world is active and has saved initial state
    2. Clears all location room messages and agent sessions
    3. Resets player state to initial values
    4. Regenerates the initial scene

    Requires confirm=true to prevent accidental resets.
    """
    # Validate confirmation
    if not request.confirm:
        raise HTTPException(status_code=400, detail="Must set confirm=true to reset world")

    # Get and validate world
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not your world")
    if world.phase != WorldPhase.ACTIVE:
        raise HTTPException(status_code=400, detail="Can only reset active worlds")

    try:
        starting_location, arrival_content = await _perform_world_reset(db, world, agent_manager)

        # Trigger initial scene generation in background
        if starting_location.room_id:
            target_room_id = starting_location.room_id

            async def trigger_reset_scene():
                async with async_session_maker() as session:
                    trpg_orchestrator = get_trpg_orchestrator()
                    task_world = await crud.get_world(session, world_id)
                    if task_world:
                        await trpg_orchestrator.handle_player_action(
                            db=session,
                            room_id=target_room_id,
                            action_text=arrival_content,
                            agent_manager=agent_manager,
                            world=task_world,
                        )

            background_tasks.add_task(trigger_reset_scene)
            logger.info("Triggered initial scene generation for reset")

        location_display = starting_location.display_name or starting_location.name
        return schemas.WorldResetResponse(
            success=True,
            message=f"World '{world.name}' has been reset to its initial state",
            world_id=world_id,
            starting_location=location_display,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to reset world '{world.name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to reset world: {str(e)}")
