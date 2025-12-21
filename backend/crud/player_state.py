"""
CRUD operations for PlayerState entities.

Handles player stats, inventory, action history, and current location tracking.
Business rules (clamping, merging) are delegated to domain/services/player_rules.py.
"""

import json
import logging
from typing import List, Optional

import models
import schemas
from database import serialized_write
from domain.services.player_rules import (
    InventoryItem as DomainInventoryItem,
)
from domain.services.player_rules import (
    apply_stat_changes,
    initialize_stats_from_definitions,
    merge_inventory_item,
)
from domain.services.player_rules import (
    remove_inventory_item as remove_item_from_list,
)
from domain.services.player_state_serializer import PlayerStateSerializer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload

logger = logging.getLogger("PlayerStateCRUD")


async def get_player_state(
    db: AsyncSession,
    world_id: int,
) -> Optional[models.PlayerState]:
    """Get the player state for a world."""
    result = await db.execute(
        select(models.PlayerState)
        .options(selectinload(models.PlayerState.current_location))
        .where(models.PlayerState.world_id == world_id)
    )
    return result.scalar_one_or_none()


async def set_current_location(
    db: AsyncSession,
    world_id: int,
    location_id: int,
) -> Optional[models.PlayerState]:
    """Set the player's current location."""
    # Get player state
    result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = result.scalar_one_or_none()

    if not player_state:
        return None

    # Clear is_current on old location
    if player_state.current_location_id:
        old_loc_result = await db.execute(
            select(models.Location).where(models.Location.id == player_state.current_location_id)
        )
        old_location = old_loc_result.scalar_one_or_none()
        if old_location:
            old_location.is_current = False

    # Set is_current on new location
    new_loc_result = await db.execute(select(models.Location).where(models.Location.id == location_id))
    new_location = new_loc_result.scalar_one_or_none()
    if new_location:
        new_location.is_current = True
        new_location.is_discovered = True  # Visiting discovers a location

    # Update player state
    player_state.current_location_id = location_id

    async with serialized_write():
        await db.commit()

    await db.refresh(player_state, attribute_names=["current_location"])
    return player_state


async def increment_turn(
    db: AsyncSession,
    world_id: int,
) -> int:
    """Increment the turn counter and return new value."""
    result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = result.scalar_one_or_none()

    if not player_state:
        return 0

    player_state.turn_count += 1

    async with serialized_write():
        await db.commit()

    return player_state.turn_count


async def update_stats(
    db: AsyncSession,
    world_id: int,
    changes: dict,
    stat_definitions: Optional[dict] = None,
) -> dict:
    """Update player stats and return new values."""
    result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = result.scalar_one_or_none()

    if not player_state:
        return {}

    # Parse current stats and apply changes with clamping (delegated to domain rules)
    current_stats = PlayerStateSerializer.parse_stats(player_state.stats)
    new_stats = apply_stat_changes(current_stats, changes, stat_definitions)

    # Save
    player_state.stats = PlayerStateSerializer.serialize_stats(new_stats)

    async with serialized_write():
        await db.commit()

    return new_stats


async def add_inventory_item(
    db: AsyncSession,
    world_id: int,
    item: schemas.InventoryItem,
) -> List[dict]:
    """Add an item to inventory."""
    result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = result.scalar_one_or_none()

    if not player_state:
        return []

    # Parse current inventory and merge item (delegated to domain rules)
    inventory = PlayerStateSerializer.parse_inventory(player_state.inventory)
    domain_item = DomainInventoryItem(
        id=item.id,
        name=item.name,
        description=item.description,
        quantity=item.quantity,
        properties=item.properties,
    )
    new_inventory = merge_inventory_item(inventory, domain_item)

    # Save
    player_state.inventory = PlayerStateSerializer.serialize_inventory(new_inventory)

    async with serialized_write():
        await db.commit()

    return new_inventory


async def remove_inventory_item(
    db: AsyncSession,
    world_id: int,
    item_id: str,
    quantity: int = 1,
) -> tuple[bool, int]:
    """Remove an item from inventory. Returns (success, remaining_quantity)."""
    result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = result.scalar_one_or_none()

    if not player_state:
        return False, 0

    # Parse current inventory and remove item (delegated to domain rules)
    inventory = PlayerStateSerializer.parse_inventory(player_state.inventory)
    new_inventory, success, remaining = remove_item_from_list(inventory, item_id, quantity)

    if not success:
        return False, remaining

    # Save
    player_state.inventory = PlayerStateSerializer.serialize_inventory(new_inventory)

    async with serialized_write():
        await db.commit()

    return True, remaining


async def add_action_to_history(
    db: AsyncSession,
    world_id: int,
    turn: int,
    action: str,
    result_text: str,
) -> None:
    """Add an action to the player's action history."""
    db_result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = db_result.scalar_one_or_none()

    if not player_state:
        return

    # Parse current history
    history = json.loads(player_state.action_history) if player_state.action_history else []

    # Add new action
    history.append(
        {
            "turn": turn,
            "action": action,
            "result": result_text,
        }
    )

    # Keep only last 10 actions
    history = history[-10:]

    # Save
    player_state.action_history = PlayerStateSerializer.serialize_action_history(history)

    async with serialized_write():
        await db.commit()


async def initialize_player_stats(
    db: AsyncSession,
    world_id: int,
    stat_definitions: dict,
    initial_stats: Optional[dict] = None,
) -> dict:
    """Initialize player stats based on definitions."""
    result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = result.scalar_one_or_none()

    if not player_state:
        return {}

    # Build default stats from definitions (delegated to domain rules)
    new_stats = initialize_stats_from_definitions(stat_definitions, initial_stats)

    # Save
    player_state.stats = PlayerStateSerializer.serialize_stats(new_stats)

    async with serialized_write():
        await db.commit()

    return new_stats


# =============================================================================
# Chat Mode Operations
# =============================================================================


async def enter_chat_mode(
    db: AsyncSession,
    world_id: int,
    start_message_id: int,
) -> Optional[int]:
    """
    Enter chat mode for a world.

    Args:
        db: Database session
        world_id: World ID
        start_message_id: Message ID marking the start of chat mode

    Returns:
        The new chat_session_id if successfully entered chat mode, None if already in chat mode or error
    """
    result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = result.scalar_one_or_none()

    if not player_state:
        logger.warning(f"Cannot enter chat mode: PlayerState not found for world {world_id}")
        return None

    if player_state.is_chat_mode:
        logger.info(f"Already in chat mode for world {world_id}")
        return None

    # Generate a new chat session ID using timestamp-based approach
    import time

    chat_session_id = int(time.time() * 1000) % (2**31 - 1)  # Milliseconds, capped for int

    player_state.is_chat_mode = True
    player_state.chat_mode_start_message_id = start_message_id
    player_state.chat_session_id = chat_session_id

    async with serialized_write():
        await db.commit()

    logger.info(
        f"Entered chat mode for world {world_id}, start_message_id={start_message_id}, chat_session_id={chat_session_id}"
    )
    return chat_session_id


async def exit_chat_mode(
    db: AsyncSession,
    world_id: int,
) -> Optional[tuple[int, int]]:
    """
    Exit chat mode for a world.

    Args:
        db: Database session
        world_id: World ID

    Returns:
        Tuple of (start_message_id, chat_session_id) if was in chat mode, None if not in chat mode or error
    """
    result = await db.execute(select(models.PlayerState).where(models.PlayerState.world_id == world_id))
    player_state = result.scalar_one_or_none()

    if not player_state:
        logger.warning(f"Cannot exit chat mode: PlayerState not found for world {world_id}")
        return None

    if not player_state.is_chat_mode:
        logger.info(f"Not in chat mode for world {world_id}")
        return None

    start_message_id = player_state.chat_mode_start_message_id
    chat_session_id = player_state.chat_session_id
    player_state.is_chat_mode = False
    # Keep chat_mode_start_message_id so frontend can use it as resume point
    # It will be overwritten when entering chat mode again
    player_state.chat_session_id = None

    async with serialized_write():
        await db.commit()

    logger.info(
        f"Exited chat mode for world {world_id}, start_message_id={start_message_id}, chat_session_id={chat_session_id}"
    )
    return (start_message_id, chat_session_id)
