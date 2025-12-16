"""
World filesystem models.

Dataclasses for world data stored in the filesystem (worlds/{name}/).
These are the primary data sources - database is cache only.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class WorldConfig:
    """World configuration from world.yaml."""

    name: str
    owner_id: Optional[str]
    user_name: Optional[str]  # Player's display name in the world
    language: str  # "en" | "ko" - UI/message language
    genre: Optional[str]
    theme: Optional[str]
    phase: str
    created_at: datetime
    updated_at: datetime
    settings: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PlayerState:
    """Player state from player.yaml."""

    current_location: Optional[str]
    turn_count: int
    stats: Dict[str, int] = field(default_factory=dict)
    inventory: List[Dict[str, Any]] = field(default_factory=list)
    effects: List[Dict[str, Any]] = field(default_factory=list)
    recent_actions: List[Dict[str, Any]] = field(default_factory=list)
    game_time: Dict[str, int] = field(default_factory=lambda: {"hour": 8, "minute": 0, "day": 1})


@dataclass
class LocationConfig:
    """Location configuration from locations/_index.yaml."""

    name: str
    display_name: str
    label: Optional[str]
    position: tuple
    is_discovered: bool
    adjacent: List[str] = field(default_factory=list)
    description: str = ""


@dataclass
class StatDefinition:
    """Stat definition from stats.yaml."""

    name: str
    display: str
    min: Optional[int] = None
    max: Optional[int] = None
    default: int = 0
    color: Optional[str] = None


@dataclass
class RoomMapping:
    """Maps a room key to its database room ID and metadata.

    Room keys follow conventions:
    - "onboarding" - The onboarding/interview room
    - "location:{name}" - A location's chat room
    - "chat:{agent_name}" - Direct chat with an agent
    """

    db_room_id: int
    agents: List[str] = field(default_factory=list)
    created_at: Optional[str] = None


@dataclass
class TransientState:
    """Transient runtime state from _state.json.

    This is the bridge between filesystem world data and database messages.
    Contains state that needs to persist across server restarts
    but is not part of the core game progression (player.yaml).

    Structure:
    - suggestions: Action suggestions for the player UI
    - rooms: Maps room keys to database room IDs
    - current_room: Currently active room key
    - ui: Transient UI state (panel selection, zoom, etc.)
    """

    suggestions: List[str] = field(default_factory=list)
    last_updated: Optional[str] = None
    rooms: Dict[str, RoomMapping] = field(default_factory=dict)
    current_room: Optional[str] = None
    ui: Dict[str, Any] = field(default_factory=dict)
