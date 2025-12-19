"""
Location management routes.

Endpoints for listing locations, traveling, updating labels, and getting location messages.
"""

import logging
from typing import Optional

import crud
import schemas
from database import get_db
from dependencies import (
    RequestIdentity,
    get_request_identity,
)
from domain.services.access_control import AccessControl
from fastapi import APIRouter, Depends, HTTPException
from services.location_service import LocationService
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("GameRouter.Locations")

router = APIRouter()


@router.get("/{world_id}/locations", response_model=list[schemas.Location])
async def list_locations(
    world_id: int,
    discovered_only: bool = True,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    List all locations in the world.

    By default, only returns discovered locations.
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    locations = await crud.get_locations(db, world_id)

    if discovered_only:
        locations = [loc for loc in locations if loc.is_discovered]

    return locations


@router.get("/{world_id}/locations/current", response_model=schemas.Location)
async def get_current_location(
    world_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """Get the player's current location."""
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    player_state = await crud.get_player_state(db, world_id)
    if not player_state or not player_state.current_location_id:
        raise HTTPException(status_code=404, detail="No current location")

    location = await crud.get_location(db, player_state.current_location_id)
    if not location:
        raise HTTPException(status_code=404, detail="Location not found")

    return location


@router.post("/{world_id}/locations/{location_id}/travel")
async def travel_to_location(
    world_id: int,
    location_id: int,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Travel to a different location.

    This is equivalent to submitting a travel action.
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    # Verify location exists and belongs to this world
    location = await crud.get_location(db, location_id)
    if not location or location.world_id != world_id:
        raise HTTPException(status_code=404, detail="Location not found")

    # Update current location in database
    await crud.set_current_location(db, world_id, location_id)

    # Update current room in _state.json for filesystem sync
    room_key = LocationService.location_to_room_key(location.name)
    LocationService.set_current_room(world.name, room_key)

    logger.info(f"Traveled to location {location.display_name or location.name}")

    return {
        "status": "traveled",
        "destination": location.display_name or location.name,
        "location_id": location_id,
    }


@router.patch("/{world_id}/locations/{location_id}", response_model=schemas.Location)
async def update_location_label(
    world_id: int,
    location_id: int,
    update: schemas.LocationUpdate,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Update a location's user-assigned label.

    This is the only modification users can make to locations.
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    location = await crud.update_location_label(db, location_id, update.label)
    if not location:
        raise HTTPException(status_code=404, detail="Location not found")

    return location


@router.get("/{world_id}/locations/{location_id}/messages")
async def get_location_messages(
    world_id: int,
    location_id: int,
    limit: int = 50,
    since_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
    identity: RequestIdentity = Depends(get_request_identity),
):
    """
    Get messages (chat history) for a specific location.

    Used to view past interactions at that location.
    """
    world = await crud.get_world(db, world_id)
    if not world:
        raise HTTPException(status_code=404, detail="World not found")
    AccessControl.raise_if_no_access(identity.user_id, identity.role, world.owner_id)

    location = await crud.get_location(db, location_id)
    if not location or not location.room_id:
        raise HTTPException(status_code=404, detail="Location not found")

    # Use existing message query logic
    if since_id:
        messages = await crud.get_messages_since(db, location.room_id, since_id=since_id, limit=limit)
    else:
        messages = await crud.get_messages(db, location.room_id)
        # Apply limit manually since get_messages doesn't support it
        messages = messages[-limit:] if len(messages) > limit else messages

    # Format messages consistently with poll endpoint
    formatted_messages = [
        {
            "id": m.id,
            "content": m.content,
            "role": m.role,
            "agent_id": m.agent_id,
            "agent_name": m.agent.name if m.agent else None,
            "thinking": m.thinking,
            "timestamp": m.timestamp.isoformat() if m.timestamp else None,
            "image_data": m.image_data,
            "image_media_type": m.image_media_type,
        }
        for m in messages
    ]

    return {"messages": formatted_messages}
