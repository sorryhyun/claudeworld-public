"""
Game state routes.

Endpoints for querying player state, stats, and inventory.
"""

import json

import crud
import schemas
from database import get_db
from dependencies import (
    RequestIdentity,
    get_request_identity,
)
from domain.services.access_control import AccessControl
from fastapi import APIRouter, Depends, HTTPException
from services.item_service import ItemService
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

    # Build response manually to resolve inventory items with templates
    inventory_refs = json.loads(player_state.inventory) if player_state.inventory else []
    resolved_inventory = ItemService.resolve_inventory(world.name, inventory_refs)

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

    player_state = await crud.get_player_state(db, world_id)
    if not player_state:
        raise HTTPException(status_code=404, detail="Player state not found")

    # Resolve inventory items with templates
    inventory_refs = json.loads(player_state.inventory) if player_state.inventory else []
    resolved_inventory = ItemService.resolve_inventory(world.name, inventory_refs)

    return {"items": resolved_inventory, "count": len(resolved_inventory)}
