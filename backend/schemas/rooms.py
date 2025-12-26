"""Room-related schemas."""

from datetime import datetime
from typing import List, Optional

from domain.value_objects.enums import WorldPhase
from pydantic import BaseModel

from schemas.agents import Agent
from schemas.common import TimestampSerializerMixin
from schemas.messages import Message


class RoomBase(BaseModel):
    name: str


class RoomCreate(RoomBase):
    max_interactions: Optional[int] = None


class RoomUpdate(BaseModel):
    max_interactions: Optional[int] = None
    is_paused: Optional[bool] = None
    is_finished: Optional[bool] = None


class Room(TimestampSerializerMixin, RoomBase):
    id: int
    owner_id: Optional[str] = None
    max_interactions: Optional[int] = None
    is_paused: bool = False
    is_finished: bool = False
    created_at: datetime
    last_activity_at: Optional[datetime] = None
    agents: List[Agent] = []
    messages: List[Message] = []
    # World info (for TRPG rooms)
    world_id: Optional[int] = None
    world_phase: Optional[WorldPhase] = None

    class Config:
        from_attributes = True


class RoomSummary(TimestampSerializerMixin, RoomBase):
    id: int
    owner_id: Optional[str] = None
    max_interactions: Optional[int] = None
    is_paused: bool = False
    is_finished: bool = False
    created_at: datetime
    last_activity_at: Optional[datetime] = None

    class Config:
        from_attributes = True


__all__ = [
    "RoomBase",
    "RoomCreate",
    "RoomUpdate",
    "Room",
    "RoomSummary",
]
