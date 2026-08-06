"""
Unit tests for background task and session handling (P0-1).

Covers the two defects that made "the agents just never responded" possible:
a background DB session that was never deterministically closed, and a
fire-and-forget task the GC could collect mid-flight.
"""

import asyncio
import logging
from unittest.mock import MagicMock, patch

import pytest
from infrastructure.background import (
    drain_background_tasks,
    pending_background_tasks,
    spawn_background,
)
from infrastructure.database.connection import background_session


class TestBackgroundSession:
    """Tests for the background_session context manager."""

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_session_is_closed_on_exit(self):
        """The session's __aexit__ runs when the block ends, not at GC time."""
        session_cm = MagicMock()
        session_cm.__aenter__.return_value = "session"
        session_cm.__aexit__.return_value = False

        with patch(
            "infrastructure.database.connection.async_session_maker",
            return_value=session_cm,
        ):
            async with background_session() as session:
                assert session == "session"
                session_cm.__aexit__.assert_not_called()

        session_cm.__aexit__.assert_called_once()

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_session_is_closed_when_body_raises(self):
        """An exception inside the block still closes the session."""
        session_cm = MagicMock()
        session_cm.__aenter__.return_value = "session"
        session_cm.__aexit__.return_value = False

        with patch(
            "infrastructure.database.connection.async_session_maker",
            return_value=session_cm,
        ):
            with pytest.raises(ValueError):
                async with background_session():
                    raise ValueError("boom")

        session_cm.__aexit__.assert_called_once()


class TestSpawnBackground:
    """Tests for the background task registry."""

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_task_runs_to_completion_without_a_caller_reference(self):
        """The registry holds the only strong reference, and the task still finishes."""
        finished = asyncio.Event()

        async def work():
            await asyncio.sleep(0)
            finished.set()

        spawn_background(work(), name="test:no_reference")  # return value discarded

        await asyncio.wait_for(finished.wait(), timeout=1.0)

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_task_is_registered_while_running_and_removed_after(self):
        release = asyncio.Event()

        async def work():
            await release.wait()

        task = spawn_background(work(), name="test:registration")

        assert task in pending_background_tasks()
        release.set()
        await task
        assert task not in pending_background_tasks()

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_exception_is_logged(self, caplog):
        """A failure in an unawaited task surfaces through the logger."""

        async def failing():
            raise RuntimeError("background boom")

        with caplog.at_level(logging.ERROR, logger="BackgroundTasks"):
            task = spawn_background(failing(), name="test:failure")
            await asyncio.gather(task, return_exceptions=True)
            await asyncio.sleep(0)  # let done callbacks run

        assert any("background boom" in record.getMessage() for record in caplog.records)
        assert any(record.exc_info for record in caplog.records)

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_cancellation_is_not_logged_as_an_error(self, caplog):
        async def work():
            await asyncio.sleep(10)

        with caplog.at_level(logging.ERROR, logger="BackgroundTasks"):
            task = spawn_background(work(), name="test:cancelled")
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await asyncio.sleep(0)

        assert not [r for r in caplog.records if r.name == "BackgroundTasks"]


class TestDrainBackgroundTasks:
    """Tests for shutdown draining."""

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_waits_for_in_flight_tasks(self):
        completed = []

        async def work():
            await asyncio.sleep(0.01)
            completed.append(True)

        spawn_background(work(), name="test:drain")
        await drain_background_tasks(timeout=5.0)

        assert completed == [True]

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_cancels_tasks_that_overrun_the_timeout(self):
        async def slow():
            await asyncio.sleep(30)

        task = spawn_background(slow(), name="test:overrun")
        await drain_background_tasks(timeout=0.05)

        assert task.cancelled()

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_no_pending_tasks_is_a_no_op(self):
        await drain_background_tasks(timeout=0.01)
        assert pending_background_tasks() == set()
