"""Game-related schemas for TRPG (ClaudeWorld)."""

from datetime import datetime
from typing import Any, List, Optional

from domain.services.player_state_serializer import PlayerStateSerializer
from domain.value_objects.enums import Language, WorldPhase
from i18n.serializers import serialize_utc_datetime as _serialize_utc_datetime
from pydantic import BaseModel, field_serializer, model_validator

# =============================================================================
# World Schemas
# =============================================================================


class WorldBase(BaseModel):
    """Base schema for world data."""

    name: str
    user_name: Optional[str] = None  # Player's display name (set during onboarding, defaults to 여행자/traveler)
    language: Language = Language.ENGLISH  # UI/message language


class WorldCreate(WorldBase):
    """Schema for creating a new world."""

    pass


class WorldUpdate(BaseModel):
    """Schema for updating a world."""

    phase: Optional[WorldPhase] = None
    genre: Optional[str] = None
    theme: Optional[str] = None
    user_name: Optional[str] = None
    stat_definitions: Optional[dict] = None


class StatDefinition(BaseModel):
    """Schema for a single stat definition."""

    name: str
    display: str
    min: Optional[int] = None
    max: Optional[int] = None
    default: int = 0
    color: Optional[str] = None


class StatDefinitions(BaseModel):
    """Schema for stat definitions wrapper."""

    stats: List[StatDefinition] = []


class WorldSummary(WorldBase):
    """Schema for world listing."""

    id: int
    owner_id: Optional[str] = None
    phase: WorldPhase = WorldPhase.ONBOARDING
    genre: Optional[str] = None
    theme: Optional[str] = None
    onboarding_room_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    last_played_at: Optional[datetime] = None

    @field_serializer("created_at")
    def serialize_created_at(self, dt: datetime, _info):
        return _serialize_utc_datetime(dt)

    @field_serializer("updated_at")
    def serialize_updated_at(self, dt: datetime, _info):
        return _serialize_utc_datetime(dt)

    @field_serializer("last_played_at")
    def serialize_last_played_at(self, dt: Optional[datetime], _info):
        return _serialize_utc_datetime(dt) if dt else None

    class Config:
        from_attributes = True


class World(WorldSummary):
    """Full world schema with all details."""

    stat_definitions: Optional[StatDefinitions] = None
    lore: Optional[str] = None  # Loaded from filesystem

    @model_validator(mode="before")
    @classmethod
    def parse_stat_definitions(cls, data: Any) -> Any:
        """Parse stat_definitions from JSON string if stored."""
        if hasattr(data, "__dict__"):
            stat_defs = getattr(data, "stat_definitions", None)
            if stat_defs and isinstance(stat_defs, str):
                import json

                try:
                    parsed = json.loads(stat_defs)
                    # Return nested structure { stats: [...] } for frontend compatibility
                    stats_data = {"stats": parsed.get("stats", [])} if isinstance(parsed, dict) else {"stats": parsed}
                    data_dict = {
                        "id": data.id,
                        "name": data.name,
                        "user_name": data.user_name,
                        "language": data.language,
                        "owner_id": data.owner_id,
                        "phase": data.phase,
                        "genre": data.genre,
                        "theme": data.theme,
                        "onboarding_room_id": data.onboarding_room_id,
                        "stat_definitions": stats_data,
                        "created_at": data.created_at,
                        "updated_at": data.updated_at,
                        "last_played_at": data.last_played_at,
                    }
                    return data_dict
                except (json.JSONDecodeError, TypeError):
                    pass
        return data

    class Config:
        from_attributes = True


class ImportableWorld(BaseModel):
    """Schema for a world that exists in filesystem but not in database."""

    name: str
    owner_id: Optional[str] = None
    user_name: Optional[str] = None
    language: Language = Language.ENGLISH
    phase: WorldPhase = WorldPhase.ONBOARDING
    genre: Optional[str] = None
    theme: Optional[str] = None
    created_at: Optional[datetime] = None

    @field_serializer("created_at")
    def serialize_created_at(self, dt: Optional[datetime], _info):
        return _serialize_utc_datetime(dt) if dt else None


class WorldResetRequest(BaseModel):
    """Request schema for resetting a world to its initial state."""

    confirm: bool = False  # Safety flag to confirm reset


class WorldResetResponse(BaseModel):
    """Response schema after world reset."""

    success: bool
    message: str
    world_id: int
    starting_location: str


# =============================================================================
# Location Schemas
# =============================================================================


class LocationBase(BaseModel):
    """Base schema for location data."""

    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None


class LocationCreate(LocationBase):
    """Schema for creating a new location."""

    position_x: int = 0
    position_y: int = 0
    adjacent_to: Optional[List[int]] = None
    is_discovered: bool = True


class LocationUpdate(BaseModel):
    """Schema for updating a location."""

    label: Optional[str] = None
    is_discovered: Optional[bool] = None


class Location(LocationBase):
    """Full location schema."""

    id: int
    world_id: int
    label: Optional[str] = None
    position_x: int = 0
    position_y: int = 0
    adjacent_locations: Optional[List[int]] = None
    room_id: Optional[int] = None
    is_current: bool = False
    is_discovered: bool = True

    @model_validator(mode="before")
    @classmethod
    def parse_adjacent_locations(cls, data: Any) -> Any:
        """Parse adjacent_locations from JSON string if stored."""
        if hasattr(data, "__dict__"):
            adjacent = getattr(data, "adjacent_locations", None)
            if adjacent and isinstance(adjacent, str):
                import json

                try:
                    parsed = json.loads(adjacent)
                    data_dict = {
                        "id": data.id,
                        "world_id": data.world_id,
                        "name": data.name,
                        "display_name": data.display_name,
                        "description": data.description,
                        "label": data.label,
                        "position_x": data.position_x,
                        "position_y": data.position_y,
                        "adjacent_locations": parsed,
                        "room_id": data.room_id,
                        "is_current": data.is_current,
                        "is_discovered": data.is_discovered,
                    }
                    return data_dict
                except (json.JSONDecodeError, TypeError):
                    pass
        return data

    class Config:
        from_attributes = True


# =============================================================================
# Player State Schemas
# =============================================================================


class GameTime(BaseModel):
    """Schema for in-game time."""

    hour: int = 8
    minute: int = 0
    day: int = 1


class InventoryItem(BaseModel):
    """Schema for an inventory item."""

    id: str
    name: str
    description: Optional[str] = None
    quantity: int = 1
    properties: Optional[dict] = None


class PlayerStateBase(BaseModel):
    """Base schema for player state."""

    turn_count: int = 0


class PlayerState(PlayerStateBase):
    """Full player state schema."""

    id: int
    world_id: int
    current_location_id: Optional[int] = None
    current_location_name: Optional[str] = None
    stats: Optional[dict] = None
    inventory: Optional[List[InventoryItem]] = None
    effects: Optional[List[dict]] = None
    action_history: Optional[List[dict]] = None
    # Chat mode state
    is_chat_mode: bool = False
    chat_mode_start_message_id: Optional[int] = None
    # In-game time
    game_time: Optional[GameTime] = None

    @model_validator(mode="before")
    @classmethod
    def parse_json_fields(cls, data: Any) -> Any:
        """Parse JSON fields from database storage."""
        if hasattr(data, "__dict__"):
            data_dict = {
                "id": data.id,
                "world_id": data.world_id,
                "current_location_id": data.current_location_id,
                "turn_count": data.turn_count,
            }

            # Parse stats using PlayerStateSerializer
            stats = getattr(data, "stats", None)
            data_dict["stats"] = PlayerStateSerializer.parse_stats(stats)

            # Parse inventory using PlayerStateSerializer and normalize item_id -> id
            inventory = getattr(data, "inventory", None)
            parsed_inventory = PlayerStateSerializer.parse_inventory(inventory)
            # Normalize: ensure each item has 'id' (filesystem uses 'item_id')
            if parsed_inventory:
                for item in parsed_inventory:
                    if "item_id" in item and "id" not in item:
                        item["id"] = item.pop("item_id")
            data_dict["inventory"] = parsed_inventory

            # Parse effects using PlayerStateSerializer
            effects = getattr(data, "effects", None)
            data_dict["effects"] = PlayerStateSerializer.parse_effects(effects)

            # Parse action_history using PlayerStateSerializer
            action_history = getattr(data, "action_history", None)
            data_dict["action_history"] = PlayerStateSerializer.parse_action_history(action_history)

            # Get current location name if relationship exists
            current_location = getattr(data, "current_location", None)
            if current_location:
                data_dict["current_location_name"] = current_location.display_name or current_location.name

            # Chat mode fields
            data_dict["is_chat_mode"] = getattr(data, "is_chat_mode", False) or False
            data_dict["chat_mode_start_message_id"] = getattr(data, "chat_mode_start_message_id", None)

            # Game time (from filesystem, may not exist in DB model)
            game_time = getattr(data, "game_time", None)
            if game_time:
                data_dict["game_time"] = game_time

            return data_dict
        return data

    class Config:
        from_attributes = True


class PlayerAction(BaseModel):
    """Schema for a player action."""

    text: str
    image_data: Optional[str] = None  # Base64 encoded image data
    image_media_type: Optional[str] = None  # MIME type (e.g., 'image/png')


class GameStateResponse(BaseModel):
    """Schema for the full game state response."""

    world: WorldSummary
    player_state: PlayerState
    current_location: Optional[Location] = None
    suggestions: Optional[List[str]] = None


__all__ = [
    # World
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
    # Location
    "LocationBase",
    "LocationCreate",
    "LocationUpdate",
    "Location",
    # Player State
    "GameTime",
    "InventoryItem",
    "PlayerStateBase",
    "PlayerState",
    "PlayerAction",
    "GameStateResponse",
]
