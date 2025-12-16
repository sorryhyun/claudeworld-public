"""
Chat mode route handlers.

Handles /chat and /end commands for free-form NPC conversations.
"""

import asyncio
import logging
from typing import Optional

import crud
import models
import schemas
from domain.entities.agent import is_chat_summarizer
from domain.entities.agent_config import AgentConfigData
from domain.value_objects.contexts import AgentResponseContext
from domain.value_objects.enums import MessageRole
from domain.value_objects.task_identifier import TaskIdentifier
from orchestration import get_chat_mode_orchestrator
from sdk import AgentManager
from services.agent_config_service import AgentConfigService
from services.prompt_builder import build_system_prompt
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("ChatModeRoutes")


async def handle_chat_command(
    db: AsyncSession,
    world_id: int,
    player_state: models.PlayerState,
    room_id: int,
    _world: models.World,
) -> dict:
    """
    Enter chat mode.

    Args:
        db: Database session
        world_id: World ID
        player_state: Current player state
        room_id: Target room ID
        world: World model

    Returns:
        Response dict with status
    """
    if player_state.is_chat_mode:
        return {
            "status": "already_in_chat_mode",
            "message": "You are already in chat mode. Type /end to return to gameplay.",
        }

    # Get latest message ID as start marker
    messages = await crud.get_recent_messages(db, room_id, limit=1)
    start_message_id = messages[-1].id if messages else 0

    # Enter chat mode (returns chat_session_id)
    chat_session_id = await crud.enter_chat_mode(db, world_id, start_message_id)
    if chat_session_id is None:
        return {
            "status": "error",
            "message": "Failed to enter chat mode.",
        }

    # Send system message (this message is hidden from polling, but stored for context)
    # System messages in chat mode also get the chat_session_id
    await crud.create_message(
        db,
        room_id,
        schemas.MessageCreate(
            content="[Chat mode started. You can now freely converse with NPCs. Type /end to return to gameplay.]",
            role=MessageRole.USER,
            participant_type="system",
            participant_name="System",
            chat_session_id=chat_session_id,
        ),
        update_room_activity=True,
    )

    logger.info(
        f"Entered chat mode for world {world_id}, start_message_id={start_message_id}, chat_session_id={chat_session_id}"
    )

    return {
        "status": "chat_mode_started",
        "message": "Chat mode started. You can now freely converse with NPCs. Type /end to return to gameplay.",
    }


async def handle_chat_mode_action(
    db: AsyncSession,
    world_id: int,
    player_state: models.PlayerState,
    room_id: int,
    text: str,
    agent_manager: AgentManager,
    world: models.World,
    location_id: int,
) -> dict:
    """
    Handle player message in chat mode.

    Triggers NPC responses without Action Manager or Narrator.

    Args:
        db: Database session
        world_id: World ID
        player_state: Current player state
        room_id: Target room ID
        text: Player's message text
        agent_manager: AgentManager instance
        world: World model
        location_id: Current location ID

    Returns:
        Response dict with status
    """
    # Get the current chat session ID from player state
    chat_session_id = player_state.chat_session_id

    # Save user message to room with chat_session_id
    message = schemas.MessageCreate(
        content=text,
        role=MessageRole.USER,
        participant_type="user",
        chat_session_id=chat_session_id,
    )
    await crud.create_message(db, room_id, message, update_room_activity=True)

    # Trigger chat mode NPC responses in background
    async def trigger_chat_responses():
        """Background task to trigger chat mode NPC responses."""
        from database import get_db as get_db_generator

        async for task_db in get_db_generator():
            try:
                chat_orchestrator = get_chat_mode_orchestrator()
                await chat_orchestrator.handle_chat_message(
                    db=task_db,
                    room_id=room_id,
                    message_text=text,
                    agent_manager=agent_manager,
                    world_id=world_id,
                    world_name=world.name,
                    location_id=location_id,
                    chat_session_id=chat_session_id,
                )
            except Exception as e:
                logger.error(f"Error triggering chat mode responses: {e}")
                import traceback

                traceback.print_exc()
            finally:
                break  # Only use first session

    asyncio.create_task(trigger_chat_responses())
    logger.info(f"Chat mode message submitted for world {world_id}: {text[:50]}...")

    return {
        "status": "processing",
        "message": "Message received, NPCs are responding...",
    }


async def handle_end_command(
    db: AsyncSession,
    world_id: int,
    player_state: models.PlayerState,
    room_id: int,
    agent_manager: AgentManager,
    world: models.World,
) -> dict:
    """
    Exit chat mode and summarize the conversation.

    Args:
        db: Database session
        world_id: World ID
        player_state: Current player state
        room_id: Target room ID
        agent_manager: AgentManager instance
        world: World model

    Returns:
        Response dict with status
    """
    if not player_state.is_chat_mode:
        return {
            "status": "not_in_chat_mode",
            "message": "You are not in chat mode.",
        }

    # Exit chat mode and get start message ID and chat session ID
    exit_result = await crud.exit_chat_mode(db, world_id)
    if exit_result is None:
        return {
            "status": "error",
            "message": "Failed to exit chat mode.",
        }

    _start_message_id, chat_session_id = exit_result

    # Send system message for end of chat mode (no chat_session_id since we're ending)
    await crud.create_message(
        db,
        room_id,
        schemas.MessageCreate(
            content="[Chat mode ended. Returning to gameplay...]",
            role=MessageRole.USER,
            participant_type="system",
            participant_name="System",
        ),
        update_room_activity=True,
    )

    # Background task: summarize the conversation and continue gameplay
    asyncio.create_task(
        _summarize_and_continue(
            world_id=world_id,
            _world_name=world.name,
            room_id=room_id,
            chat_session_id=chat_session_id,
            agent_manager=agent_manager,
            user_name=world.user_name or "The player",
            world_genre=world.genre,
        )
    )

    logger.info(f"Exited chat mode for world {world_id}, summarizing conversation...")

    return {
        "status": "processing",
        "message": "Returning to gameplay...",
    }


async def _get_chat_summarizer_agent(db: AsyncSession) -> Optional[models.Agent]:
    """
    Get the Chat_Summarizer agent from the database.

    Returns:
        Agent model or None if not found
    """
    # Find Chat_Summarizer in gameplay agents
    from sqlalchemy import select

    result = await db.execute(select(models.Agent).where(models.Agent.group == "gameplay"))
    agents = result.scalars().all()

    for agent in agents:
        if is_chat_summarizer(agent.name):
            return agent

    logger.warning("Chat_Summarizer agent not found in database")
    return None


async def _generate_ai_summary(
    db: AsyncSession,
    agent_manager: AgentManager,
    room_id: int,
    conversation_text: str,
    participants: set[str],
) -> Optional[str]:
    """
    Generate an AI summary of the conversation using the Chat_Summarizer agent.

    Args:
        db: Database session
        agent_manager: AgentManager instance
        room_id: Room ID for task tracking
        conversation_text: Formatted conversation transcript
        participants: Set of NPC names who participated

    Returns:
        AI-generated summary text, or None if summarizer unavailable
    """
    # Get the Chat_Summarizer agent
    summarizer = await _get_chat_summarizer_agent(db)
    if not summarizer:
        return None

    try:
        # Load agent config from filesystem
        config_data = AgentConfigData()
        if summarizer.config_file:
            loaded_config = AgentConfigService.load_agent_config(summarizer.config_file)
            if loaded_config:
                config_data = loaded_config

        # Build system prompt
        system_prompt = build_system_prompt(summarizer.name, config_data)

        # Build the user message with conversation context
        participant_list = ", ".join(participants) if participants else "NPCs"
        user_message = f"""Please summarize the following conversation between the player and {participant_list}.

## Conversation Transcript
{conversation_text}

## Instructions
Create a concise 2-4 sentence summary focusing on:
- Key topics discussed
- Important information exchanged
- Any agreements or outcomes
- Relationship changes (if any)

Write in past tense, third person (e.g., "The player discussed...", "They agreed...")."""

        # Build AgentResponseContext
        task_id = TaskIdentifier(room_id=room_id, agent_id=summarizer.id)
        context = AgentResponseContext(
            system_prompt=system_prompt,
            user_message=user_message,
            agent_name=summarizer.name,
            config=config_data,
            room_id=room_id,
            agent_id=summarizer.id,
            group_name=summarizer.group,
            task_id=task_id,
        )

        # Generate summary via AgentManager
        response_text = ""
        async for event in agent_manager.generate_sdk_response(context):
            if event.get("type") == "content_delta":
                response_text += event.get("delta", "")
            elif event.get("type") == "stream_end":
                # Use final response_text from stream_end if available
                if event.get("response_text"):
                    response_text = event["response_text"]

        logger.info(f"Chat_Summarizer generated summary: {response_text[:100]}...")
        return response_text.strip() if response_text else None

    except Exception as e:
        logger.error(f"Error generating AI summary: {e}")
        import traceback

        traceback.print_exc()
        return None


async def _summarize_and_continue(
    world_id: int,
    _world_name: str,
    room_id: int,
    chat_session_id: int,
    agent_manager: AgentManager,
    user_name: str,
    world_genre: Optional[str],
) -> None:
    """
    Background task to summarize chat mode conversation and continue gameplay.

    1. Get messages from chat mode session
    2. Generate AI summary using Chat_Summarizer agent
    3. Pass summary to Action Manager -> Narrator via TRPG orchestrator
    """
    from database import get_db as get_db_generator
    from orchestration import get_trpg_orchestrator

    trpg_orchestrator = get_trpg_orchestrator()

    async for db in get_db_generator():
        try:
            # Mark as processing for "clauding" display
            trpg_orchestrator.set_sub_agent_active(room_id, "Chat_Summarizer", "Summarizing conversation...")

            # Ensure gameplay agents are in the location room
            # (they might be missing if location was created before agents were seeded)
            from crud.worlds import add_gameplay_agents_to_room

            await add_gameplay_agents_to_room(db, room_id)

            # Get messages from the chat session
            messages = await crud.get_chat_session_messages(db, room_id, chat_session_id, limit=100)

            if not messages:
                logger.info(f"No messages to summarize for world {world_id}")
                return

            # Format messages as a conversation transcript
            conversation_messages = []
            participants: set[str] = set()
            for m in messages:
                if m.participant_type == "system":
                    continue  # Skip system messages
                if m.role == MessageRole.USER:
                    name = m.participant_name or user_name
                    conversation_messages.append(f"{name}: {m.content}")
                else:
                    name = m.agent.name if m.agent else "Unknown"
                    conversation_messages.append(f"{name}: {m.content}")
                    if m.agent and m.agent.name:
                        participants.add(m.agent.name)

            if not conversation_messages:
                logger.info(f"No conversation content to summarize for world {world_id}")
                return

            # Format conversation for summarizer
            conversation_text = "\n".join(conversation_messages)

            # Generate AI summary using Chat_Summarizer agent
            ai_summary = await _generate_ai_summary(
                db=db,
                agent_manager=agent_manager,
                room_id=room_id,
                conversation_text=conversation_text,
                participants=participants,
            )

            # Fall back to simple summary if AI summarizer unavailable
            if ai_summary:
                summary_text = ai_summary
            else:
                # Fallback: use last few exchanges
                participant_list = ", ".join(participants) if participants else "NPCs"
                recent_exchanges = conversation_messages[-6:]
                summary_text = f"[End of conversation with {participant_list}]\nRecent exchanges:\n" + "\n".join(
                    recent_exchanges
                )

            logger.info(f"Chat mode ended, passing to gameplay: {summary_text[:100]}...")

            # Clear sub-agent status before continuing to gameplay agents
            trpg_orchestrator.set_sub_agent_inactive(room_id)

            # Now trigger TRPG flow with the summary as the action
            # The Action Manager will interpret the summary and Narrator will describe
            # Re-fetch world in this session
            task_world = await crud.get_world(db, world_id)
            if task_world:
                # Create a synthetic action that summarizes what happened
                summary_action = f"[Conversation Summary] {summary_text}"

                await trpg_orchestrator.handle_player_action(
                    db=db,
                    room_id=room_id,
                    action_text=summary_action,
                    agent_manager=agent_manager,
                    world=task_world,
                )

        except Exception as e:
            logger.error(f"Error in summarize_and_continue: {e}")
            import traceback

            traceback.print_exc()
        finally:
            # Ensure sub-agent status is cleared even on error
            trpg_orchestrator.set_sub_agent_inactive(room_id)
            break  # Only use first session
