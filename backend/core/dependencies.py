"""Shared dependencies for FastAPI endpoints."""

import logging
from typing import NamedTuple

import crud
import schemas
from domain.exceptions import RoomNotFoundError
from domain.value_objects.enums import UserRole
from fastapi import HTTPException, Request
from orchestration import ChatOrchestrator
from sdk import AgentManager
from services.world_service import WorldService
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("Dependencies")


class RequestIdentity(NamedTuple):
    role: UserRole
    user_id: str


def get_request_identity(request: Request) -> RequestIdentity:
    """Return the authenticated user's role and unique id from the request state."""
    role_str = getattr(request.state, "user_role", "admin")
    # Convert string to enum
    role = UserRole.ADMIN if role_str == "admin" else UserRole.GUEST
    user_id = getattr(request.state, "user_id", role_str)
    return RequestIdentity(role=role, user_id=user_id)


async def ensure_room_access(db: AsyncSession, room_id: int, identity: RequestIdentity):
    """Ensure the current user can access the given room or raise an HTTP error.

    Also syncs world phase from filesystem to database if they differ.
    """
    room = await crud.get_room(db, room_id)
    if room is None:
        raise RoomNotFoundError(room_id)

    if identity.role != UserRole.ADMIN and room.owner_id != identity.user_id:
        raise HTTPException(status_code=403, detail="You do not have access to this room")

    # Sync world phase from filesystem (source of truth) if room belongs to a world
    if room.world_id and room.world:
        fs_config = WorldService.load_world_config(room.world.name)
        if fs_config and fs_config.phase != room.world.phase:
            logger.info(
                f"Phase mismatch for world {room.world.name}: DB={room.world.phase}, FS={fs_config.phase}. Syncing."
            )
            await crud.update_world(db, room.world.id, schemas.WorldUpdate(phase=fs_config.phase))
            # Refresh the room to get updated world phase
            room = await crud.get_room(db, room_id)

    return room


def get_agent_manager(request: Request) -> AgentManager:
    """
    Dependency to get the agent manager instance from app state.

    The instance is created during application startup in the lifespan context.
    """
    return request.app.state.agent_manager


def get_chat_orchestrator(request: Request) -> ChatOrchestrator:
    """
    Dependency to get the chat orchestrator instance from app state.

    The instance is created during application startup in the lifespan context.
    """
    return request.app.state.chat_orchestrator
