"""
Helper functions shared across CRUD operations.

Note: Business logic helpers (merge_agent_configs, save_base64_profile_pic)
have been moved to services/agent_factory.py and services/agent_config_service.py.
"""

import logging
from typing import Optional

from infrastructure.database import models
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload

logger = logging.getLogger("CRUD")


async def get_room_with_relationships(db: AsyncSession, room_id: int) -> Optional[models.Room]:
    """
    Helper to fetch a room with all relationships (agents, messages, and world).
    Consolidates common query pattern used across multiple CRUD operations.
    """
    result = await db.execute(
        select(models.Room)
        .options(
            selectinload(models.Room.agents),
            selectinload(models.Room.messages).selectinload(models.Message.agent),
            selectinload(models.Room.world),  # Load world for phase info
        )
        .where(models.Room.id == room_id)
    )
    return result.scalar_one_or_none()
