"""
Location and room mapping service.

This module provides a unified facade over the split services:
- LocationStorage: Location filesystem storage operations
- TransientStateService: _state.json management
- RoomMappingService: Room-to-location mappings

For new code, prefer importing the specific service classes directly.
This facade maintains backwards compatibility with existing imports.
"""

from typing import Any, Dict, List, Optional

from domain.entities.world_models import LocationConfig, RoomMapping, TransientState

from .location_storage import LocationStorage
from .room_mapping_service import RoomMappingService
from .transient_state_service import TransientStateService


class LocationService:
    """
    Unified facade for location, room mapping, and transient state operations.

    Delegates to specialized services:
    - LocationStorage: Location CRUD (create, load, update, delete)
    - TransientStateService: State management (_state.json)
    - RoomMappingService: Room-location mappings

    For new code, consider importing specific services directly:
        from services.location_crud import LocationStorage
        from services.room_mapping_service import RoomMappingService
        from services.transient_state_service import TransientStateService
    """

    # =========================================================================
    # Location CRUD (delegated to LocationStorage)
    # =========================================================================

    @classmethod
    def create_location(
        cls,
        world_name: str,
        location_name: str,
        display_name: str,
        description: str,
        position: tuple,
        adjacent: Optional[List[str]] = None,
        is_draft: bool = False,
    ) -> None:
        """Create a new location in the world."""
        return LocationStorage.create_location(
            world_name, location_name, display_name, description, position, adjacent, is_draft
        )

    @classmethod
    def load_location(cls, world_name: str, location_name: str) -> Optional[LocationConfig]:
        """Load a location configuration from filesystem."""
        return LocationStorage.load_location(world_name, location_name)

    @classmethod
    def load_all_locations(cls, world_name: str) -> Dict[str, LocationConfig]:
        """Load all locations from filesystem."""
        return LocationStorage.load_all_locations(world_name)

    @classmethod
    def update_location(
        cls,
        world_name: str,
        location_name: str,
        is_discovered: Optional[bool] = None,
        label: Optional[str] = None,
    ) -> bool:
        """Update location properties in the index."""
        return LocationStorage.update_location(world_name, location_name, is_discovered, label)

    @classmethod
    def cleanup_stale_entries(cls, world_name: str) -> List[str]:
        """Remove stale entries from _index.yaml."""
        return LocationStorage.cleanup_stale_entries(world_name)

    @classmethod
    def load_location_events(cls, world_name: str, location_name: str) -> str:
        """Load events.md content for a location."""
        return LocationStorage.load_location_events(world_name, location_name)

    @classmethod
    def add_location_event(cls, world_name: str, location_name: str, turn: int, event: str) -> None:
        """Add an event to a location's history."""
        return LocationStorage.add_location_event(world_name, location_name, turn, event)

    # =========================================================================
    # Transient State (delegated to TransientStateService)
    # =========================================================================

    @classmethod
    def load_state(cls, world_name: str) -> TransientState:
        """Load transient runtime state from _state.json."""
        return TransientStateService.load_state(world_name)

    @classmethod
    def save_state(cls, world_name: str, state: TransientState) -> None:
        """Save transient runtime state to _state.json."""
        return TransientStateService.save_state(world_name, state)

    @classmethod
    def save_suggestions(cls, world_name: str, suggestions: List[str]) -> None:
        """Convenience method to save just suggestions."""
        return TransientStateService.save_suggestions(world_name, suggestions)

    @classmethod
    def load_suggestions(cls, world_name: str) -> List[str]:
        """Convenience method to load just suggestions."""
        return TransientStateService.load_suggestions(world_name)

    @classmethod
    def save_arrival_context(
        cls,
        world_name: str,
        previous_narration: str,
        triggering_action: str,
        from_location: str,
    ) -> None:
        """Save arrival context after travel for continuity."""
        return TransientStateService.save_arrival_context(
            world_name, previous_narration, triggering_action, from_location
        )

    @classmethod
    def load_and_clear_arrival_context(cls, world_name: str) -> Optional[Dict[str, str]]:
        """Load and clear arrival context (one-time use)."""
        return TransientStateService.load_and_clear_arrival_context(world_name)

    # =========================================================================
    # Room Mapping (delegated to RoomMappingService)
    # =========================================================================

    @classmethod
    def get_room_id(cls, world_name: str, room_key: str) -> Optional[int]:
        """Get the database room ID for a room key."""
        return RoomMappingService.get_room_id(world_name, room_key)

    @classmethod
    def set_room_mapping(
        cls,
        world_name: str,
        room_key: str,
        db_room_id: int,
        agents: Optional[List[str]] = None,
    ) -> None:
        """Store a room mapping in _state.json."""
        return RoomMappingService.set_room_mapping(world_name, room_key, db_room_id, agents)

    @classmethod
    def get_room_mapping(cls, world_name: str, room_key: str) -> Optional[RoomMapping]:
        """Get the full room mapping for a room key."""
        return RoomMappingService.get_room_mapping(world_name, room_key)

    @classmethod
    def get_all_room_mappings(cls, world_name: str) -> Dict[str, RoomMapping]:
        """Get all room mappings for a world."""
        return RoomMappingService.get_all_room_mappings(world_name)

    @classmethod
    def add_agent_to_room(cls, world_name: str, room_key: str, agent_name: str) -> bool:
        """Add an agent to a room's agent list."""
        return RoomMappingService.add_agent_to_room(world_name, room_key, agent_name)

    @classmethod
    def remove_agent_from_room(cls, world_name: str, room_key: str, agent_name: str) -> bool:
        """Remove an agent from a room's agent list."""
        return RoomMappingService.remove_agent_from_room(world_name, room_key, agent_name)

    @classmethod
    def get_current_room(cls, world_name: str) -> Optional[str]:
        """Get the current active room key for a world."""
        return RoomMappingService.get_current_room(world_name)

    @classmethod
    def set_current_room(cls, world_name: str, room_key: str) -> None:
        """Set the current active room for a world."""
        return RoomMappingService.set_current_room(world_name, room_key)

    @classmethod
    def get_current_room_id(cls, world_name: str) -> Optional[int]:
        """Get the database room ID for the current active room."""
        return RoomMappingService.get_current_room_id(world_name)

    @classmethod
    def location_to_room_key(cls, location_name: str) -> str:
        """Convert a location name to a room key."""
        return RoomMappingService.location_to_room_key(location_name)

    @classmethod
    def find_location_room_key_fuzzy(cls, world_name: str, location_name: str) -> Optional[str]:
        """Find a location room key using fuzzy matching."""
        return RoomMappingService.find_location_room_key_fuzzy(world_name, location_name)

    @classmethod
    def room_key_to_location(cls, room_key: str) -> Optional[str]:
        """Extract location name from a room key."""
        return RoomMappingService.room_key_to_location(room_key)

    @classmethod
    def delete_room_mapping(cls, world_name: str, room_key: str) -> bool:
        """Delete a room mapping from _state.json."""
        return RoomMappingService.delete_room_mapping(world_name, room_key)

    @classmethod
    def get_room_ids_for_world(cls, world_name: str) -> List[int]:
        """Get all database room IDs associated with a world."""
        return RoomMappingService.get_room_ids_for_world(world_name)

    @classmethod
    def rebuild_room_mappings_from_db(
        cls,
        world_name: str,
        onboarding_room_id: Optional[int],
        location_room_mappings: Dict[str, int],
    ) -> None:
        """Rebuild _state.json room mappings from database data."""
        return RoomMappingService.rebuild_room_mappings_from_db(world_name, onboarding_room_id, location_room_mappings)

    @classmethod
    def ensure_room_mapping_exists(
        cls,
        world_name: str,
        room_key: str,
        db_room_id: int,
        agents: Optional[List[str]] = None,
    ) -> bool:
        """Ensure a room mapping exists, creating it if missing."""
        return RoomMappingService.ensure_room_mapping_exists(world_name, room_key, db_room_id, agents)

    @classmethod
    def validate_state(cls, world_name: str) -> Dict[str, Any]:
        """Validate _state.json structure and return diagnostic info."""
        return TransientStateService.validate_state(world_name)
