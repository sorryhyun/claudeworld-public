"""
Unit tests for Game CRUD operations.

Tests database operations for World, Location, PlayerState,
and their relationships including cascade delete behavior.
"""

import crud
import pytest
import schemas
from crud.rooms import get_room


class TestWorldCRUD:
    """Tests for World CRUD operations."""

    @pytest.mark.crud
    async def test_create_world(self, test_db):
        """Test creating a world with onboarding room."""
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        assert world.id is not None
        assert world.name == "test_world"
        assert world.owner_id == "admin"
        assert world.phase == "onboarding"
        assert world.onboarding_room_id is not None
        assert world.player_state is not None
        assert world.player_state.turn_count == 0

        # Verify onboarding room has world_id set (for CASCADE delete)
        onboarding_room = await get_room(test_db, world.onboarding_room_id)
        assert onboarding_room.world_id == world.id

    @pytest.mark.crud
    async def test_get_world(self, test_db):
        """Test getting a world by ID."""
        world_data = schemas.WorldCreate(name="test_world")
        created_world = await crud.create_world(test_db, world_data, owner_id="admin")

        world = await crud.get_world(test_db, created_world.id)

        assert world is not None
        assert world.id == created_world.id
        assert world.name == "test_world"

    @pytest.mark.crud
    async def test_get_world_not_found(self, test_db):
        """Test getting a non-existent world."""
        world = await crud.get_world(test_db, 999)
        assert world is None

    @pytest.mark.crud
    async def test_delete_world(self, test_db):
        """Test deleting a world."""
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")
        world_id = world.id

        result = await crud.delete_world(test_db, world_id)
        assert result is True

        # Verify world is deleted
        deleted_world = await crud.get_world(test_db, world_id)
        assert deleted_world is None

    @pytest.mark.crud
    async def test_delete_world_not_found(self, test_db):
        """Test deleting a non-existent world."""
        result = await crud.delete_world(test_db, 999)
        assert result is False

    @pytest.mark.crud
    async def test_delete_world_cascades_to_rooms(self, test_db):
        """Test that deleting a world also deletes associated rooms."""
        # Create world (this also creates an onboarding room)
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        # Store room ID for later verification
        onboarding_room_id = world.onboarding_room_id
        assert onboarding_room_id is not None

        # Verify room exists
        room = await get_room(test_db, onboarding_room_id)
        assert room is not None

        # Delete world
        result = await crud.delete_world(test_db, world.id)
        assert result is True

        # Expire session cache to ensure fresh read
        test_db.expire_all()

        # Verify room was also deleted
        room = await get_room(test_db, onboarding_room_id)
        assert room is None

    @pytest.mark.crud
    async def test_delete_world_cascades_to_location_rooms(self, test_db):
        """Test that deleting a world also deletes location rooms."""
        # Create world
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        # Create a location (this creates a room for it)
        location_data = schemas.LocationCreate(
            name="village",
            display_name="Village",
            description="A small village",
            position_x=0,
            position_y=0,
        )
        location = await crud.create_location(test_db, world.id, location_data)
        location_room_id = location.room_id
        assert location_room_id is not None

        # Verify room exists
        room = await get_room(test_db, location_room_id)
        assert room is not None

        # Delete world
        result = await crud.delete_world(test_db, world.id)
        assert result is True

        # Expire session cache to ensure fresh read
        test_db.expire_all()

        # Verify location room was also deleted
        room = await get_room(test_db, location_room_id)
        assert room is None

    @pytest.mark.crud
    async def test_can_create_world_with_same_name_after_deletion(self, test_db):
        """Test that we can create a new world with the same name after deleting the old one."""
        # Create world
        world_data = schemas.WorldCreate(name="reusable_name")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        # Delete world
        result = await crud.delete_world(test_db, world.id)
        assert result is True

        # Expire session cache
        test_db.expire_all()

        # Create a new world with the same name - this should succeed
        # (the key test is that it doesn't raise UniqueViolation for the room name)
        new_world = await crud.create_world(test_db, world_data, owner_id="admin")
        assert new_world.id is not None
        assert new_world.name == "reusable_name"
        assert new_world.onboarding_room_id is not None

    @pytest.mark.crud
    async def test_update_world(self, test_db):
        """Test updating a world."""
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        update_data = schemas.WorldUpdate(phase="active", genre="fantasy", theme="medieval")
        updated_world = await crud.update_world(test_db, world.id, update_data)

        assert updated_world.phase == "active"
        assert updated_world.genre == "fantasy"
        assert updated_world.theme == "medieval"

    @pytest.mark.crud
    async def test_get_worlds_by_owner(self, test_db):
        """Test getting all worlds by owner."""
        # Create worlds for different owners
        await crud.create_world(test_db, schemas.WorldCreate(name="world1"), owner_id="admin")
        await crud.create_world(test_db, schemas.WorldCreate(name="world2"), owner_id="admin")
        await crud.create_world(test_db, schemas.WorldCreate(name="world3"), owner_id="other")

        # Get admin's worlds
        admin_worlds = await crud.get_worlds_by_owner(test_db, "admin")
        assert len(admin_worlds) == 2

        # Get other's worlds
        other_worlds = await crud.get_worlds_by_owner(test_db, "other")
        assert len(other_worlds) == 1


class TestLocationCRUD:
    """Tests for Location CRUD operations."""

    @pytest.mark.crud
    async def test_create_location(self, test_db):
        """Test creating a location."""
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        location_data = schemas.LocationCreate(
            name="village",
            display_name="Village Square",
            description="A bustling village center",
            position_x=10,
            position_y=20,
        )
        location = await crud.create_location(test_db, world.id, location_data)

        assert location.id is not None
        assert location.name == "village"
        assert location.display_name == "Village Square"
        assert location.room_id is not None

        # Verify location room has world_id set (for CASCADE delete)
        location_room = await get_room(test_db, location.room_id)
        assert location_room.world_id == world.id

    @pytest.mark.crud
    async def test_get_locations(self, test_db):
        """Test getting all locations in a world."""
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        # Create multiple locations
        for i in range(3):
            location_data = schemas.LocationCreate(
                name=f"location_{i}",
                display_name=f"Location {i}",
            )
            await crud.create_location(test_db, world.id, location_data)

        locations = await crud.get_locations(test_db, world.id)
        assert len(locations) == 3


class TestPlayerStateCRUD:
    """Tests for PlayerState CRUD operations."""

    @pytest.mark.crud
    async def test_get_player_state(self, test_db):
        """Test getting player state for a world."""
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        player_state = await crud.get_player_state(test_db, world.id)

        assert player_state is not None
        assert player_state.world_id == world.id
        assert player_state.turn_count == 0

    @pytest.mark.crud
    async def test_increment_turn(self, test_db):
        """Test incrementing the turn counter."""
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        # Increment turn
        turn = await crud.increment_turn(test_db, world.id)
        assert turn == 1

        turn = await crud.increment_turn(test_db, world.id)
        assert turn == 2

    @pytest.mark.crud
    async def test_set_current_location(self, test_db):
        """Test setting the player's current location."""
        world_data = schemas.WorldCreate(name="test_world")
        world = await crud.create_world(test_db, world_data, owner_id="admin")

        # Create a location
        location_data = schemas.LocationCreate(name="village", display_name="Village")
        location = await crud.create_location(test_db, world.id, location_data)

        # Set current location
        player_state = await crud.set_current_location(test_db, world.id, location.id)

        assert player_state.current_location_id == location.id

        # Verify location is marked as current
        updated_location = await crud.get_location(test_db, location.id)
        assert updated_location.is_current is True
        assert updated_location.is_discovered is True
