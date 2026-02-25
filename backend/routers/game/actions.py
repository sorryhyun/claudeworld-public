"""
Player action routes.

Endpoints for submitting player actions and getting action suggestions.
"""

import asyncio
import logging

import crud
import schemas
from core.dependencies import (
    RequestIdentity,
    get_agent_manager,
    get_request_identity,
)
from domain.services.access_control import AccessControl
from domain.value_objects.enums import MessageRole, WorldPhase
from domain.value_objects.slash_commands import SlashCommandType, parse_slash_command
from fastapi import APIRouter, Depends, HTTPException
from infrastructure.database.connection import get_db
from orchestration.trpg_orchestrator import get_trpg_orchestrator
from sdk import AgentManager
from services.player_service import PlayerService
from services.room_mapping_service import RoomMappingService
from sqlalchemy.ext.asyncio import AsyncSession
from utils.images import compress_image_base64

from routers.game.chat_mode import (
    handle_chat_command,
    handle_chat_mode_action,
    handle_end_command,
)

logger = logging.getLogger("GameRouter.Actions")

router = APIRouter()


@router.post("/{world_id}/action")
async def submit_action(
    world_id: int,
    action: schemas.PlayerAction,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
):
    """
    Submit a player action.

    Supports slash commands:
    - /chat: Enter free-form conversation with NPCs
    - /end: Exit chat mode and return to gameplay

    For regular actions, triggers the TRPG turn sequence where Action Manager
    coordinates everything: interprets the action, invokes sub-agents via Task tool
    (Character Designer, Stat Calculator, Location Designer), and creates narration.

    The response is sent asynchronously via polling.
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    # Get player state
    player_state = await crud.get_player_state(db, world_id)
    if not player_state:
        raise HTTPException(status_code=404, detail="Player state not found")

    # Update last played timestamp
    await crud.update_world_last_played(db, world_id)

    # Determine which room to use based on phase
    target_room_id = None
    current_location_id = None

    if world.phase == WorldPhase.ONBOARDING and world.onboarding_room_id:
        # During onboarding, use the onboarding room
        target_room_id = world.onboarding_room_id
    elif player_state.current_location_id:
        # During active gameplay, use the current location's room
        location = await crud.get_location(db, player_state.current_location_id)
        if location and location.room_id:
            target_room_id = location.room_id
            current_location_id = location.id

    if not target_room_id:
        raise HTTPException(status_code=400, detail="No target room available")

    # Parse for slash commands
    parsed = parse_slash_command(action.text)

    # Handle /chat command
    if parsed.command_type == SlashCommandType.CHAT:
        # Only allow in active gameplay phase
        if world.phase != WorldPhase.ACTIVE:
            return {
                "status": "error",
                "message": "Chat mode is only available during active gameplay.",
            }
        return await handle_chat_command(db, world_id, player_state, target_room_id, world, agent_manager)

    # Handle /end command
    if parsed.command_type == SlashCommandType.END:
        return await handle_end_command(db, world_id, player_state, target_room_id, agent_manager, world)

    # Check if in chat mode - use chat mode handler
    if player_state.is_chat_mode:
        if not current_location_id:
            return {
                "status": "error",
                "message": "Cannot process chat mode message without a current location.",
            }
        return await handle_chat_mode_action(
            db,
            world_id,
            player_state,
            target_room_id,
            action.text,
            agent_manager,
            world,
            current_location_id,
            image_data=action.image_data,
            image_media_type=action.image_media_type,
        )

    # Regular TRPG flow below

    # Add action to history
    await crud.add_action_to_history(
        db,
        world_id,
        player_state.turn_count + 1,
        action.text,
        "Processing...",
    )

    # Increment turn counter
    new_turn = await crud.increment_turn(db, world_id)

    # Compress image if present
    image_data = action.image_data
    image_media_type = action.image_media_type
    if image_data and image_media_type:
        try:
            logger.info(f"Compressing image for world {world_id}")
            compressed_data, compressed_media_type = compress_image_base64(image_data, image_media_type)
            original_size = len(image_data)
            compressed_size = len(compressed_data)
            compression_ratio = (1 - compressed_size / original_size) * 100 if original_size > 0 else 0
            logger.info(
                f"Image compressed: {original_size} -> {compressed_size} bytes ({compression_ratio:.1f}% reduction)"
            )
            image_data = compressed_data
            image_media_type = compressed_media_type
        except Exception as e:
            logger.warning(f"Image compression failed, using original: {e}")

    # Get game time snapshot for active phase (None for onboarding)
    game_time_snapshot = None
    if world.phase == WorldPhase.ACTIVE:
        fs_player_state = PlayerService.load_player_state(world.name)
        if fs_player_state and fs_player_state.game_time:
            game_time_snapshot = fs_player_state.game_time

    # Save user message to the appropriate room
    message = schemas.MessageCreate(
        content=action.text,
        role=MessageRole.USER,
        participant_type="user",
        image_data=image_data,
        image_media_type=image_media_type,
        game_time_snapshot=game_time_snapshot,
    )
    saved_message = await crud.create_message(db, target_room_id, message, update_room_activity=True)

    # Trigger TRPG agent responses in background
    async def trigger_trpg_responses():
        """Background task to trigger TRPG agent responses with its own DB session."""
        from infrastructure.database.connection import get_db as get_db_generator

        async for task_db in get_db_generator():
            try:
                # Ensure gameplay agents are in the location room
                # (they might be missing if location was created before agents were seeded)
                from crud.worlds import add_gameplay_agents_to_room

                await add_gameplay_agents_to_room(task_db, target_room_id)

                trpg_orchestrator = get_trpg_orchestrator()
                # Re-fetch world in this session
                task_world = await crud.get_world(task_db, world_id)
                if task_world:
                    await trpg_orchestrator.handle_player_action(
                        db=task_db,
                        room_id=target_room_id,
                        action_text=action.text,
                        agent_manager=agent_manager,
                        world=task_world,
                    )
            except Exception as e:
                logger.error(f"Error triggering TRPG responses: {e}")
                import traceback

                traceback.print_exc()
            finally:
                break  # Only use first session

    asyncio.create_task(trigger_trpg_responses())
    logger.info(f"Action submitted for world {world_id}: {action.text[:50]}...")

    return {
        "status": "processing",
        "message": "Action received, processing turn...",
        "turn": new_turn,
    }


@router.get("/{world_id}/action/suggestions")
async def get_action_suggestions(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Get the most recent action suggestions from the Narrator.

    Returns the suggested actions from _state.json.
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    # Load suggestions directly from _state.json
    suggestions = RoomMappingService.load_suggestions(world.name)
    return {"suggestions": suggestions}
