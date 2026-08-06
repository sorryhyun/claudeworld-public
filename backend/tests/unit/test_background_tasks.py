"""
Unit tests for background task and session handling (P0-1).

Covers the two defects that made "the agents just never responded" possible:
a background DB session that was never deterministically closed, and a
fire-and-forget task the GC could collect mid-flight.
"""

import asyncio
import logging
from unittest.mock import AsyncMock, patch

import pytest
from infrastructure.background import (
    drain_background_tasks,
    pending_background_tasks,
    run_uninterruptible,
    spawn_background,
)
from infrastructure.database.connection import background_session


def _fake_session():
    """A stand-in AsyncSession that records close() / invalidate() calls."""
    from sqlalchemy.ext.asyncio import AsyncSession

    return AsyncMock(spec=AsyncSession)


class TestBackgroundSession:
    """Tests for the background_session context manager."""

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_session_is_closed_on_exit(self):
        """The session is closed when the block ends, not at GC time."""
        session = _fake_session()

        with patch(
            "infrastructure.database.connection.async_session_maker",
            return_value=session,
        ):
            async with background_session() as yielded:
                assert yielded is session
                session.close.assert_not_awaited()

        session.close.assert_awaited_once()
        session.invalidate.assert_not_awaited()

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_session_is_discarded_when_body_raises(self):
        """A failed block drops the connection instead of closing it cleanly."""
        session = _fake_session()

        with patch(
            "infrastructure.database.connection.async_session_maker",
            return_value=session,
        ):
            with pytest.raises(ValueError):
                async with background_session():
                    raise ValueError("boom")

        session.invalidate.assert_awaited_once()

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_cancelled_session_is_invalidated_not_closed(self):
        """P1-1: cancellation can land mid-statement, so never negotiate a ROLLBACK.

        close() would issue one on a connection in an unknown state, which can
        raise or hang. The session is being discarded regardless.
        """
        session = _fake_session()

        with patch(
            "infrastructure.database.connection.async_session_maker",
            return_value=session,
        ):
            with pytest.raises(asyncio.CancelledError):
                async with background_session():
                    raise asyncio.CancelledError()

        session.invalidate.assert_awaited_once()
        session.close.assert_not_awaited()

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_failure_to_invalidate_does_not_mask_the_original_error(self):
        session = _fake_session()
        session.invalidate.side_effect = RuntimeError("connection already gone")

        with patch(
            "infrastructure.database.connection.async_session_maker",
            return_value=session,
        ):
            with pytest.raises(ValueError, match="boom"):
                async with background_session():
                    raise ValueError("boom")


class TestRunUninterruptible:
    """Tests for run_uninterruptible (P1-1 shielding)."""

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_returns_the_result_when_not_cancelled(self):
        async def work():
            await asyncio.sleep(0)
            return "written"

        assert await run_uninterruptible(work()) == "written"

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_write_completes_even_though_the_caller_is_cancelled(self):
        """The whole point: an interrupt must not lose a half-written message."""
        started = asyncio.Event()
        committed = []

        async def write():
            started.set()
            await asyncio.sleep(0.05)
            committed.append("message")

        async def caller():
            await run_uninterruptible(write())

        task = asyncio.create_task(caller())
        await started.wait()
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        # Cancellation was honoured -- but only after the write landed.
        assert committed == ["message"]

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_cancellation_is_re_raised_after_the_write(self):
        order = []

        async def write():
            await asyncio.sleep(0.02)
            order.append("write")

        async def caller():
            try:
                await run_uninterruptible(write())
            except asyncio.CancelledError:
                order.append("cancel")
                raise

        task = asyncio.create_task(caller())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert order == ["write", "cancel"]

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_exception_from_the_write_propagates(self):
        async def failing_write():
            raise RuntimeError("insert failed")

        with pytest.raises(RuntimeError, match="insert failed"):
            await run_uninterruptible(failing_write())


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
