"""
Unit tests for BackgroundScheduler.

Tests background processing of autonomous agent conversations.
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest
from infrastructure.scheduler import BackgroundScheduler


class SessionFactory:
    """Helper to track async session creation and closure."""

    def __init__(self):
        self.created = 0
        self.closed = 0
        self.sessions = []

    async def __call__(self):
        self.created += 1
        session = AsyncMock()
        self.sessions.append(session)
        try:
            yield session
        finally:
            self.closed += 1


class TestBackgroundSchedulerInit:
    """Tests for BackgroundScheduler initialization."""

    def test_init(self):
        """Test initialization."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)

        assert scheduler.chat_orchestrator == mock_orchestrator
        assert scheduler.agent_manager == mock_agent_manager
        assert scheduler.get_db_session == mock_get_db
        assert scheduler.max_concurrent_rooms == 5
        assert scheduler.is_running is False
        assert scheduler.scheduler is not None


class TestBackgroundSchedulerStart:
    """Tests for start method."""

    def test_start_scheduler(self):
        """Test starting the scheduler."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)

        with (
            patch.object(scheduler.scheduler, "start") as mock_start,
            patch.object(scheduler.scheduler, "add_job") as mock_add_job,
        ):
            scheduler.start()

            # Should add two jobs (process rooms + cleanup cache) and start scheduler
            assert mock_add_job.call_count == 2
            mock_start.assert_called_once()

            assert scheduler.is_running is True

    def test_start_scheduler_already_running(self):
        """Test that starting already-running scheduler is idempotent."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)
        scheduler.is_running = True

        with patch.object(scheduler.scheduler, "start") as mock_start:
            scheduler.start()

            # Should not start again
            mock_start.assert_not_called()


class TestBackgroundSchedulerStop:
    """Tests for stop method."""

    def test_stop_scheduler(self):
        """Test stopping the scheduler."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)
        scheduler.is_running = True

        with patch.object(scheduler.scheduler, "shutdown") as mock_shutdown:
            scheduler.stop()

            # Should shutdown scheduler
            mock_shutdown.assert_called_once()
            assert scheduler.is_running is False

    def test_stop_scheduler_not_running(self):
        """Test stopping already-stopped scheduler."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)
        scheduler.is_running = False

        with patch.object(scheduler.scheduler, "shutdown") as mock_shutdown:
            scheduler.stop()

            # Should not shutdown again
            mock_shutdown.assert_not_called()


class TestGetActiveRooms:
    """Tests for _get_active_rooms method."""

    @pytest.mark.asyncio
    async def test_get_active_rooms_with_multi_agent_rooms(self):
        """Test getting active rooms with multiple agents."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)

        # Mock database response
        mock_db = AsyncMock()
        mock_agent1 = Mock()
        mock_agent2 = Mock()
        mock_room = Mock(id=1, is_paused=False, agents=[mock_agent1, mock_agent2])

        mock_result = Mock()
        mock_result.scalars.return_value.all.return_value = [mock_room]
        mock_db.execute.return_value = mock_result

        active_rooms = await scheduler._get_active_rooms(mock_db)

        # Should return room with 2+ agents
        assert len(active_rooms) == 1
        assert active_rooms[0].id == 1

    @pytest.mark.asyncio
    async def test_get_active_rooms_filters_single_agent_rooms(self):
        """Test that single-agent rooms are filtered out."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)

        mock_db = AsyncMock()
        mock_agent = Mock()
        mock_room = Mock(id=1, agents=[mock_agent])  # Only 1 agent

        mock_result = Mock()
        mock_result.scalars.return_value.all.return_value = [mock_room]
        mock_db.execute.return_value = mock_result

        active_rooms = await scheduler._get_active_rooms(mock_db)

        # Should filter out single-agent room
        assert len(active_rooms) == 0


class TestCleanupCompletedTasks:
    """Tests for _cleanup_completed_tasks method."""

    def test_cleanup_completed_tasks(self):
        """Test cleaning up completed tasks."""
        mock_orchestrator = Mock()
        mock_orchestrator.active_room_tasks = {
            1: Mock(done=Mock(return_value=True)),
            2: Mock(done=Mock(return_value=False)),
            3: Mock(done=Mock(return_value=True)),
        }
        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)

        scheduler._cleanup_completed_tasks()

        # Should remove completed tasks (1 and 3)
        assert 1 not in mock_orchestrator.active_room_tasks
        assert 2 in mock_orchestrator.active_room_tasks
        assert 3 not in mock_orchestrator.active_room_tasks


class TestProcessRoomAutonomousRound:
    """Tests for _process_room_autonomous_round method.

    Note: _process_room_autonomous_round now delegates to ChatOrchestrator.process_autonomous_round().
    These tests verify proper delegation and cleanup behavior.
    """

    @pytest.mark.asyncio
    async def test_process_room_autonomous_round_delegates_to_orchestrator(self):
        """Test that processing delegates to ChatOrchestrator."""
        mock_orchestrator = Mock()
        mock_orchestrator.active_room_tasks = {}
        mock_orchestrator.process_autonomous_round = AsyncMock()

        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)

        mock_db = AsyncMock()
        mock_room = Mock(id=1, name="Test Room")

        await scheduler._process_room_autonomous_round(mock_db, mock_room)

        # Should delegate to orchestrator
        mock_orchestrator.process_autonomous_round.assert_awaited_once_with(
            db=mock_db,
            room=mock_room,
            agent_manager=mock_agent_manager,
        )

    @pytest.mark.asyncio
    async def test_process_room_cleans_up_completed_tasks(self):
        """Test that completed tasks are cleaned up before processing."""
        mock_orchestrator = Mock()
        mock_orchestrator.active_room_tasks = {
            1: Mock(done=Mock(return_value=True)),  # Completed
            2: Mock(done=Mock(return_value=False)),  # Still running
        }
        mock_orchestrator.process_autonomous_round = AsyncMock()

        mock_agent_manager = Mock()
        mock_get_db = Mock()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, mock_get_db)

        mock_db = AsyncMock()
        mock_room = Mock(id=3, name="Test Room")

        await scheduler._process_room_autonomous_round(mock_db, mock_room)

        # Completed task (1) should be cleaned up
        assert 1 not in mock_orchestrator.active_room_tasks
        # Running task (2) should remain
        assert 2 in mock_orchestrator.active_room_tasks


class TestProcessActiveRooms:
    """Tests for _process_active_rooms method."""

    @pytest.mark.asyncio
    async def test_process_active_rooms_with_no_rooms(self):
        """Test processing when no active rooms."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        session_factory = SessionFactory()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, session_factory)

        with (
            patch.object(scheduler, "_get_active_rooms", return_value=[]),
            patch.object(scheduler, "_process_room_autonomous_round", new=AsyncMock()) as mock_process,
        ):
            await scheduler._process_active_rooms()

            # Should not process any rooms
            mock_process.assert_not_awaited()
            assert session_factory.created == 1
            assert session_factory.closed == 1

    @pytest.mark.asyncio
    async def test_process_active_rooms_with_multiple_rooms(self):
        """Test processing multiple active rooms concurrently."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        session_factory = SessionFactory()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, session_factory)

        mock_rooms = [
            Mock(id=1, max_interactions=None),
            Mock(id=2, max_interactions=None),
            Mock(id=3, max_interactions=None),
        ]

        with (
            patch.object(scheduler, "_get_active_rooms", return_value=mock_rooms),
            patch.object(scheduler, "_process_room_autonomous_round", new=AsyncMock()) as mock_process,
        ):
            await scheduler._process_active_rooms()

            # Should process all rooms
            assert mock_process.await_count == 3
            # One session for room discovery, one per room
            assert session_factory.created == 4
            assert session_factory.closed == 4
            # Ensure each room uses its own session (after the first discovery session)
            discovery_session = session_factory.sessions[0]
            room_sessions = session_factory.sessions[1:]
            for call, room_session in zip(mock_process.await_args_list, room_sessions):
                assert call.args[0] is room_session
                assert call.args[0] is not discovery_session

    @pytest.mark.asyncio
    async def test_process_active_rooms_handles_errors(self):
        """Test that errors in one room don't affect others."""
        mock_orchestrator = Mock()
        mock_agent_manager = Mock()
        session_factory = SessionFactory()

        scheduler = BackgroundScheduler(mock_orchestrator, mock_agent_manager, session_factory)

        mock_rooms = [Mock(id=1, max_interactions=None), Mock(id=2, max_interactions=None)]

        # First room raises error, second succeeds
        async def mock_process_room(db, room):
            if room.id == 1:
                raise Exception("Processing error")

        with (
            patch.object(scheduler, "_get_active_rooms", return_value=mock_rooms),
            patch.object(scheduler, "_process_room_autonomous_round", side_effect=mock_process_room) as mock_process,
        ):
            # Should not raise exception
            await scheduler._process_active_rooms()

            assert session_factory.created == 3
            assert session_factory.closed == 3
            assert mock_process.await_count == 2
