"""
Room mapping and transient state service.

Handles _state.json operations: room mappings, suggestions, arrival context, and UI state.
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from domain.entities.world_models import RoomMapping, TransientState

from .world_service import WorldService

logger = logging.getLogger("RoomMappingService")


class RoomMappingService:
    """Room-to-location mapping and transient state management."""

    # =========================================================================
    # Core state I/O
    # =========================================================================

    @classmethod
    def load_state(cls, world_name: str) -> TransientState:
        """Load transient runtime state from _state.json.

        Returns an empty TransientState if file doesn't exist.
        """
        world_path = WorldService.get_world_path(world_name)
        state_file = world_path / "_state.json"

        if not state_file.exists():
            return TransientState()

        try:
            with open(state_file, "r", encoding="utf-8") as f:
                data = json.load(f)

            rooms: Dict[str, RoomMapping] = {}
            for room_key, room_data in data.get("rooms", {}).items():
                if isinstance(room_data, dict):
                    rooms[room_key] = RoomMapping(
                        db_room_id=room_data.get("db_room_id", 0),
                        agents=room_data.get("agents", []),
                        created_at=room_data.get("created_at"),
                    )

            return TransientState(
                suggestions=data.get("suggestions", []),
                last_updated=data.get("last_updated"),
                rooms=rooms,
                current_room=data.get("current_room"),
                ui=data.get("ui", {}),
            )
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to load _state.json for {world_name}: {e}")
            return TransientState()

    @classmethod
    def save_state(cls, world_name: str, state: TransientState) -> None:
        """Save transient runtime state to _state.json."""
        world_path = WorldService.get_world_path(world_name)

        rooms_data = {}
        for room_key, mapping in state.rooms.items():
            rooms_data[room_key] = {
                "db_room_id": mapping.db_room_id,
                "agents": mapping.agents,
                "created_at": mapping.created_at,
            }

        data = {
            "suggestions": state.suggestions,
            "last_updated": datetime.now().isoformat(),
            "rooms": rooms_data,
            "current_room": state.current_room,
            "ui": state.ui,
        }

        with open(world_path / "_state.json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    # =========================================================================
    # Suggestions
    # =========================================================================

    @classmethod
    def save_suggestions(cls, world_name: str, suggestions: List[str]) -> None:
        """Save suggestions to _state.json."""
        state = cls.load_state(world_name)
        state.suggestions = suggestions
        cls.save_state(world_name, state)

    @classmethod
    def load_suggestions(cls, world_name: str) -> List[str]:
        """Load suggestions from _state.json."""
        state = cls.load_state(world_name)
        return state.suggestions

    # =========================================================================
    # Arrival context
    # =========================================================================

    @classmethod
    def save_arrival_context(
        cls,
        world_name: str,
        previous_narration: str,
        triggering_action: str,
        from_location: str,
    ) -> None:
        """Save arrival context after travel for continuity."""
        state = cls.load_state(world_name)
        state.ui["arrival_context"] = {
            "previous_narration": previous_narration,
            "triggering_action": triggering_action,
            "from_location": from_location,
        }
        cls.save_state(world_name, state)
        logger.info(f"Saved arrival context for {world_name}")

    @classmethod
    def load_and_clear_arrival_context(cls, world_name: str) -> Optional[Dict[str, str]]:
        """Load and clear arrival context (one-time use)."""
        state = cls.load_state(world_name)
        arrival_context = state.ui.get("arrival_context")

        if arrival_context:
            del state.ui["arrival_context"]
            cls.save_state(world_name, state)
            logger.info(f"Loaded and cleared arrival context for {world_name}")

        return arrival_context

    # =========================================================================
    # Validation
    # =========================================================================

    @classmethod
    def validate_state(cls, world_name: str) -> Dict[str, Any]:
        """Validate _state.json structure and return diagnostic info."""
        result = {
            "valid": True,
            "errors": [],
            "room_count": 0,
            "current_room": None,
        }

        try:
            state = cls.load_state(world_name)
            result["room_count"] = len(state.rooms)
            result["current_room"] = state.current_room

            if state.current_room and state.current_room not in state.rooms:
                result["valid"] = False
                result["errors"].append(f"current_room '{state.current_room}' not found in rooms")

            for room_key, mapping in state.rooms.items():
                if not mapping.db_room_id or mapping.db_room_id <= 0:
                    result["valid"] = False
                    result["errors"].append(f"Room '{room_key}' has invalid db_room_id: {mapping.db_room_id}")

        except Exception as e:
            result["valid"] = False
            result["errors"].append(f"Failed to load _state.json: {e}")

        return result

    # =========================================================================
    # Room mapping operations
    # =========================================================================

    @classmethod
    def get_room_id(cls, world_name: str, room_key: str) -> Optional[int]:
        """Get the database room ID for a room key."""
        state = cls.load_state(world_name)
        mapping = state.rooms.get(room_key)
        return mapping.db_room_id if mapping else None

    @classmethod
    def set_room_mapping(
        cls,
        world_name: str,
        room_key: str,
        db_room_id: int,
        agents: Optional[List[str]] = None,
    ) -> None:
        """Store a room mapping in _state.json."""
        state = cls.load_state(world_name)
        state.rooms[room_key] = RoomMapping(
            db_room_id=db_room_id,
            agents=agents or [],
            created_at=datetime.now().isoformat(),
        )
        cls.save_state(world_name, state)
        logger.info(f"Set room mapping: {world_name}/{room_key} -> room_id={db_room_id}")

    @classmethod
    def get_room_mapping(cls, world_name: str, room_key: str) -> Optional[RoomMapping]:
        """Get the full room mapping for a room key."""
        state = cls.load_state(world_name)
        return state.rooms.get(room_key)

    @classmethod
    def get_all_room_mappings(cls, world_name: str) -> Dict[str, RoomMapping]:
        """Get all room mappings for a world."""
        state = cls.load_state(world_name)
        return state.rooms

    @classmethod
    def add_agent_to_room(cls, world_name: str, room_key: str, agent_name: str) -> bool:
        """Add an agent to a room's agent list in _state.json.

        Uses fuzzy matching for location room keys if exact match fails.
        """
        state = cls.load_state(world_name)
        mapping = state.rooms.get(room_key)

        if not mapping and room_key.startswith("location:"):
            fuzzy_key = cls.find_location_room_key_fuzzy(world_name, cls.room_key_to_location(room_key))
            if fuzzy_key:
                logger.info(f"Fuzzy matched room key: '{room_key}' -> '{fuzzy_key}'")
                room_key = fuzzy_key
                mapping = state.rooms.get(room_key)

        if not mapping:
            if room_key.startswith("location:"):
                mapping = RoomMapping(db_room_id=0, agents=[])
                state.rooms[room_key] = mapping
                logger.info(f"Auto-created room mapping for {room_key} in world {world_name}")
            else:
                logger.warning(f"Room {room_key} not found in world {world_name}")
                return False

        if agent_name in mapping.agents:
            return False

        mapping.agents.append(agent_name)
        cls.save_state(world_name, state)
        logger.info(f"Added agent {agent_name} to room {room_key} in world {world_name}")
        return True

    @classmethod
    def remove_agent_from_room(cls, world_name: str, room_key: str, agent_name: str) -> bool:
        """Remove an agent from a room's agent list in _state.json.

        Uses fuzzy matching for location room keys if exact match fails.
        """
        state = cls.load_state(world_name)
        mapping = state.rooms.get(room_key)

        if not mapping and room_key.startswith("location:"):
            fuzzy_key = cls.find_location_room_key_fuzzy(world_name, cls.room_key_to_location(room_key))
            if fuzzy_key:
                logger.info(f"Fuzzy matched room key: '{room_key}' -> '{fuzzy_key}'")
                room_key = fuzzy_key
                mapping = state.rooms.get(room_key)

        if not mapping:
            logger.warning(f"Room {room_key} not found in world {world_name}")
            return False

        if agent_name not in mapping.agents:
            return False

        mapping.agents.remove(agent_name)
        cls.save_state(world_name, state)
        logger.info(f"Removed agent {agent_name} from room {room_key} in world {world_name}")
        return True

    @classmethod
    def get_current_room(cls, world_name: str) -> Optional[str]:
        """Get the current active room key for a world."""
        state = cls.load_state(world_name)
        return state.current_room

    @classmethod
    def set_current_room(cls, world_name: str, room_key: str) -> None:
        """Set the current active room for a world."""
        state = cls.load_state(world_name)
        state.current_room = room_key
        cls.save_state(world_name, state)
        logger.info(f"Set current room for {world_name} to {room_key}")

    @classmethod
    def get_current_room_id(cls, world_name: str) -> Optional[int]:
        """Get the database room ID for the current active room."""
        current = cls.get_current_room(world_name)
        if not current:
            return None
        return cls.get_room_id(world_name, current)

    @classmethod
    def location_to_room_key(cls, location_name: str) -> str:
        """Convert a location name to a room key."""
        return f"location:{location_name}"

    @classmethod
    def find_location_room_key_fuzzy(cls, world_name: str, location_name: str) -> Optional[str]:
        """Find a location room key using fuzzy matching.

        Tries: exact match, case-insensitive, partial match, filesystem fallback.
        """
        state = cls.load_state(world_name)
        search_lower = location_name.lower()

        location_rooms = [k for k in state.rooms.keys() if k.startswith("location:")]

        # 1. Exact match
        exact_key = cls.location_to_room_key(location_name)
        if exact_key in state.rooms:
            return exact_key

        # 2. Case-insensitive exact match
        for room_key in location_rooms:
            loc_name = cls.room_key_to_location(room_key)
            if loc_name and loc_name.lower() == search_lower:
                return room_key

        # 3. Partial matches (prefix, contains, reverse contains)
        for room_key in location_rooms:
            loc_name = cls.room_key_to_location(room_key)
            if loc_name and loc_name.lower().startswith(search_lower):
                return room_key

        for room_key in location_rooms:
            loc_name = cls.room_key_to_location(room_key)
            if loc_name and search_lower in loc_name.lower():
                return room_key

        for room_key in location_rooms:
            loc_name = cls.room_key_to_location(room_key)
            if loc_name and loc_name.lower() in search_lower:
                return room_key

        # 4. Filesystem fallback
        from .location_storage import LocationStorage

        fs_locations = LocationStorage.load_all_locations(world_name)
        for folder_name in fs_locations:
            if folder_name.lower() == search_lower or search_lower in folder_name.lower():
                return f"location:{folder_name}"

        return None

    @classmethod
    def room_key_to_location(cls, room_key: str) -> Optional[str]:
        """Extract location name from a room key."""
        if room_key.startswith("location:"):
            return room_key[9:]
        return None

    @classmethod
    def delete_room_mapping(cls, world_name: str, room_key: str) -> bool:
        """Delete a room mapping from _state.json."""
        state = cls.load_state(world_name)

        if room_key not in state.rooms:
            return False

        del state.rooms[room_key]

        if state.current_room == room_key:
            state.current_room = None

        cls.save_state(world_name, state)
        logger.info(f"Deleted room mapping {room_key} from world {world_name}")
        return True

    @classmethod
    def get_room_ids_for_world(cls, world_name: str) -> List[int]:
        """Get all database room IDs associated with a world."""
        state = cls.load_state(world_name)
        return [mapping.db_room_id for mapping in state.rooms.values()]

    @classmethod
    def rebuild_room_mappings_from_db(
        cls,
        world_name: str,
        onboarding_room_id: Optional[int],
        location_room_mappings: Dict[str, int],
    ) -> None:
        """Rebuild _state.json room mappings from database data."""
        state = cls.load_state(world_name)

        state.rooms = {}

        if onboarding_room_id:
            state.rooms["onboarding"] = RoomMapping(
                db_room_id=onboarding_room_id,
                agents=["Onboarding_Manager"],
                created_at=datetime.now().isoformat(),
            )

        for loc_name, room_id in location_room_mappings.items():
            room_key = cls.location_to_room_key(loc_name)
            state.rooms[room_key] = RoomMapping(
                db_room_id=room_id,
                agents=[],
                created_at=datetime.now().isoformat(),
            )

        cls.save_state(world_name, state)
        logger.info(
            f"Rebuilt room mappings for world '{world_name}': "
            f"onboarding={onboarding_room_id is not None}, "
            f"locations={len(location_room_mappings)}"
        )

    @classmethod
    def ensure_room_mapping_exists(
        cls,
        world_name: str,
        room_key: str,
        db_room_id: int,
        agents: Optional[List[str]] = None,
    ) -> bool:
        """Ensure a room mapping exists, creating it if missing.

        Returns True if mapping was created, False if it already existed.
        """
        state = cls.load_state(world_name)

        if room_key in state.rooms:
            if state.rooms[room_key].db_room_id != db_room_id:
                logger.warning(
                    f"Room mapping mismatch for {room_key}: "
                    f"_state.json={state.rooms[room_key].db_room_id}, expected={db_room_id}. "
                    f"Updating."
                )
                state.rooms[room_key].db_room_id = db_room_id
                cls.save_state(world_name, state)
            return False

        state.rooms[room_key] = RoomMapping(
            db_room_id=db_room_id,
            agents=agents or [],
            created_at=datetime.now().isoformat(),
        )
        cls.save_state(world_name, state)
        logger.info(f"Created missing room mapping: {world_name}/{room_key} -> room_id={db_room_id}")
        return True
