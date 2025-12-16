"""
Persistence Manager - Unified interface for world initialization and sync.

This module provides a single point of access for:
1. World initialization (syncing filesystem content to database)
2. Creating locations (requires both filesystem and database)
3. Exporting database state back to filesystem (for backups)

Runtime state operations (stats, inventory, location changes) go directly
through crud.game.* to the database only.
"""

import json
import logging
from typing import Optional

import crud
import schemas
from sqlalchemy.ext.asyncio import AsyncSession

from services.location_service import LocationService
from services.player_service import PlayerService
from services.world_service import WorldService

logger = logging.getLogger("PersistenceManager")


class PersistenceManager:
    """
    Manages synchronized persistence for world initialization and export.

    This class handles:
    - Initial sync from filesystem to database (during onboarding→active transition)
    - Creating locations (requires both FS + DB)
    - Exporting database state to filesystem (for backup/portability)

    Runtime state changes (stats, inventory, travel) should use crud.game.* directly.
    """

    def __init__(self, db: AsyncSession, world_id: int, world_name: str):
        """
        Initialize the persistence manager.

        Args:
            db: Async database session
            world_id: Database ID of the world
            world_name: Filesystem name of the world (used for WorldService)
        """
        self.db = db
        self.world_id = world_id
        self.world_name = world_name

    # =========================================================================
    # Initialization Methods (Filesystem → Database)
    # =========================================================================

    async def create_location(
        self,
        name: str,
        display_name: str,
        description: str,
        position: tuple[int, int],
        adjacent_hints: Optional[list[str]] = None,
        is_starting: bool = False,
        agents: Optional[list[str]] = None,
    ) -> int:
        """
        Create a location in both filesystem and database.

        This is used during world seeding when new locations are created.

        Args:
            name: Internal location name (used as key/path)
            display_name: Human-readable display name
            description: Location description
            position: (x, y) position on the map
            adjacent_hints: List of adjacent location names (filesystem)
            is_starting: Whether this is the starting location
            agents: List of agent names at this location

        Returns:
            Database ID of the created location
        """
        # 1. Create in filesystem (source of truth)
        LocationService.create_location(
            self.world_name,
            name,
            display_name,
            description,
            position,
            adjacent=adjacent_hints,
        )
        logger.info(f"Created location '{name}' in filesystem")

        # 2. Create in database (includes room creation for messages)
        location_create = schemas.LocationCreate(
            name=name,
            display_name=display_name,
            description=description,
            position_x=position[0],
            position_y=position[1],
            adjacent_to=None,  # Will be linked later if needed
            is_discovered=True,
        )
        db_location = await crud.create_location(self.db, self.world_id, location_create)
        logger.info(f"Created location '{name}' in database (id={db_location.id}, room_id={db_location.room_id})")

        # 3. Store room mapping in _state.json (FS-first architecture)
        if db_location.room_id:
            room_key = LocationService.location_to_room_key(name)
            LocationService.set_room_mapping(
                world_name=self.world_name,
                room_key=room_key,
                db_room_id=db_location.room_id,
                agents=agents or [],
            )
            logger.info(f"Stored room mapping: {room_key} -> room_id={db_location.room_id}")

        # 4. If starting location, set as current location and room
        if is_starting:
            await crud.set_current_location(self.db, self.world_id, db_location.id)
            room_key = LocationService.location_to_room_key(name)
            LocationService.set_current_room(self.world_name, room_key)
            logger.info(f"Set '{name}' as current location and room")

        return db_location.id

    async def sync_player_state_from_filesystem(self) -> None:
        """
        Sync player state from filesystem to database.

        This is useful after WorldSeedManager runs, to ensure database
        reflects the filesystem state during onboarding→active transition.
        """
        # Load state from filesystem
        fs_state = PlayerService.load_player_state(self.world_name)
        if not fs_state:
            logger.warning(f"No player state found in filesystem for world '{self.world_name}'")
            return

        # Get database player state
        db_state = await crud.get_player_state(self.db, self.world_id)
        if not db_state:
            logger.warning(f"No player state found in database for world_id={self.world_id}")
            return

        # Sync stats
        if fs_state.stats:
            await crud.initialize_player_stats(
                self.db,
                self.world_id,
                {"stats": [{"name": k, "default": v} for k, v in fs_state.stats.items()]},
                initial_stats=fs_state.stats,
            )
            logger.info(f"Synced {len(fs_state.stats)} stats to database")

        # Sync inventory
        if fs_state.inventory:
            for item in fs_state.inventory:
                await crud.add_inventory_item(
                    self.db,
                    self.world_id,
                    schemas.InventoryItem(
                        id=item.get("item_id", item.get("id", "")),
                        name=item.get("name", ""),
                        description=item.get("description", ""),
                        quantity=item.get("quantity", 1),
                        properties=item.get("properties"),
                    ),
                )
            logger.info(f"Synced {len(fs_state.inventory)} inventory items to database")

        # Sync current location (need to find or create location)
        if fs_state.current_location:
            locations = await crud.get_locations(self.db, self.world_id)
            location = next(
                (loc for loc in locations if loc.name == fs_state.current_location),
                None,
            )

            if not location:
                # Location doesn't exist in database - create it from filesystem
                location = await self._create_location_from_filesystem(fs_state.current_location)

            if location:
                await crud.set_current_location(self.db, self.world_id, location.id)
                logger.info(f"Synced current_location to '{fs_state.current_location}' (id={location.id})")
            else:
                logger.warning(f"Could not create location '{fs_state.current_location}' from filesystem")

    async def _create_location_from_filesystem(self, location_name: str):
        """
        Create a location in the database from filesystem data.

        Args:
            location_name: The location name (directory name in filesystem)

        Returns:
            The created Location model, or None if failed
        """
        try:
            # Load location data from filesystem using LocationService
            loc_config = LocationService.load_location(self.world_name, location_name)
            if not loc_config:
                logger.warning(f"Location '{location_name}' not found in filesystem")
                return None

            # Check for existing room mapping to preserve agents added during onboarding
            room_key = LocationService.location_to_room_key(location_name)
            existing_mapping = LocationService.get_room_mapping(self.world_name, room_key)
            existing_agents = existing_mapping.agents if existing_mapping else []

            # Create location in database
            position = loc_config.position if isinstance(loc_config.position, tuple) else (0, 0)
            location_create = schemas.LocationCreate(
                name=location_name,
                display_name=loc_config.display_name,
                description=loc_config.description or "",
                position_x=position[0],
                position_y=position[1],
                adjacent_to=None,
                is_discovered=loc_config.is_discovered,
            )

            db_location = await crud.create_location(self.db, self.world_id, location_create)
            logger.info(f"Created location '{location_name}' in database (id={db_location.id})")

            # Store room mapping in _state.json (preserve existing agents)
            if db_location.room_id:
                LocationService.set_room_mapping(
                    world_name=self.world_name,
                    room_key=room_key,
                    db_room_id=db_location.room_id,
                    agents=existing_agents,
                )
                logger.info(f"Stored room mapping: {room_key} -> room_id={db_location.room_id}")

                # Add existing agents to the database room
                if existing_agents:
                    added_count = await self._add_agents_to_room(db_location.room_id, existing_agents)
                    logger.info(f"Added {added_count} character agents to room {db_location.room_id}")

            return db_location

        except Exception as e:
            logger.error(f"Failed to create location '{location_name}' from filesystem: {e}")
            return None

    async def _add_agents_to_room(self, room_id: int, agent_names: list[str]) -> int:
        """
        Add agents by name to a room.

        Args:
            room_id: Database room ID
            agent_names: List of agent names to add

        Returns:
            Number of agents successfully added
        """
        from crud.room_agents import add_agent_to_room

        added = 0
        for agent_name in agent_names:
            # Look up agent by exact name
            agent = await crud.get_agent_by_name(self.db, agent_name)
            if agent:
                await add_agent_to_room(self.db, room_id, agent.id)
                added += 1
                logger.debug(f"Added agent '{agent_name}' to room {room_id}")
            else:
                logger.warning(f"Agent '{agent_name}' not found in world '{self.world_name}'")
        return added

    async def save_stat_definitions(self, stat_definitions: dict) -> None:
        """
        Save stat definitions to both database and filesystem.

        This is used during world seeding.

        Args:
            stat_definitions: Dict with "stats" list and optional "derived" list
        """
        # 1. Save to filesystem
        PlayerService.save_stat_definitions(self.world_name, stat_definitions)
        logger.info(f"Saved stat definitions to filesystem for world '{self.world_name}'")

        # 2. Save to database
        await crud.update_world(
            self.db,
            self.world_id,
            schemas.WorldUpdate(stat_definitions=stat_definitions),
        )
        logger.info(f"Saved stat definitions to database for world_id={self.world_id}")

    async def update_world_phase(self, phase: str) -> None:
        """
        Update world phase in both database and filesystem.

        Args:
            phase: New phase ("onboarding", "active", "ended")
        """
        # 1. Update filesystem
        config = WorldService.load_world_config(self.world_name)
        if config:
            config.phase = phase
            WorldService.save_world_config(self.world_name, config)
            logger.info(f"Set phase='{phase}' in filesystem")
        else:
            logger.warning(f"Could not load world config for '{self.world_name}' to update phase")

        # 2. Update database
        await crud.update_world(self.db, self.world_id, schemas.WorldUpdate(phase=phase))
        logger.info(f"Set phase='{phase}' in database")

    async def sync_stats(self, stats: dict[str, int]) -> None:
        """
        Initialize stats in database from filesystem state.

        Used during world seeding to populate initial stats.

        Args:
            stats: Dictionary of stat_name -> value
        """
        await crud.initialize_player_stats(
            self.db,
            self.world_id,
            {"stats": [{"name": k, "default": v} for k, v in stats.items()]},
            initial_stats=stats,
        )
        logger.info(f"Synced {len(stats)} stats to database")

    # =========================================================================
    # Export Methods (Database → Filesystem)
    # =========================================================================

    async def export_state_to_filesystem(self) -> None:
        """
        Export current database state to filesystem.

        This allows creating backups or portable world exports.
        Exports: player state (stats, inventory, location), locations.
        """
        # Get current state from database
        player_state = await crud.get_player_state(self.db, self.world_id)
        locations = await crud.get_locations(self.db, self.world_id)

        if not player_state:
            logger.warning(f"No player state to export for world_id={self.world_id}")
            return

        # Build filesystem player state
        fs_state = PlayerService.load_player_state(self.world_name)
        if not fs_state:
            # Create new state if it doesn't exist
            from domain.entities.world_models import PlayerState

            fs_state = PlayerState(
                current_location=None,
                turn_count=0,
                stats={},
                inventory=[],
                effects=[],
                recent_actions=[],
            )

        # Update from database
        fs_state.turn_count = player_state.turn_count

        # Parse stats from JSON
        if player_state.stats:
            fs_state.stats = json.loads(player_state.stats)

        # Parse inventory from JSON
        if player_state.inventory:
            fs_state.inventory = json.loads(player_state.inventory)

        # Set current location name
        if player_state.current_location:
            fs_state.current_location = player_state.current_location.name

        # Save to filesystem
        PlayerService.save_player_state(self.world_name, fs_state)
        logger.info(f"Exported player state to filesystem for world '{self.world_name}'")

        # Export location discovered status
        for location in locations:
            loc_config = LocationService.load_location(self.world_name, location.name)
            if loc_config and loc_config.is_discovered != location.is_discovered:
                # Update filesystem location with discovered status
                LocationService.update_location(
                    self.world_name,
                    location.name,
                    is_discovered=location.is_discovered,
                    label=location.label,
                )

        logger.info(f"Exported {len(locations)} locations to filesystem")
