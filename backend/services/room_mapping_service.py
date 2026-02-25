"""
Room mapping service.

Handles room-to-location mappings in _state.json.
"""

import logging
from datetime import datetime
from typing import Dict, List, Optional

from domain.entities.world_models import RoomMapping

from .transient_state_service import TransientStateService

logger = logging.getLogger("RoomMappingService")


class RoomMappingService:
    """Room-to-location mapping management."""

    @classmethod
    def get_room_id(cls, world_name: str, room_key: str) -> Optional[int]:
        """Get the database room ID for a room key.

        Args:
            world_name: Name of the world
            room_key: Room key (e.g., "onboarding", "location:tavern")

        Returns:
            Database room ID if found, None otherwise
        """
        state = TransientStateService.load_state(world_name)
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
        """Store a room mapping in _state.json.

        Args:
            world_name: Name of the world
            room_key: Room key (e.g., "onboarding", "location:tavern")
            db_room_id: Database room ID
            agents: List of agent names in this room
        """
        state = TransientStateService.load_state(world_name)
        state.rooms[room_key] = RoomMapping(
            db_room_id=db_room_id,
            agents=agents or [],
            created_at=datetime.now().isoformat(),
        )
        TransientStateService.save_state(world_name, state)
        logger.info(f"Set room mapping: {world_name}/{room_key} -> room_id={db_room_id}")

    @classmethod
    def get_room_mapping(cls, world_name: str, room_key: str) -> Optional[RoomMapping]:
        """Get the full room mapping for a room key.

        Args:
            world_name: Name of the world
            room_key: Room key

        Returns:
            RoomMapping if found, None otherwise
        """
        state = TransientStateService.load_state(world_name)
        return state.rooms.get(room_key)

    @classmethod
    def get_all_room_mappings(cls, world_name: str) -> Dict[str, RoomMapping]:
        """Get all room mappings for a world.

        Returns:
            Dict of room_key -> RoomMapping
        """
        state = TransientStateService.load_state(world_name)
        return state.rooms

    @classmethod
    def add_agent_to_room(cls, world_name: str, room_key: str, agent_name: str) -> bool:
        """Add an agent to a room's agent list in _state.json.

        Uses fuzzy matching for location room keys if exact match fails.

        Args:
            world_name: Name of the world
            room_key: Room key
            agent_name: Name of the agent to add

        Returns:
            True if added, False if room not found or agent already present
        """
        state = TransientStateService.load_state(world_name)
        mapping = state.rooms.get(room_key)

        if not mapping and room_key.startswith("location:"):
            location_name = room_key[9:]
            fuzzy_key = cls.find_location_room_key_fuzzy(world_name, location_name)
            if fuzzy_key:
                logger.info(f"Fuzzy matched room key: '{room_key}' -> '{fuzzy_key}'")
                room_key = fuzzy_key
                mapping = state.rooms.get(room_key)

        if not mapping:
            # Auto-create room mapping for location rooms (agent tracking only, no db_room_id yet)
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
        TransientStateService.save_state(world_name, state)
        logger.info(f"Added agent {agent_name} to room {room_key} in world {world_name}")
        return True

    @classmethod
    def remove_agent_from_room(cls, world_name: str, room_key: str, agent_name: str) -> bool:
        """Remove an agent from a room's agent list in _state.json.

        Uses fuzzy matching for location room keys if exact match fails.

        Args:
            world_name: Name of the world
            room_key: Room key
            agent_name: Name of the agent to remove

        Returns:
            True if removed, False if room not found or agent not present
        """
        state = TransientStateService.load_state(world_name)
        mapping = state.rooms.get(room_key)

        if not mapping and room_key.startswith("location:"):
            location_name = room_key[9:]
            fuzzy_key = cls.find_location_room_key_fuzzy(world_name, location_name)
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
        TransientStateService.save_state(world_name, state)
        logger.info(f"Removed agent {agent_name} from room {room_key} in world {world_name}")
        return True

    @classmethod
    def get_current_room(cls, world_name: str) -> Optional[str]:
        """Get the current active room key for a world.

        Returns:
            Current room key, or None if not set
        """
        state = TransientStateService.load_state(world_name)
        return state.current_room

    @classmethod
    def set_current_room(cls, world_name: str, room_key: str) -> None:
        """Set the current active room for a world.

        Args:
            world_name: Name of the world
            room_key: Room key to set as current
        """
        state = TransientStateService.load_state(world_name)
        state.current_room = room_key
        TransientStateService.save_state(world_name, state)
        logger.info(f"Set current room for {world_name} to {room_key}")

    @classmethod
    def get_current_room_id(cls, world_name: str) -> Optional[int]:
        """Get the database room ID for the current active room.

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
        """Convert a location name to a room key.

        Args:
            location_name: Name of the location

        Returns:
            Room key in format "location:{name}"
        """
        return f"location:{location_name}"

    @classmethod
    def find_location_room_key_fuzzy(cls, world_name: str, location_name: str) -> Optional[str]:
        """Find a location room key using fuzzy matching.

        Tries multiple matching strategies in order:
        1. Exact match on the location part of room key in _state.json
        2. Case-insensitive exact match in _state.json
        3. Partial match in _state.json (prefix, contains, reverse contains)
        4. Filesystem fallback: match against folder names and display names from _index.yaml

        Args:
            world_name: Name of the world
            location_name: Location name to search for (can be folder name or display name)

        Returns:
            Matching room key (e.g., "location:tavern") or None
        """
        state = TransientStateService.load_state(world_name)
        search_lower = location_name.lower()

        location_rooms = [k for k in state.rooms.keys() if k.startswith("location:")]

        # 1. Exact match
        exact_key = f"location:{location_name}"
        if exact_key in state.rooms:
            return exact_key

        # 2. Case-insensitive exact match
        for room_key in location_rooms:
            loc_name = room_key[9:]
            if loc_name.lower() == search_lower:
                return room_key

        # 3. Partial matches (prefix, contains, reverse contains)
        for room_key in location_rooms:
            loc_name = room_key[9:]
            if loc_name.lower().startswith(search_lower):
                return room_key

        for room_key in location_rooms:
            loc_name = room_key[9:]
            if search_lower in loc_name.lower():
                return room_key

        for room_key in location_rooms:
            loc_name = room_key[9:]
            if loc_name.lower() in search_lower:
                return room_key

        # 4. Filesystem fallback: check _index.yaml for folder names not yet in _state.json
        from .location_storage import LocationStorage

        fs_locations = LocationStorage.load_all_locations(world_name)
        for folder_name in fs_locations:
            if folder_name.lower() == search_lower or search_lower in folder_name.lower():
                return f"location:{folder_name}"

        return None

    @classmethod
    def room_key_to_location(cls, room_key: str) -> Optional[str]:
        """Extract location name from a room key.

        Args:
            room_key: Room key

        Returns:
            Location name if room key is a location, None otherwise
        """
        if room_key.startswith("location:"):
            return room_key[9:]
        return None

    @classmethod
    def delete_room_mapping(cls, world_name: str, room_key: str) -> bool:
        """Delete a room mapping from _state.json.

        Args:
            world_name: Name of the world
            room_key: Room key to delete

        Returns:
            True if deleted, False if not found
        """
        state = TransientStateService.load_state(world_name)

        if room_key not in state.rooms:
            return False

        del state.rooms[room_key]

        if state.current_room == room_key:
            state.current_room = None

        TransientStateService.save_state(world_name, state)
        logger.info(f"Deleted room mapping {room_key} from world {world_name}")
        return True

    @classmethod
    def get_room_ids_for_world(cls, world_name: str) -> List[int]:
        """Get all database room IDs associated with a world.

        Useful for cleanup when deleting a world.

        Returns:
            List of database room IDs
        """
        state = TransientStateService.load_state(world_name)
        return [mapping.db_room_id for mapping in state.rooms.values()]

    @classmethod
    def rebuild_room_mappings_from_db(
        cls,
        world_name: str,
        onboarding_room_id: Optional[int],
        location_room_mappings: Dict[str, int],
    ) -> None:
        """Rebuild _state.json room mappings from database data.

        Use this when _state.json is corrupted or missing room mappings,
        but the database still has valid room associations.

        Args:
            world_name: Name of the world
            onboarding_room_id: Database ID of the onboarding room
            location_room_mappings: Dict of location_name -> db_room_id
        """
        state = TransientStateService.load_state(world_name)

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

        TransientStateService.save_state(world_name, state)
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
        Useful for recovery scenarios.

        Args:
            world_name: Name of the world
            room_key: Room key
            db_room_id: Database room ID
            agents: List of agent names (only used if creating)

        Returns:
            True if mapping was created, False if it already existed
        """
        state = TransientStateService.load_state(world_name)

        if room_key in state.rooms:
            if state.rooms[room_key].db_room_id != db_room_id:
                logger.warning(
                    f"Room mapping mismatch for {room_key}: "
                    f"_state.json={state.rooms[room_key].db_room_id}, expected={db_room_id}. "
                    f"Updating."
                )
                state.rooms[room_key].db_room_id = db_room_id
                TransientStateService.save_state(world_name, state)
            return False

        state.rooms[room_key] = RoomMapping(
            db_room_id=db_room_id,
            agents=agents or [],
            created_at=datetime.now().isoformat(),
        )
        TransientStateService.save_state(world_name, state)
        logger.info(f"Created missing room mapping: {world_name}/{room_key} -> room_id={db_room_id}")
        return True
