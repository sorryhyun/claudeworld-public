"""
Pydantic schemas for API request/response models.

This package organizes schemas by resource type:
- agents.py: Agent-related schemas
- rooms.py: Room-related schemas
- messages.py: Message-related schemas
- game.py: TRPG game schemas (World, Location, PlayerState)
- common.py: Shared base classes and mixins
"""

# Re-export all schemas for backwards compatibility
from schemas.agents import Agent, AgentBase, AgentCreate, AgentUpdate
from schemas.common import TimestampSerializerMixin
from schemas.game import (
    GameStateResponse,
    GameTime,
    ImportableWorld,
    InventoryItem,
    Location,
    LocationBase,
    LocationCreate,
    LocationUpdate,
    PlayerAction,
    PlayerState,
    PlayerStateBase,
    StatDefinition,
    StatDefinitions,
    World,
    WorldBase,
    WorldCreate,
    WorldResetRequest,
    WorldResetResponse,
    WorldSummary,
    WorldUpdate,
)
from schemas.messages import Message, MessageBase, MessageCreate, PollResponse
from schemas.rooms import Room, RoomBase, RoomCreate, RoomSummary, RoomUpdate

__all__ = [
    # Common
    "TimestampSerializerMixin",
    # Agents
    "AgentBase",
    "AgentCreate",
    "AgentUpdate",
    "Agent",
    # Messages
    "MessageBase",
    "MessageCreate",
    "Message",
    "PollResponse",
    # Rooms
    "RoomBase",
    "RoomCreate",
    "RoomUpdate",
    "Room",
    "RoomSummary",
    # Game - World
    "WorldBase",
    "WorldCreate",
    "WorldUpdate",
    "StatDefinition",
    "StatDefinitions",
    "WorldSummary",
    "World",
    "ImportableWorld",
    "WorldResetRequest",
    "WorldResetResponse",
    # Game - Location
    "LocationBase",
    "LocationCreate",
    "LocationUpdate",
    "Location",
    # Game - Player State
    "GameTime",
    "InventoryItem",
    "PlayerStateBase",
    "PlayerState",
    "PlayerAction",
    "GameStateResponse",
]
