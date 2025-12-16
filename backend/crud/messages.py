"""
CRUD operations for Message entities.
"""

import json
from datetime import datetime, timezone
from typing import List

import models
import schemas
from database import retry_on_db_lock, serialized_write
from domain.value_objects.enums import MessageRole, ParticipantType
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload


@retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2)
async def create_message(
    db: AsyncSession, room_id: int, message: schemas.MessageCreate, update_room_activity: bool = True
) -> models.Message:
    """
    Create a new message in the database.

    Args:
        db: Database session
        room_id: Room ID
        message: Message to create
        update_room_activity: Whether to update room's last_activity_at (default: True)

    Returns:
        Created message
    """
    # Serialize anthropic_calls to JSON if present
    anthropic_calls_json = None
    if message.anthropic_calls:
        anthropic_calls_json = json.dumps(message.anthropic_calls)

    db_message = models.Message(
        room_id=room_id,
        agent_id=message.agent_id,
        content=message.content,
        role=message.role,
        participant_type=message.participant_type,
        participant_name=message.participant_name,
        thinking=message.thinking,
        anthropic_calls=anthropic_calls_json,
        image_data=message.image_data,
        image_media_type=message.image_media_type,
        chat_session_id=message.chat_session_id,
    )
    db.add(db_message)

    # Update room's last_activity_at if requested (atomic with message creation)
    if update_room_activity:
        room = await db.get(models.Room, room_id)
        if room:
            room.last_activity_at = datetime.now(timezone.utc)

    async with serialized_write():
        await db.commit()
    await db.refresh(db_message)

    # Invalidate message cache for this room
    from infrastructure.cache import get_cache, room_messages_key

    cache = get_cache()
    # Invalidate all message-related cache entries for this room
    cache.invalidate_pattern(room_messages_key(room_id))

    return db_message


@retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2)
async def create_system_message(
    db: AsyncSession, room_id: int, content: str, update_room_activity: bool = False
) -> models.Message:
    """
    Create a system message (e.g., "invited [agent_name]").

    Args:
        db: Database session
        room_id: Room ID
        content: Message content
        update_room_activity: Whether to update room's last_activity_at (default: False for system messages)

    Returns:
        Created system message
    """
    db_message = models.Message(
        room_id=room_id,
        agent_id=None,
        content=content,
        role=MessageRole.ASSISTANT,
        participant_type=ParticipantType.SYSTEM,
        participant_name=None,
        thinking=None,
    )
    db.add(db_message)

    # Update room's last_activity_at if requested
    if update_room_activity:
        room = await db.get(models.Room, room_id)
        if room:
            room.last_activity_at = datetime.now(timezone.utc)

    async with serialized_write():
        await db.commit()
    await db.refresh(db_message)

    # Invalidate message cache for this room
    from infrastructure.cache import get_cache, room_messages_key

    cache = get_cache()
    cache.invalidate_pattern(room_messages_key(room_id))

    return db_message


async def get_messages(db: AsyncSession, room_id: int) -> List[models.Message]:
    """Get all messages in a room."""
    result = await db.execute(
        select(models.Message)
        .options(selectinload(models.Message.agent))
        .where(models.Message.room_id == room_id)
        .order_by(models.Message.timestamp)
    )
    return result.scalars().all()


async def get_messages_since(
    db: AsyncSession, room_id: int, since_id: int = None, limit: int = 100
) -> List[models.Message]:
    """
    Get messages in a room since a specific message ID.
    Used for polling to fetch only new messages.

    Args:
        db: Database session
        room_id: Room ID
        since_id: Only return messages with ID greater than this (optional)
        limit: Maximum number of messages to return (default: 100, max: 1000)

    Returns:
        List of messages ordered by timestamp (limited to prevent memory issues)
    """
    # Cap limit at 1000 to prevent excessive memory usage
    limit = min(limit, 1000)

    query = select(models.Message).options(selectinload(models.Message.agent)).where(models.Message.room_id == room_id)

    if since_id is not None:
        query = query.where(models.Message.id > since_id)

    query = query.order_by(models.Message.timestamp).limit(limit)

    result = await db.execute(query)
    return result.scalars().all()


async def get_recent_messages(db: AsyncSession, room_id: int, limit: int = 200) -> List[models.Message]:
    """
    Get the most recent messages in a room ordered by timestamp ascending.

    Args:
        db: Database session
        room_id: Room ID
        limit: Maximum number of messages to return (default: 200)

    Returns:
        List of recent messages ordered by timestamp
    """
    query = (
        select(models.Message)
        .options(selectinload(models.Message.agent))
        .where(models.Message.room_id == room_id)
        .order_by(models.Message.timestamp.desc())
        .limit(limit)
    )

    result = await db.execute(query)
    # Reverse to preserve chronological order for context building
    return list(reversed(result.scalars().all()))


async def get_messages_after_agent_response(
    db: AsyncSession, room_id: int, agent_id: int, limit: int = 200
) -> List[models.Message]:
    """
    Get messages posted after the specified agent's last response.

    Falls back to messages after the agent's invitation time when they haven't responded yet.

    Args:
        db: Database session
        room_id: Room ID
        agent_id: Agent ID to filter after
        limit: Maximum number of messages to return

    Returns:
        Chronologically ordered messages after the agent's last response or invitation
    """
    # Find the agent's last message ID (if any)
    last_agent_message_id = await _get_last_agent_message_id(db, room_id, agent_id)

    query = select(models.Message).options(selectinload(models.Message.agent)).where(models.Message.room_id == room_id)

    if last_agent_message_id is not None:
        # Agent has responded before - show messages after their last response
        query = query.where(models.Message.id > last_agent_message_id)
    else:
        # Agent hasn't responded yet - check for invitation timestamp
        joined_at = await _get_agent_joined_at(db, room_id, agent_id)
        if joined_at is not None:
            # Show messages from invitation onwards
            query = query.where(models.Message.timestamp >= joined_at)
        # If no joined_at (old agents), show all recent messages (current behavior)

    query = query.order_by(models.Message.timestamp.desc()).limit(limit)

    result = await db.execute(query)
    return list(reversed(result.scalars().all()))


async def _get_last_agent_message_id(db: AsyncSession, room_id: int, agent_id: int) -> int | None:
    """Get the ID of the most recent message from the given agent in the room."""
    result = await db.execute(
        select(models.Message.id)
        .where(models.Message.room_id == room_id, models.Message.agent_id == agent_id)
        .order_by(models.Message.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _get_agent_joined_at(db: AsyncSession, room_id: int, agent_id: int):
    """Get the timestamp when the agent was added to the room."""
    from sqlalchemy import and_

    result = await db.execute(
        select(models.room_agents.c.joined_at).where(
            and_(models.room_agents.c.room_id == room_id, models.room_agents.c.agent_id == agent_id)
        )
    )
    return result.scalar_one_or_none()


async def get_chat_session_messages(
    db: AsyncSession, room_id: int, chat_session_id: int, limit: int = 100
) -> List[models.Message]:
    """
    Get messages for a specific chat session.

    Used for building conversation context in chat mode - only includes messages
    from the current chat session.

    Args:
        db: Database session
        room_id: Room ID
        chat_session_id: Chat session ID to filter by
        limit: Maximum number of messages to return

    Returns:
        List of messages ordered by timestamp
    """
    query = (
        select(models.Message)
        .options(selectinload(models.Message.agent))
        .where(models.Message.room_id == room_id)
        .where(models.Message.chat_session_id == chat_session_id)
        .order_by(models.Message.timestamp.desc())
        .limit(limit)
    )

    result = await db.execute(query)
    return list(reversed(result.scalars().all()))


async def get_messages_excluding_chat(db: AsyncSession, room_id: int, limit: int = 200) -> List[models.Message]:
    """
    Get messages excluding chat mode messages (where chat_session_id is NULL).

    Used for building game mode context - excludes chat mode conversations
    to keep game context separate.

    Args:
        db: Database session
        room_id: Room ID
        limit: Maximum number of messages to return

    Returns:
        List of game messages ordered by timestamp
    """
    query = (
        select(models.Message)
        .options(selectinload(models.Message.agent))
        .where(models.Message.room_id == room_id)
        .where(models.Message.chat_session_id.is_(None))
        .order_by(models.Message.timestamp.desc())
        .limit(limit)
    )

    result = await db.execute(query)
    return list(reversed(result.scalars().all()))


async def delete_room_messages(db: AsyncSession, room_id: int) -> bool:
    """Delete all messages for a specific room using bulk delete."""
    # First verify the room exists
    room_result = await db.execute(select(models.Room).where(models.Room.id == room_id))
    room = room_result.scalar_one_or_none()

    if not room:
        return False  # Room doesn't exist

    # Delete all messages (may be 0 messages, that's OK)
    async with serialized_write():
        await db.execute(delete(models.Message).where(models.Message.room_id == room_id))
        await db.commit()
    return True  # Success - room exists and messages cleared (even if 0)
