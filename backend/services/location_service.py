"""
Location and room mapping service.

Handles location CRUD, room mappings, and transient state for worlds.
Locations are treated as chatrooms, so room mappings are consolidated here.
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

import yaml
from domain.entities.world_models import LocationConfig, RoomMapping, TransientState

from .world_service import WorldService

logger = logging.getLogger("LocationService")


class LocationService:
    """Location and room mapping management service."""

    # =========================================================================
    # Location CRUD Methods
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
    ) -> None:
        """Create a new location in the world."""
        world_path = WorldService.get_world_path(world_name)
        location_path = world_path / "locations" / location_name

        # Create location directory
        location_path.mkdir(exist_ok=True)

        # Write description
        with open(location_path / "description.md", "w", encoding="utf-8") as f:
            f.write(f"# {display_name}\n\n{description}\n")

        # Initialize events
        with open(location_path / "events.md", "w", encoding="utf-8") as f:
            f.write(f"# Events at {display_name}\n\n")

        # Update index
        index_file = world_path / "locations" / "_index.yaml"
        with open(index_file, "r", encoding="utf-8") as f:
            index = yaml.safe_load(f) or {"locations": {}}

        index["locations"][location_name] = {
            "name": display_name,
            "label": None,
            "position": list(position),
            "is_discovered": True,
            "adjacent": adjacent or [],
        }

        with open(index_file, "w", encoding="utf-8") as f:
            yaml.dump(index, f, allow_unicode=True, default_flow_style=False)

        logger.info(f"Created location '{location_name}' in world '{world_name}'")

    @classmethod
    def load_location(cls, world_name: str, location_name: str) -> Optional[LocationConfig]:
        """Load a location configuration from filesystem.

        Returns None if location directory doesn't exist (stale entry).
        """
        world_path = WorldService.get_world_path(world_name)
        index_file = world_path / "locations" / "_index.yaml"

        if not index_file.exists():
            return None

        # Check that location directory exists (not a stale entry)
        loc_dir = world_path / "locations" / location_name
        if not loc_dir.is_dir():
            logger.debug(f"Location '{location_name}' directory does not exist - stale entry")
            return None

        with open(index_file, "r", encoding="utf-8") as f:
            index = yaml.safe_load(f) or {"locations": {}}

        loc_data = index.get("locations", {}).get(location_name)
        if not loc_data:
            return None

        # Load description
        description = ""
        desc_file = loc_dir / "description.md"
        if desc_file.exists():
            with open(desc_file, "r", encoding="utf-8") as f:
                description = f.read()

        position = loc_data.get("position", [0, 0])
        return LocationConfig(
            name=location_name,
            display_name=loc_data.get("name", location_name),
            label=loc_data.get("label"),
            position=tuple(position) if isinstance(position, list) else position,
            is_discovered=loc_data.get("is_discovered", True),
            adjacent=loc_data.get("adjacent", []),
            description=description,
        )

    @classmethod
    def load_all_locations(cls, world_name: str) -> Dict[str, LocationConfig]:
        """Load all locations from filesystem.

        Only returns locations that have a corresponding directory on disk.
        Stale entries in _index.yaml without directories are filtered out.
        """
        world_path = WorldService.get_world_path(world_name)
        index_file = world_path / "locations" / "_index.yaml"

        if not index_file.exists():
            return {}

        with open(index_file, "r", encoding="utf-8") as f:
            index = yaml.safe_load(f) or {"locations": {}}

        locations = {}
        for loc_name, loc_data in index.get("locations", {}).items():
            # Only include locations that have a directory on disk
            loc_dir = world_path / "locations" / loc_name
            if not loc_dir.is_dir():
                logger.debug(f"Skipping stale location '{loc_name}' - directory does not exist")
                continue

            # Load description
            description = ""
            desc_file = loc_dir / "description.md"
            if desc_file.exists():
                with open(desc_file, "r", encoding="utf-8") as f:
                    description = f.read()

            position = loc_data.get("position", [0, 0])
            locations[loc_name] = LocationConfig(
                name=loc_name,
                display_name=loc_data.get("name", loc_name),
                label=loc_data.get("label"),
                position=tuple(position) if isinstance(position, list) else position,
                is_discovered=loc_data.get("is_discovered", True),
                adjacent=loc_data.get("adjacent", []),
                description=description,
            )

        return locations

    @classmethod
    def update_location(
        cls,
        world_name: str,
        location_name: str,
        is_discovered: Optional[bool] = None,
        label: Optional[str] = None,
    ) -> bool:
        """
        Update location properties in the index.

        Args:
            world_name: Name of the world
            location_name: Name of the location to update
            is_discovered: New discovered status (optional)
            label: New label (optional)

        Returns:
            True if updated successfully, False if location not found
        """
        world_path = WorldService.get_world_path(world_name)
        index_file = world_path / "locations" / "_index.yaml"

        if not index_file.exists():
            return False

        with open(index_file, "r", encoding="utf-8") as f:
            index = yaml.safe_load(f) or {"locations": {}}

        if location_name not in index.get("locations", {}):
            logger.warning(f"Location '{location_name}' not found in world '{world_name}'")
            return False

        # Update fields if provided
        if is_discovered is not None:
            index["locations"][location_name]["is_discovered"] = is_discovered
        if label is not None:
            index["locations"][location_name]["label"] = label

        with open(index_file, "w", encoding="utf-8") as f:
            yaml.dump(index, f, allow_unicode=True, default_flow_style=False)

        logger.info(f"Updated location '{location_name}' in world '{world_name}'")
        return True

    @classmethod
    def cleanup_stale_entries(cls, world_name: str) -> List[str]:
        """Remove stale entries from _index.yaml that don't have directories.

        Returns:
            List of removed location names
        """
        world_path = WorldService.get_world_path(world_name)
        index_file = world_path / "locations" / "_index.yaml"

        if not index_file.exists():
            return []

        with open(index_file, "r", encoding="utf-8") as f:
            index = yaml.safe_load(f) or {"locations": {}}

        removed = []
        locations = index.get("locations", {})
        valid_locations = {}

        for loc_name, loc_data in locations.items():
            loc_dir = world_path / "locations" / loc_name
            if loc_dir.is_dir():
                valid_locations[loc_name] = loc_data
            else:
                removed.append(loc_name)
                logger.info(f"Removing stale location '{loc_name}' from _index.yaml")

        if removed:
            index["locations"] = valid_locations
            with open(index_file, "w", encoding="utf-8") as f:
                yaml.dump(index, f, allow_unicode=True, default_flow_style=False)

        return removed

    @classmethod
    def load_location_events(cls, world_name: str, location_name: str) -> str:
        """
        Load events.md content for a location.

        Returns empty string if file doesn't exist.
        """
        world_path = WorldService.get_world_path(world_name)
        events_file = world_path / "locations" / location_name / "events.md"

        if not events_file.exists():
            return ""

        try:
            return events_file.read_text(encoding="utf-8").strip()
        except Exception as e:
            logger.warning(f"Failed to load events.md for {location_name}: {e}")
            return ""

    @classmethod
    def add_location_event(cls, world_name: str, location_name: str, turn: int, event: str) -> None:
        """Add an event to a location's history."""
        world_path = WorldService.get_world_path(world_name)
        events_file = world_path / "locations" / location_name / "events.md"

        if not events_file.exists():
            return

        # Load existing events
        with open(events_file, "r", encoding="utf-8") as f:
            content = f.read()

        # Append new event
        content += f"\n## Turn {turn}\n{event}\n"

        with open(events_file, "w", encoding="utf-8") as f:
            f.write(content)

    # =========================================================================
    # Transient State Methods
    # =========================================================================

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

            # Parse room mappings
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

        # Serialize room mappings
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

    # =========================================================================
    # Arrival Context Methods (for travel continuity)
    # =========================================================================

    @classmethod
    def save_arrival_context(
        cls,
        world_name: str,
        previous_narration: str,
        triggering_action: str,
        from_location: str,
    ) -> None:
        """
        Save arrival context after travel for continuity.

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
        """
        Load and clear arrival context (one-time use).

        Returns the arrival context if it exists, then clears it so it's
        not included in subsequent messages.

        Returns:
            Dict with previous_narration, triggering_action, from_location
            or None if no arrival context
        """
        state = cls.load_state(world_name)
        arrival_context = state.ui.get("arrival_context")

        if arrival_context:
            # Clear it after reading
            del state.ui["arrival_context"]
            cls.save_state(world_name, state)
            logger.info(f"Loaded and cleared arrival context for {world_name}")

        return arrival_context

    # =========================================================================
    # Room Mapping Methods
    # =========================================================================

    @classmethod
    def get_room_id(cls, world_name: str, room_key: str) -> Optional[int]:
        """
        Get the database room ID for a room key.

        Args:
            world_name: Name of the world
            room_key: Room key (e.g., "onboarding", "location:tavern")

        Returns:
            Database room ID if found, None otherwise
        """
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
        """
        Store a room mapping in _state.json.

        Args:
            world_name: Name of the world
            room_key: Room key (e.g., "onboarding", "location:tavern")
            db_room_id: Database room ID
            agents: List of agent names in this room
        """
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
        """
        Get the full room mapping for a room key.

        Args:
            world_name: Name of the world
            room_key: Room key

        Returns:
            RoomMapping if found, None otherwise
        """
        state = cls.load_state(world_name)
        return state.rooms.get(room_key)

    @classmethod
    def get_all_room_mappings(cls, world_name: str) -> Dict[str, RoomMapping]:
        """
        Get all room mappings for a world.

        Returns:
            Dict of room_key -> RoomMapping
        """
        state = cls.load_state(world_name)
        return state.rooms

    @classmethod
    def add_agent_to_room(cls, world_name: str, room_key: str, agent_name: str) -> bool:
        """
        Add an agent to a room's agent list in _state.json.

        Uses fuzzy matching for location room keys if exact match fails.

        Args:
            world_name: Name of the world
            room_key: Room key
            agent_name: Name of the agent to add

        Returns:
            True if added, False if room not found or agent already present
        """
        state = cls.load_state(world_name)
        mapping = state.rooms.get(room_key)

        # Try fuzzy match for location rooms if exact match fails
        if not mapping and room_key.startswith("location:"):
            location_name = room_key[9:]  # len("location:") = 9
            fuzzy_key = cls.find_location_room_key_fuzzy(world_name, location_name)
            if fuzzy_key:
                logger.info(f"Fuzzy matched room key: '{room_key}' -> '{fuzzy_key}'")
                room_key = fuzzy_key
                mapping = state.rooms.get(room_key)

        if not mapping:
            logger.warning(f"Room {room_key} not found in world {world_name}")
            return False

        if agent_name in mapping.agents:
            return False  # Already present

        mapping.agents.append(agent_name)
        cls.save_state(world_name, state)
        logger.info(f"Added agent {agent_name} to room {room_key} in world {world_name}")
        return True

    @classmethod
    def remove_agent_from_room(cls, world_name: str, room_key: str, agent_name: str) -> bool:
        """
        Remove an agent from a room's agent list in _state.json.

        Uses fuzzy matching for location room keys if exact match fails.

        Args:
            world_name: Name of the world
            room_key: Room key
            agent_name: Name of the agent to remove

        Returns:
            True if removed, False if room not found or agent not present
        """
        state = cls.load_state(world_name)
        mapping = state.rooms.get(room_key)

        # Try fuzzy match for location rooms if exact match fails
        if not mapping and room_key.startswith("location:"):
            location_name = room_key[9:]  # len("location:") = 9
            fuzzy_key = cls.find_location_room_key_fuzzy(world_name, location_name)
            if fuzzy_key:
                logger.info(f"Fuzzy matched room key: '{room_key}' -> '{fuzzy_key}'")
                room_key = fuzzy_key
                mapping = state.rooms.get(room_key)

        if not mapping:
            logger.warning(f"Room {room_key} not found in world {world_name}")
            return False

        if agent_name not in mapping.agents:
            return False  # Not present

        mapping.agents.remove(agent_name)
        cls.save_state(world_name, state)
        logger.info(f"Removed agent {agent_name} from room {room_key} in world {world_name}")
        return True

    @classmethod
    def get_current_room(cls, world_name: str) -> Optional[str]:
        """
        Get the current active room key for a world.

        Returns:
            Current room key, or None if not set
        """
        state = cls.load_state(world_name)
        return state.current_room

    @classmethod
    def set_current_room(cls, world_name: str, room_key: str) -> None:
        """
        Set the current active room for a world.

        Args:
            world_name: Name of the world
            room_key: Room key to set as current
        """
        state = cls.load_state(world_name)
        state.current_room = room_key
        cls.save_state(world_name, state)
        logger.info(f"Set current room for {world_name} to {room_key}")

    @classmethod
    def get_current_room_id(cls, world_name: str) -> Optional[int]:
        """
        Get the database room ID for the current active room.

        Convenience method combining get_current_room and get_room_id.

        Returns:
            Database room ID if current room is set and mapped, None otherwise
        """
        current = cls.get_current_room(world_name)
        if not current:
            return None
        return cls.get_room_id(world_name, current)

    @classmethod
    def location_to_room_key(cls, location_name: str) -> str:
        """
        Convert a location name to a room key.

        Args:
            location_name: Name of the location

        Returns:
            Room key in format "location:{name}"
        """
        return f"location:{location_name}"

    @classmethod
    def find_location_room_key_fuzzy(cls, world_name: str, location_name: str) -> Optional[str]:
        """
        Find a location room key using fuzzy matching.

        Tries multiple matching strategies in order:
        1. Exact match on the location part of room key
        2. Case-insensitive exact match
        3. Prefix match (room key location starts with search term)
        4. Contains match (room key location contains search term)
        5. Reverse contains (search term contains room key location)

        Args:
            world_name: Name of the world
            location_name: Location name to search for (can be partial)

        Returns:
            Matching room key (e.g., "location:tavern") or None
        """
        state = cls.load_state(world_name)
        search_lower = location_name.lower()

        # Get all location room keys
        location_rooms = [k for k in state.rooms.keys() if k.startswith("location:")]

        # 1. Try exact match
        exact_key = f"location:{location_name}"
        if exact_key in state.rooms:
            return exact_key

        # 2. Try case-insensitive exact match
        for room_key in location_rooms:
            loc_name = room_key[9:]  # len("location:") = 9
            if loc_name.lower() == search_lower:
                return room_key

        # 3. Try prefix match (room key location starts with search term)
        for room_key in location_rooms:
            loc_name = room_key[9:]
            if loc_name.lower().startswith(search_lower):
                return room_key

        # 4. Try contains match (room key location contains search term)
        for room_key in location_rooms:
            loc_name = room_key[9:]
            if search_lower in loc_name.lower():
                return room_key

        # 5. Try reverse contains (search term contains room key location)
        # This handles cases like search="2학년 3반 교실" matching room_key="location:교실"
        for room_key in location_rooms:
            loc_name = room_key[9:]
            if loc_name.lower() in search_lower:
                return room_key

        return None

    @classmethod
    def room_key_to_location(cls, room_key: str) -> Optional[str]:
        """
        Extract location name from a room key.

        Args:
            room_key: Room key

        Returns:
            Location name if room key is a location, None otherwise
        """
        if room_key.startswith("location:"):
            return room_key[9:]  # len("location:") = 9
        return None

    @classmethod
    def delete_room_mapping(cls, world_name: str, room_key: str) -> bool:
        """
        Delete a room mapping from _state.json.

        Args:
            world_name: Name of the world
            room_key: Room key to delete

        Returns:
            True if deleted, False if not found
        """
        state = cls.load_state(world_name)

        if room_key not in state.rooms:
            return False

        del state.rooms[room_key]

        # Clear current_room if it was the deleted room
        if state.current_room == room_key:
            state.current_room = None

        cls.save_state(world_name, state)
        logger.info(f"Deleted room mapping {room_key} from world {world_name}")
        return True

    @classmethod
    def get_room_ids_for_world(cls, world_name: str) -> List[int]:
        """
        Get all database room IDs associated with a world.

        Useful for cleanup when deleting a world.

        Returns:
            List of database room IDs
        """
        state = cls.load_state(world_name)
        return [mapping.db_room_id for mapping in state.rooms.values()]

    # =========================================================================
    # Recovery Methods
    # =========================================================================

    @classmethod
    def rebuild_room_mappings_from_db(
        cls,
        world_name: str,
        onboarding_room_id: Optional[int],
        location_room_mappings: Dict[str, int],
    ) -> None:
        """
        Rebuild _state.json room mappings from database data.

        Use this when _state.json is corrupted or missing room mappings,
        but the database still has valid room associations.

        Args:
            world_name: Name of the world
            onboarding_room_id: Database ID of the onboarding room
            location_room_mappings: Dict of location_name -> db_room_id
        """
        state = cls.load_state(world_name)

        # Clear existing room mappings
        state.rooms = {}

        # Add onboarding room
        if onboarding_room_id:
            state.rooms["onboarding"] = RoomMapping(
                db_room_id=onboarding_room_id,
                agents=["Onboarding_Manager"],
                created_at=datetime.now().isoformat(),
            )

        # Add location rooms
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
        """
        Ensure a room mapping exists, creating it if missing.

        Returns True if mapping was created, False if it already existed.
        Useful for recovery scenarios.

        Args:
            world_name: Name of the world
            room_key: Room key
            db_room_id: Database room ID
            agents: List of agent names (only used if creating)

        Returns:
            True if mapping was created, False if it already existed
        """
        state = cls.load_state(world_name)

        if room_key in state.rooms:
            # Mapping exists, verify it's correct
            if state.rooms[room_key].db_room_id != db_room_id:
                logger.warning(
                    f"Room mapping mismatch for {room_key}: "
                    f"_state.json={state.rooms[room_key].db_room_id}, expected={db_room_id}. "
                    f"Updating."
                )
                state.rooms[room_key].db_room_id = db_room_id
                cls.save_state(world_name, state)
            return False

        # Create new mapping
        state.rooms[room_key] = RoomMapping(
            db_room_id=db_room_id,
            agents=agents or [],
            created_at=datetime.now().isoformat(),
        )
        cls.save_state(world_name, state)
        logger.info(f"Created missing room mapping: {world_name}/{room_key} -> room_id={db_room_id}")
        return True

    @classmethod
    def validate_state(cls, world_name: str) -> Dict[str, Any]:
        """
        Validate _state.json structure and return diagnostic info.

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

            # Check current_room is valid
            if state.current_room and state.current_room not in state.rooms:
                result["valid"] = False
                result["errors"].append(f"current_room '{state.current_room}' not found in rooms")

            # Check room mappings have valid db_room_ids
            for room_key, mapping in state.rooms.items():
                if not mapping.db_room_id or mapping.db_room_id <= 0:
                    result["valid"] = False
                    result["errors"].append(f"Room '{room_key}' has invalid db_room_id: {mapping.db_room_id}")

        except Exception as e:
            result["valid"] = False
            result["errors"].append(f"Failed to load _state.json: {e}")

        return result
