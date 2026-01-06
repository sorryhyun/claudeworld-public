"""
Transient state management service.

Handles _state.json operations including suggestions, arrival context, and UI state.
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from domain.entities.world_models import RoomMapping, TransientState

from .world_service import WorldService

logger = logging.getLogger("TransientStateService")


class TransientStateService:
    """Transient runtime state management for worlds."""

    @classmethod
    def load_state(cls, world_name: str) -> TransientState:
        """Load transient runtime state from _state.json.

        Returns an empty TransientState if file doesn't exist.
        Handles backward compatibility with older format (suggestions only).
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

    @classmethod
    def save_suggestions(cls, world_name: str, suggestions: List[str]) -> None:
        """Convenience method to save just suggestions."""
        state = cls.load_state(world_name)
        state.suggestions = suggestions
        cls.save_state(world_name, state)

    @classmethod
    def load_suggestions(cls, world_name: str) -> List[str]:
        """Convenience method to load just suggestions."""
        state = cls.load_state(world_name)
        return state.suggestions

    @classmethod
    def save_arrival_context(
        cls,
        world_name: str,
        previous_narration: str,
        triggering_action: str,
        from_location: str,
    ) -> None:
        """Save arrival context after travel for continuity.

        This context is injected into the first user message at the new location,
        then cleared so it's not repeated.

        Args:
            world_name: Name of the world
            previous_narration: The narration displayed when arriving
            triggering_action: The user action that triggered the travel
            from_location: The location the player came from
        """
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
        """Load and clear arrival context (one-time use).

        Returns the arrival context if it exists, then clears it so it's
        not included in subsequent messages.

        Returns:
            Dict with previous_narration, triggering_action, from_location
            or None if no arrival context
        """
        state = cls.load_state(world_name)
        arrival_context = state.ui.get("arrival_context")

        if arrival_context:
            del state.ui["arrival_context"]
            cls.save_state(world_name, state)
            logger.info(f"Loaded and cleared arrival context for {world_name}")

        return arrival_context

    @classmethod
    def validate_state(cls, world_name: str) -> Dict[str, Any]:
        """Validate _state.json structure and return diagnostic info.

        Returns:
            Dict with validation results:
            - valid: bool
            - errors: List of error messages
            - room_count: Number of room mappings
            - current_room: Current room key (or None)
        """
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
