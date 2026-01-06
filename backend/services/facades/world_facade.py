"""
World facade - FS-first world management.

This facade owns the FS↔DB sync boundary for worlds:
- FS (worlds/{name}/) is the authoritative source
- DB (World, Room, PlayerState) is a cache for queries + real-time features

All world lifecycle operations go through this facade to ensure consistency.
"""

import json
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Optional

import schemas
from domain.entities.world_models import WorldConfig
from domain.services.localization import Localization
from domain.value_objects.enums import Language, WorldPhase
from infrastructure.database import models
from infrastructure.database.connection import serialized_write

from services.location_service import LocationService
from services.player_service import PlayerService
from services.world_service import WorldService

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("WorldFacade")


@dataclass
class WorldSyncResult:
    """Result of FS→DB sync operation."""

    synced: bool
    updates: Dict[str, Any]


@dataclass
class WorldEntryResult:
    """Result of entering a world."""

    world: Any  # models.World
    arrival_message_sent: bool
    room_id: Optional[int]
    lore: str
    stat_definitions: Dict[str, Any]


class WorldFacade:
    """
    FS-first world management facade.

    Centralizes all FS↔DB sync logic for worlds:
    - create_world: Atomic FS + DB creation
    - sync_from_fs: Sync DB cache from FS
    - enter_world: Sync + player init + arrival
    - import_world: Import FS world into DB
    - delete_world: Atomic FS + DB deletion
    - reset_world: Reset to initial state

    Usage:
        facade = WorldFacade(db)
        world = await facade.create_world("MyWorld", "user123", "Hero", Language.KOREAN)
    """

    def __init__(self, db: "AsyncSession"):
        """
        Initialize the facade.

        Args:
            db: Database session for DB operations
        """
        self.db = db

    # =========================================================================
    # Sync Operations
    # =========================================================================

    async def sync_from_fs(self, world: models.World) -> WorldSyncResult:
        """
        Sync DB state from FS (source of truth).

        Syncs: phase, user_name, genre, theme

        Args:
            world: Database world record

        Returns:
            WorldSyncResult with sync status and applied updates
        """
        fs_config = WorldService.load_world_config(world.name)
        if not fs_config:
            logger.warning(f"FS config not found for world '{world.name}'")
            return WorldSyncResult(synced=False, updates={})

        updates = {}

        # Check which fields need syncing
        if fs_config.phase != world.phase:
            logger.info(f"Phase mismatch for {world.name}: DB={world.phase}, FS={fs_config.phase}")
            updates["phase"] = fs_config.phase

        if fs_config.user_name and fs_config.user_name != world.user_name:
            logger.info(f"user_name mismatch for {world.name}: DB={world.user_name}, FS={fs_config.user_name}")
            updates["user_name"] = fs_config.user_name

        if fs_config.genre and fs_config.genre != world.genre:
            logger.info(f"genre mismatch for {world.name}: DB={world.genre}, FS={fs_config.genre}")
            updates["genre"] = fs_config.genre

        if fs_config.theme and fs_config.theme != world.theme:
            logger.info(f"theme mismatch for {world.name}: DB={world.theme}, FS={fs_config.theme}")
            updates["theme"] = fs_config.theme

        # Apply updates if any
        if updates:
            import crud

            await crud.update_world(self.db, world.id, schemas.WorldUpdate(**updates))
            logger.info(f"Synced {len(updates)} fields for world '{world.name}'")

        return WorldSyncResult(synced=bool(updates), updates=updates)

    async def _create_location_from_filesystem(
        self, world_name: str, world_id: int, location_name: str
    ) -> Optional[models.Location]:
        """
        Create a location in the database from filesystem data.

        Args:
            world_name: The world name (directory name in filesystem)
            world_id: The database world ID
            location_name: The location name (directory name in filesystem)

        Returns:
            The created Location model, or None if failed
        """
        import crud

        try:
            # Load location data from filesystem using LocationService
            loc_config = LocationService.load_location(world_name, location_name)
            if not loc_config:
                logger.warning(f"Location '{location_name}' not found in filesystem")
                return None

            # Check for existing room mapping to preserve agents added during onboarding
            room_key = LocationService.location_to_room_key(location_name)
            existing_mapping = LocationService.get_room_mapping(world_name, room_key)
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
                is_draft=loc_config.is_draft,  # Preserve draft status from filesystem
            )

            db_location = await crud.create_location(self.db, world_id, location_create)
            logger.info(f"Created location '{location_name}' in database (id={db_location.id})")

            # Store room mapping in _state.json (preserve existing agents)
            if db_location.room_id:
                LocationService.set_room_mapping(
                    world_name=world_name,
                    room_key=room_key,
                    db_room_id=db_location.room_id,
                    agents=existing_agents,
                )
                logger.info(f"Stored room mapping: {room_key} -> room_id={db_location.room_id}")

                # Add existing agents to the database room
                if existing_agents:
                    added_count = await self._add_agents_to_room(world_name, db_location.room_id, existing_agents)
                    logger.info(f"Added {added_count} character agents to room {db_location.room_id}")

            return db_location

        except Exception as e:
            logger.error(f"Failed to create location '{location_name}' from filesystem: {e}")
            return None

    async def _add_agents_to_room(self, world_name: str, room_id: int, agent_names: list[str]) -> int:
        """
        Add agents by name to a room.

        Args:
            world_name: World name for scoping agent lookup
            room_id: Database room ID
            agent_names: List of agent names to add

        Returns:
            Number of agents successfully added
        """
        import crud
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
                logger.warning(f"Agent '{agent_name}' not found in world '{world_name}'")
        return added

    async def sync_player_state_from_fs(self, world: models.World) -> bool:
        """
        Sync player state from FS to DB.

        Args:
            world: Database world record

        Returns:
            True if synced, False if nothing to sync
        """
        fs_state = PlayerService.load_player_state(world.name)
        if not fs_state or not fs_state.current_location:
            return False

        # Get player state from DB
        import crud

        player_state = await crud.get_player_state(self.db, world.id)
        if not player_state:
            return False

        # Find the location in DB
        location = await crud.get_location_by_name(self.db, world.id, fs_state.current_location)
        if not location:
            # Location doesn't exist in database - create it from filesystem
            logger.info(f"Location '{fs_state.current_location}' not found in DB, creating from filesystem")
            location = await self._create_location_from_filesystem(world.name, world.id, fs_state.current_location)
            if not location:
                logger.warning(f"Could not create location '{fs_state.current_location}' for world '{world.name}'")
                return False

        # Update player state
        player_state.current_location_id = location.id
        player_state.turn_count = fs_state.turn_count
        player_state.stats = json.dumps(fs_state.stats)
        player_state.inventory = json.dumps(fs_state.inventory)
        player_state.effects = json.dumps(fs_state.effects)
        player_state.action_history = json.dumps(fs_state.recent_actions[-10:])

        async with serialized_write():
            await self.db.commit()

        # Update current_room in _state.json to match the player's location
        room_key = LocationService.location_to_room_key(fs_state.current_location)
        LocationService.set_current_room(world.name, room_key)

        logger.info(f"Synced player state from FS for world '{world.name}'")
        return True

    # =========================================================================
    # World Entry
    # =========================================================================

    async def enter_world(self, world_id: int) -> WorldEntryResult:
        """
        Enter an active world.

        This:
        1. Syncs phase/config from FS
        2. Syncs player state if needed
        3. Prepares arrival message info (caller triggers scene)

        Args:
            world_id: World ID

        Returns:
            WorldEntryResult with world data and entry context

        Raises:
            ValueError: If world not found or not active
        """
        import crud

        # Get world
        world = await crud.get_world(self.db, world_id)
        if not world:
            raise ValueError("World not found")

        # Apply any pending phase change (set by onboarding complete tool)
        # This is called here instead of automatically after agent turns,
        # so the phase only changes when user explicitly enters the world
        WorldService.apply_pending_phase(world.name)

        # Sync from FS (will now include the applied phase change)
        await self.sync_from_fs(world)

        # Refresh world after sync
        world = await crud.get_world(self.db, world_id)
        if world.phase != WorldPhase.ACTIVE:
            raise ValueError("World is not ready yet (still in onboarding phase)")

        # Sync player state from FS if DB doesn't have current location
        player_state = await crud.get_player_state(self.db, world_id)
        arrival_message_sent = False
        target_room_id = None

        if player_state and not player_state.current_location_id:
            synced = await self.sync_player_state_from_fs(world)
            if synced:
                # Refresh player state
                player_state = await crud.get_player_state(self.db, world_id)

                # Get room for arrival message
                if player_state and player_state.current_location_id:
                    arrival_location = await crud.get_location(self.db, player_state.current_location_id)
                    if arrival_location and arrival_location.room_id:
                        target_room_id = arrival_location.room_id
                        location_name = arrival_location.display_name or arrival_location.name
                        default_name = "여행자" if world.language == Language.KOREAN else "The traveler"
                        user_name = world.user_name if world.user_name else default_name

                        # Create arrival message
                        arrival_content = Localization.get_arrival_message(user_name, location_name, world.language)
                        arrival_msg = schemas.MessageCreate(
                            content=arrival_content,
                            role="user",
                            participant_type="system",
                            participant_name="System",
                        )
                        await crud.create_message(
                            self.db, arrival_location.room_id, arrival_msg, update_room_activity=True
                        )
                        arrival_message_sent = True
                        logger.info(f"Sent arrival message for '{user_name}' at '{location_name}'")

        # Load lore and stat definitions from FS
        lore = WorldService.load_lore(world.name)
        stat_defs = PlayerService.load_stat_definitions(world.name)

        return WorldEntryResult(
            world=world,
            arrival_message_sent=arrival_message_sent,
            room_id=target_room_id,
            lore=lore,
            stat_definitions=stat_defs,
        )

    # =========================================================================
    # Import Operations
    # =========================================================================

    async def import_world(self, world_name: str, owner_id: str) -> models.World:
        """
        Import a world from filesystem into database.

        Args:
            world_name: Name of the FS world
            owner_id: User ID to own the imported world

        Returns:
            Created World record

        Raises:
            ValueError: If world not found in FS or already exists in DB
        """
        import crud

        # Check FS
        fs_config = WorldService.load_world_config(world_name)
        if not fs_config:
            raise ValueError(f"World '{world_name}' not found in filesystem")

        # Check DB
        existing = await crud.get_world_by_name(self.db, world_name, owner_id)
        if existing:
            raise ValueError(f"World '{world_name}' already exists in database")

        # Import using CRUD (which handles room creation, player state, etc.)
        db_world = await crud.import_world_from_filesystem(self.db, fs_config, owner_id)

        logger.info(f"Imported world '{world_name}' for user '{owner_id}'")
        return db_world

    # =========================================================================
    # Delete Operations
    # =========================================================================

    async def delete_world(self, world_id: int, owner_id: str, is_admin: bool = False) -> bool:
        """
        Delete a world (FS + DB).

        Args:
            world_id: World ID to delete
            owner_id: User ID requesting deletion
            is_admin: Whether requester is admin

        Returns:
            True if deleted

        Raises:
            ValueError: If world not found or not authorized
        """
        import crud

        world = await crud.get_world(self.db, world_id)
        if not world:
            raise ValueError("World not found")
        if world.owner_id != owner_id and not is_admin:
            raise ValueError("Not authorized to delete this world")

        world_name = world.name

        # Log room mappings for debugging
        room_ids = LocationService.get_room_ids_for_world(world_name)
        if room_ids:
            logger.info(f"World '{world_name}' has {len(room_ids)} rooms in _state.json")

        # Delete DB records (CASCADE deletes rooms)
        await crud.delete_world(self.db, world_id)

        # Delete FS data
        WorldService.delete_world(world_name)

        logger.info(f"Deleted world '{world_name}' (FS + DB)")
        return True

    # =========================================================================
    # List Operations
    # =========================================================================

    async def list_importable_worlds(self, owner_id: str) -> List[WorldConfig]:
        """
        List FS worlds that can be imported (not in DB).

        Args:
            owner_id: User ID

        Returns:
            List of importable WorldConfig objects
        """
        import crud

        # Get all FS worlds
        fs_worlds = WorldService.list_worlds()

        # Get DB world names for this user
        db_worlds = await crud.get_worlds_by_owner(self.db, owner_id)
        db_world_names = {w.name for w in db_worlds}

        # Return FS worlds not in DB
        return [w for w in fs_worlds if w.name not in db_world_names]

    # =========================================================================
    # Helper: Build World Response
    # =========================================================================

    def build_world_response(self, world: models.World) -> schemas.World:
        """
        Build a full World response with lore and stat definitions from FS.

        Args:
            world: Database world record

        Returns:
            World schema with lore and stat_definitions populated
        """
        lore = WorldService.load_lore(world.name)
        stat_defs = PlayerService.load_stat_definitions(world.name)

        world_schema = schemas.World.model_validate(world)
        world_schema.lore = lore
        world_schema.stat_definitions = schemas.StatDefinitions(
            stats=[schemas.StatDefinition(**s) for s in stat_defs.get("stats", [])]
        )

        return world_schema
