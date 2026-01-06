"""
Game state routes.

Endpoints for querying player state, stats, and inventory.
"""

import json

import crud
import schemas
from core.dependencies import (
    RequestIdentity,
    get_request_identity,
)
from domain.services.access_control import AccessControl
from fastapi import APIRouter, Depends, HTTPException
from infrastructure.database.connection import get_db
from services.player_service import PlayerService
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()


@router.get("/{world_id}/state", response_model=schemas.PlayerState)
async def get_game_state(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """Get current player state (stats, inventory, location, turn count)."""
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    player_state = await crud.get_player_state(db, world_id)
    if not player_state:
        raise HTTPException(status_code=404, detail="Player state not found")

    # Load resolved inventory from filesystem (primary source of truth)
    # This ensures frontend always shows the latest state from player.yaml
    resolved_inventory = PlayerService.get_resolved_inventory(world.name)

    # Convert resolved inventory to schema format (item_id -> id, properties mapping)
    inventory_items = []
    for item in resolved_inventory:
        inventory_items.append(
            schemas.InventoryItem(
                id=item.get("item_id") or item.get("id", ""),
                name=item.get("name", ""),
                description=item.get("description"),
                quantity=item.get("quantity", 1),
                properties=item.get("properties"),
            )
        )

    # Get current location name if available
    current_location_name = None
    if player_state.current_location:
        current_location_name = player_state.current_location.display_name or player_state.current_location.name

    # Parse other JSON fields
    stats = json.loads(player_state.stats) if player_state.stats else None
    effects = json.loads(player_state.effects) if player_state.effects else None
    action_history = json.loads(player_state.action_history) if player_state.action_history else None

    # Load game_time and equipment from filesystem (source of truth)
    fs_state = PlayerService.load_player_state(world.name)
    game_time = None
    equipment = None
    if fs_state:
        if fs_state.game_time:
            game_time = schemas.GameTime(
                hour=fs_state.game_time.get("hour", 8),
                minute=fs_state.game_time.get("minute", 0),
                day=fs_state.game_time.get("day", 1),
            )
        equipment = fs_state.equipment or {}

    return schemas.PlayerState(
        id=player_state.id,
        world_id=player_state.world_id,
        current_location_id=player_state.current_location_id,
        current_location_name=current_location_name,
        turn_count=player_state.turn_count,
        stats=stats,
        inventory=inventory_items,
        effects=effects,
        action_history=action_history,
        is_chat_mode=player_state.is_chat_mode or False,
        chat_mode_start_message_id=player_state.chat_mode_start_message_id,
        game_time=game_time,
        equipment=equipment,
    )


@router.get("/{world_id}/state/stats")
async def get_stats(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """Get current stats with definitions (for UI rendering)."""
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    player_state = await crud.get_player_state(db, world_id)

    # Load stat definitions from filesystem (primary source of truth)
    stat_defs = PlayerService.load_stat_definitions(world.name)
    current_stats = json.loads(player_state.stats) if player_state and player_state.stats else {}

    return {
        "definitions": stat_defs.get("stats", []),
        "current": current_stats,
    }


@router.get("/{world_id}/state/inventory")
async def get_inventory(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """Get current inventory."""
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    # Load resolved inventory from filesystem (primary source of truth)
    resolved_inventory = PlayerService.get_resolved_inventory(world.name)

    return {"items": resolved_inventory, "count": len(resolved_inventory)}


@router.get("/{world_id}/items")
async def get_world_items(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Get all item templates defined in the world.

    Returns all items from the items/ directory (world-level item catalog).
    """
    from services.item_service import ItemService

    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    # Load all item templates from filesystem
    items = ItemService.get_all_items_in_world(world.name)

    return {"items": items, "count": len(items)}
