"""
World management routes for TRPG gameplay.

Handles world CRUD operations:
- Create, list, get, delete worlds
- Enter world (start gameplay)
- Reset world to initial state
- Import worlds from filesystem

Uses WorldFacade for FS↔DB sync operations.
"""

import logging

import crud
import models
import schemas
from database import async_session_maker, get_db
from dependencies import (
    RequestIdentity,
    get_agent_manager,
    get_request_identity,
)
from domain.services.localization import Localization
from domain.value_objects.enums import Language, MessageRole, WorldPhase
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from orchestration import get_trpg_orchestrator
from sdk import AgentManager
from services.facades import WorldFacade
from services.location_service import LocationService
from services.player_service import PlayerService
from services.world_reset_service import WorldResetService
from services.world_service import WorldService
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

logger = logging.getLogger("GameRouter.Worlds")

router = APIRouter()


# =============================================================================
# WORLD MANAGEMENT
# =============================================================================


@router.post("/", response_model=schemas.WorldSummary)
async def create_world(
    world: schemas.WorldCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
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
        LocationService.set_room_mapping(
            world_name=world.name,
            room_key="onboarding",
            db_room_id=db_world.onboarding_room_id,
            agents=["Onboarding_Manager"],
        )
        LocationService.set_current_room(world.name, "onboarding")
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
        saved_msg = await crud.create_message(
            db, db_world.onboarding_room_id, system_message, update_room_activity=True
        )

        # Trigger agent response in background using TRPGOrchestrator
        async def trigger_onboarding():
            async with async_session_maker() as session:
                trpg_orchestrator = get_trpg_orchestrator()
                # Re-fetch world in this session
                task_world = await crud.get_world(session, db_world.id)
                if task_world:
                    await trpg_orchestrator.handle_player_action(
                        db=session,
                        room_id=db_world.onboarding_room_id,
                        action_text=onboarding_content,
                        agent_manager=agent_manager,
                        world=task_world,
                    )

        background_tasks.add_task(trigger_onboarding)
        logger.info(f"Triggered onboarding for world '{world.name}'")

    logger.info(f"Created world '{world.name}' for user '{identity.user_id}'")
    return db_world


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
    facade = WorldFacade(db)
    fs_worlds = await facade.list_importable_worlds(identity.user_id)

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
        for w in fs_worlds
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
    facade = WorldFacade(db)
    try:
        db_world = await facade.import_world(world_name, identity.user_id)
        return db_world
    except ValueError as e:
        if "not found in filesystem" in str(e):
            raise HTTPException(status_code=404, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{world_id}", response_model=schemas.World)
async def get_world(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """Get world details including phase, lore, and stat definitions."""
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not your world")

    # Sync from filesystem (source of truth) via facade
    facade = WorldFacade(db)
    sync_result = await facade.sync_from_fs(world)
    if sync_result.synced:
        # Refresh world object after sync
        world = await crud.get_world(db, world_id)

    # Build full response with lore and stat definitions from FS
    return facade.build_world_response(world)


@router.delete("/{world_id}")
async def delete_world(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """Delete a world and all associated data (FS + DB)."""
    facade = WorldFacade(db)
    try:
        await facade.delete_world(world_id, identity.user_id, is_admin=(identity.role == "admin"))
        return {"status": "deleted"}
    except ValueError as e:
        if "not found" in str(e).lower():
            raise HTTPException(status_code=404, detail=str(e))
        if "not authorized" in str(e).lower():
            raise HTTPException(status_code=403, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))


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
    2. Syncs player state from filesystem if needed
    3. Sends arrival system message if not already sent
    4. Returns the world data with updated phase
    """
    # Check ownership first
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    if world.owner_id != identity.user_id and identity.role != "admin":
        raise HTTPException(status_code=403, detail="Not your world")

    # Use facade for sync operations
    facade = WorldFacade(db)
    try:
        entry_result = await facade.enter_world(world_id)
    except ValueError as e:
        if "not ready yet" in str(e).lower():
            raise HTTPException(status_code=400, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))

    # If arrival message was sent and we have a room, trigger initial scene
    if entry_result.arrival_message_sent and entry_result.room_id:
        target_room_id = entry_result.room_id
        # Get arrival content for the scene trigger
        player_state = await crud.get_player_state(db, world_id)
        if player_state and player_state.current_location_id:
            arrival_location = await crud.get_location(db, player_state.current_location_id)
            if arrival_location:
                location_name = arrival_location.display_name or arrival_location.name
                default_name = "여행자" if entry_result.world.language == Language.KOREAN else "The traveler"
                user_name = entry_result.world.user_name if entry_result.world.user_name else default_name
                arrival_content = Localization.get_arrival_message(
                    user_name, location_name, entry_result.world.language
                )

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
                logger.info("Enter: Triggered initial scene generation")

    # Build response
    world_schema = schemas.World.model_validate(entry_result.world)
    world_schema.lore = entry_result.lore
    world_schema.stat_definitions = schemas.StatDefinitions(
        stats=[schemas.StatDefinition(**s) for s in entry_result.stat_definitions.get("stats", [])]
    )

    return {
        "world": world_schema,
        "arrival_message_sent": entry_result.arrival_message_sent,
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

    # Load initial state from _initial.json
    initial_state = WorldResetService.load_initial_state(world.name)
    if not initial_state:
        raise HTTPException(
            status_code=400,
            detail="No initial state found for this world. Only worlds created after this feature can be reset.",
        )

    starting_location_name = initial_state["starting_location"]
    initial_stats = initial_state["initial_stats"]
    initial_inventory = initial_state["initial_inventory"]

    logger.info(f"Resetting world '{world.name}' to initial state")

    try:
        # Clean up stale entries from _index.yaml (entries without directories)
        stale_entries = LocationService.cleanup_stale_entries(world.name)
        if stale_entries:
            logger.info(f"Cleaned up {len(stale_entries)} stale entries from _index.yaml: {stale_entries}")

        # Sync database locations with filesystem (delete orphaned locations)
        from crud.locations import sync_locations_with_filesystem

        deleted_count = await sync_locations_with_filesystem(db, world_id, world.name)
        if deleted_count > 0:
            logger.info(f"Cleaned up {deleted_count} orphaned locations during reset")

        # Get all room mappings for this world
        room_mappings = LocationService.get_all_room_mappings(world.name)

        # Clear location room messages and agent sessions
        for room_key, mapping in room_mappings.items():
            if room_key.startswith("location:"):
                room_id = mapping.db_room_id
                if room_id:
                    # Clear messages in this room
                    await crud.delete_room_messages(db, room_id)

                    # Clear agent sessions (forces fresh Claude SDK sessions)
                    await db.execute(
                        models.RoomAgentSession.__table__.delete().where(models.RoomAgentSession.room_id == room_id)
                    )

                    # Cleanup client pool connections
                    agents = await crud.get_agents(db, room_id)
                    for agent in agents:
                        pool_key = f"{room_id}:{agent.id}"
                        await agent_manager.client_pool.cleanup(pool_key)

                    # Remove non-system characters from the room
                    # System agents (gameplay, onboarding) stay, but characters added during play are removed
                    system_groups = {"gameplay", "onboarding"}
                    characters_to_remove = [a for a in agents if a.group not in system_groups]
                    for character in characters_to_remove:
                        await crud.remove_agent_from_room(db, room_id, character.id)
                        logger.info(f"Removed character '{character.name}' from room {room_key}")

                    # Clear character agents from _state.json room mapping
                    # Keep only system agent names in the mapping
                    system_agent_names = [a.name for a in agents if a.group in system_groups]
                    state = LocationService.load_state(world.name)
                    if room_key in state.rooms:
                        state.rooms[room_key].agents = system_agent_names
                        LocationService.save_state(world.name, state)

                    logger.info(f"Cleared room {room_key} (id={room_id})")

        # Get starting location from database
        starting_location = await crud.get_location_by_name(db, world_id, starting_location_name)
        if not starting_location:
            raise HTTPException(
                status_code=500,
                detail=f"Starting location '{starting_location_name}' not found in database",
            )

        # Reset player state in database
        player_state = await crud.get_player_state(db, world_id)
        if player_state:
            import json

            player_state.turn_count = 0
            player_state.current_location_id = starting_location.id
            player_state.stats = json.dumps(initial_stats)
            player_state.inventory = json.dumps(initial_inventory)
            player_state.effects = "[]"
            player_state.action_history = "[]"
            player_state.is_chat_mode = False
            player_state.chat_mode_start_message_id = None
            await db.commit()
            logger.info("Reset player state in database")

        # Reset player.yaml in filesystem
        from domain.entities.world_models import PlayerState as FSPlayerState

        fs_player_state = FSPlayerState(
            current_location=starting_location_name,
            turn_count=0,
            stats=initial_stats,
            inventory=initial_inventory,
            effects=[],
            recent_actions=[],
        )
        PlayerService.save_player_state(world.name, fs_player_state)
        logger.info("Reset player.yaml in filesystem")

        # Reset _state.json to only contain onboarding room and starting location
        state = LocationService.load_state(world.name)
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
        LocationService.save_state(world.name, state)
        logger.info(f"Reset _state.json rooms to: {list(preserved_rooms.keys())}")

        # Reset is_discovered for all locations except starting location
        all_locations = await crud.get_locations(db, world_id)
        for loc in all_locations:
            if loc.id == starting_location.id:
                # Keep starting location discovered
                if not loc.is_discovered:
                    loc.is_discovered = True
            else:
                # Reset other locations to undiscovered
                if loc.is_discovered:
                    loc.is_discovered = False
        await db.commit()
        logger.info(
            f"Reset is_discovered for {len(all_locations)} locations (starting location: {starting_location.name})"
        )

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

        # Send arrival message to starting location
        if starting_location.room_id:
            location_display = starting_location.display_name or starting_location.name
            default_name = "여행자" if world.language == Language.KOREAN else "The traveler"
            user_name = world.user_name if world.user_name else default_name

            arrival_content = Localization.get_arrival_message(user_name, location_display, world.language)
            arrival_msg = schemas.MessageCreate(
                content=arrival_content,
                role="user",
                participant_type="system",
                participant_name="System",
            )
            await crud.create_message(db, starting_location.room_id, arrival_msg, update_room_activity=True)
            logger.info("Sent arrival message for reset")

            # Trigger initial scene generation in background
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

        logger.info(f"Successfully reset world '{world.name}'")

        return schemas.WorldResetResponse(
            success=True,
            message=f"World '{world.name}' has been reset to its initial state",
            world_id=world_id,
            starting_location=location_display,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset world '{world.name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to reset world: {str(e)}")
