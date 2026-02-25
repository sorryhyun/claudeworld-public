"""
Polling routes.

Endpoint for polling game updates (messages, state changes).
"""

import json
import logging
from typing import Optional

import crud
import schemas
from core.dependencies import (
    RequestIdentity,
    get_agent_manager,
    get_request_identity,
)
from domain.entities.agent import is_action_manager
from domain.services.access_control import AccessControl
from domain.services.localization import Localization
from domain.value_objects.enums import Language, MessageRole, WorldPhase
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from infrastructure.database.connection import async_session_maker, get_db
from orchestration import get_trpg_orchestrator
from sdk import AgentManager
from services.persistence_manager import PersistenceManager
from services.player_service import PlayerService
from services.transient_state_service import TransientStateService
from services.world_service import WorldService
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("GameRouter.Polling")

router = APIRouter()


@router.get("/{world_id}/poll")
async def poll_updates(
    world_id: int,
    background_tasks: BackgroundTasks,
    since_message_id: Optional[int] = None,
    poll_onboarding: bool = False,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
):
    """
    Poll for updates (new messages, state changes).

    This is the main polling endpoint for the frontend.
    Returns new messages since the given ID and current game state.

    Args:
        poll_onboarding: If True, always poll from onboarding room (used when
                         user is still on onboarding page after phase changes to active)

    The filesystem is the source of truth for world phase.
    If the filesystem phase differs from the database, we sync it.
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    # Check filesystem config (source of truth) and sync if needed
    fs_config = WorldService.load_world_config(world.name)
    current_phase = world.phase
    if fs_config:
        # Check which fields need syncing
        updates = {}
        if fs_config.phase != world.phase:
            logger.info(f"Phase mismatch for world {world.name}: DB={world.phase}, FS={fs_config.phase}. Syncing.")
            updates["phase"] = fs_config.phase
            current_phase = fs_config.phase
        if fs_config.user_name and fs_config.user_name != world.user_name:
            logger.info(
                f"user_name mismatch for world {world.name}: DB={world.user_name}, FS={fs_config.user_name}. Syncing."
            )
            updates["user_name"] = fs_config.user_name
        if fs_config.genre and fs_config.genre != world.genre:
            logger.info(f"genre mismatch for world {world.name}: DB={world.genre}, FS={fs_config.genre}. Syncing.")
            updates["genre"] = fs_config.genre
        if fs_config.theme and fs_config.theme != world.theme:
            logger.info(f"theme mismatch for world {world.name}: DB={world.theme}, FS={fs_config.theme}. Syncing.")
            updates["theme"] = fs_config.theme

        # Apply updates if any
        if updates:
            await crud.update_world(db, world_id, schemas.WorldUpdate(**updates))
            # Refresh world object to get updated values
            world = await crud.get_world(db, world_id)

    player_state = await crud.get_player_state(db, world_id)

    # Determine which room to poll based on phase and poll_onboarding flag
    target_room_id = None
    location = None

    # If poll_onboarding is True OR phase is onboarding, use onboarding room
    # This allows the frontend to stay on onboarding page after phase changes
    if (poll_onboarding or current_phase == WorldPhase.ONBOARDING) and world.onboarding_room_id:
        # Poll from the onboarding room
        target_room_id = world.onboarding_room_id
    elif current_phase == WorldPhase.ACTIVE and not poll_onboarding:
        # Check if we need to sync from filesystem (e.g., after onboarding completed via MCP tools)
        if player_state and not player_state.current_location_id:
            # Database doesn't have current location - try to sync from filesystem
            fs_state = PlayerService.load_player_state(world.name)
            if fs_state and fs_state.current_location:
                logger.info(f"Syncing player state from filesystem for world '{world.name}'")
                pm = PersistenceManager(db, world_id, world.name)
                await pm.sync_player_state_from_filesystem()
                # Refresh player_state after sync
                player_state = await crud.get_player_state(db, world_id)

                # Send arrival message to the starting location's room
                if player_state and player_state.current_location_id:
                    arrival_location = await crud.get_location(db, player_state.current_location_id)
                    if arrival_location and arrival_location.room_id:
                        # Get user_name and language from world
                        location_name = arrival_location.display_name or arrival_location.name
                        # Use Korean default if world language is Korean
                        default_name = "여행자" if world.language == Language.KOREAN else "The traveler"
                        user_name = world.user_name if world.user_name else default_name

                        arrival_message = schemas.MessageCreate(
                            content=Localization.get_arrival_message(user_name, location_name, world.language),
                            role=MessageRole.USER,
                            participant_type="system",
                            participant_name="System",
                        )
                        await crud.create_message(
                            db, arrival_location.room_id, arrival_message, update_room_activity=True
                        )
                        logger.info(f"Sent arrival message for '{user_name}' at '{location_name}'")

                        # Trigger initial scene generation in background
                        target_room_for_scene = arrival_location.room_id
                        arrival_content = Localization.get_arrival_message(user_name, location_name, world.language)

                        async def trigger_initial_scene():
                            async with async_session_maker() as session:
                                trpg_orchestrator = get_trpg_orchestrator()
                                task_world = await crud.get_world(session, world_id)
                                if task_world:
                                    await trpg_orchestrator.handle_player_action(
                                        db=session,
                                        room_id=target_room_for_scene,
                                        action_text=arrival_content,
                                        agent_manager=agent_manager,
                                        world=task_world,
                                    )

                        background_tasks.add_task(trigger_initial_scene)
                        logger.info("Polling: Triggered initial scene generation after phase transition")

        # Now try to get the current location's room
        if player_state and player_state.current_location_id:
            location = await crud.get_location(db, player_state.current_location_id)
            if location and location.room_id:
                target_room_id = location.room_id

    if not target_room_id:
        return {"messages": [], "state": None}

    # Check if player is in chat mode
    is_chat_mode = player_state.is_chat_mode if player_state else False

    # Get new messages (use get_messages_since for efficiency if we have since_message_id)
    # In game mode (not chat mode), exclude chat session messages to show only game conversations
    if since_message_id:
        messages = await crud.get_messages_since(db, target_room_id, since_id=since_message_id, limit=50)
        # Filter out chat mode messages if not in chat mode
        if not is_chat_mode and not poll_onboarding:
            messages = [m for m in messages if m.chat_session_id is None]
    else:
        if is_chat_mode or poll_onboarding:
            messages = await crud.get_messages(db, target_room_id)
        else:
            # In game mode, exclude chat session messages
            messages = await crud.get_messages_excluding_chat(db, target_room_id)

    # Filter out system messages (e.g., "Start onboarding..." trigger messages)
    visible_messages = [m for m in messages if m.participant_type != "system"]

    # Load game_time from filesystem (source of truth)
    fs_state = PlayerService.load_player_state(world.name)
    game_time = None
    if fs_state and fs_state.game_time:
        game_time = {
            "hour": fs_state.game_time.get("hour", 8),
            "minute": fs_state.game_time.get("minute", 0),
            "day": fs_state.game_time.get("day", 1),
        }

    # Build response
    response = {
        "messages": [
            {
                "id": m.id,
                "content": m.content,
                "role": m.role,
                "agent_id": m.agent_id,
                "agent_name": m.agent.name if m.agent else None,
                "agent_profile_pic": m.agent.profile_pic if m.agent else None,
                "thinking": m.thinking,
                "timestamp": m.timestamp.isoformat() if m.timestamp else None,
                "image_data": m.image_data,
                "image_media_type": m.image_media_type,
                "game_time_snapshot": json.loads(m.game_time_snapshot) if m.game_time_snapshot else None,
            }
            for m in visible_messages
        ],
        "state": {
            "stats": json.loads(player_state.stats) if player_state and player_state.stats else {},
            "inventory_count": len(json.loads(player_state.inventory))
            if player_state and player_state.inventory
            else 0,
            "turn_count": player_state.turn_count if player_state else 0,
            "phase": current_phase,  # Use synced phase from filesystem
            "pending_phase": fs_config.pending_phase if fs_config else None,  # For "Enter World" button
            "is_chat_mode": player_state.is_chat_mode if player_state else False,  # Chat mode state
            # Resume message ID: when exiting chat mode, frontend should use this as lastMessageId
            # to avoid re-fetching old narration from before chat mode
            "chat_mode_start_message_id": player_state.chat_mode_start_message_id if player_state else None,
            "game_time": game_time,  # In-game time from filesystem
        },
    }

    # Add location info if we have one (not during onboarding)
    if location:
        response["location"] = {
            "id": location.id,
            "name": location.display_name or location.name,
        }

    # Always include suggestions in poll response to avoid race conditions
    # (suggestions may be saved after narration message but before next poll)
    response["suggestions"] = TransientStateService.load_suggestions(world.name)

    return response


@router.get("/{world_id}/chatting-agents")
async def get_chatting_agents(
    world_id: int,
    poll_onboarding: bool = False,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
    agent_manager: AgentManager = Depends(get_agent_manager),
):
    """
    Get list of agents currently generating responses in a world.
    Used by frontend to display thinking/chatting indicators.

    Args:
        poll_onboarding: If True, check onboarding room instead of location room
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    # Determine which room to check based on phase and poll_onboarding flag
    target_room_id = None
    if (poll_onboarding or world.phase == WorldPhase.ONBOARDING) and world.onboarding_room_id:
        target_room_id = world.onboarding_room_id
    elif not poll_onboarding:
        player_state = await crud.get_player_state(db, world_id)
        if player_state and player_state.current_location_id:
            location = await crud.get_location(db, player_state.current_location_id)
            if location and location.room_id:
                target_room_id = location.room_id

    if not target_room_id:
        return {"chatting_agents": []}

    # Get TRPG orchestrator to check chatting agents
    trpg_orchestrator = get_trpg_orchestrator()
    chatting_agent_ids = trpg_orchestrator.get_chatting_agents(target_room_id, agent_manager)

    # Get current streaming state
    streaming_state = await agent_manager.get_streaming_state_for_room(target_room_id)

    # Get agent details (filter out hidden agents like Action Manager)
    chatting_agents = []
    if chatting_agent_ids:
        all_agents = await crud.get_agents_cached(db, target_room_id)
        agent_map = {agent.id: agent for agent in all_agents}

        for agent_id in chatting_agent_ids:
            if agent_id in agent_map:
                agent = agent_map[agent_id]
                agent_state = streaming_state.get(agent_id, {})
                # Send actual agent name (frontend handles display logic)
                agent_info = {
                    "id": agent.id,
                    "name": agent.name,
                    "profile_pic": agent.profile_pic if not is_action_manager(agent.name) else None,
                    "thinking_text": agent_state.get("thinking_text", ""),
                    "response_text": agent_state.get("response_text", ""),
                }
                # For Action_Manager, include has_narrated flag so frontend can unblock input
                if is_action_manager(agent.name):
                    agent_info["has_narrated"] = trpg_orchestrator.has_narration_produced(target_room_id)
                chatting_agents.append(agent_info)

    # Check if World Seed Generator is active (during onboarding complete tool)
    seed_status = trpg_orchestrator.get_seed_generation_status(target_room_id)
    if seed_status:
        chatting_agents.append(
            {
                "id": -1,  # Virtual ID for World Seed Generator
                "name": seed_status.get("name", "World Seed Generator"),
                "profile_pic": None,
                "thinking_text": seed_status.get("thinking_text", "Creating your world..."),
                "response_text": seed_status.get("response_text", ""),
            }
        )

    # Check if a sub-agent (Summarizer, etc.) is active
    sub_agent_status = trpg_orchestrator.get_sub_agent_status(target_room_id)
    if sub_agent_status:
        chatting_agents.append(
            {
                "id": -2,  # Virtual ID for sub-agents
                "name": sub_agent_status.get("name", "Processing"),
                "profile_pic": None,
                "thinking_text": sub_agent_status.get("thinking_text", "Processing..."),
                "response_text": sub_agent_status.get("response_text", ""),
            }
        )

    return {"chatting_agents": chatting_agents}
