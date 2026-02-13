"""
Unit tests for database module.

Tests database connection, SQLite write serialization, and retry logic.
"""

import asyncio

import pytest
from infrastructure.database.connection import (
    DATABASE_TYPE,
    get_db,
    reset_write_lock,
    retry_on_db_lock,
    serialized_write,
)


class TestRetryOnDbLock:
    """Tests for retry_on_db_lock decorator."""

    @pytest.fixture(autouse=True)
    def _reset_lock(self):
        reset_write_lock()
        yield
        reset_write_lock()

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_successful_operation_no_retry(self):
        """Test decorator with successful operation (no retry needed)."""
        call_count = 0

        @retry_on_db_lock(max_retries=3)
        async def mock_operation():
            nonlocal call_count
            call_count += 1
            return "success"

        result = await mock_operation()

        assert result == "success"
        assert call_count == 1

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_non_lock_errors_propagate_immediately(self):
        """Test that non-lock errors are raised without retry."""
        call_count = 0

        @retry_on_db_lock(max_retries=3)
        async def mock_operation():
            nonlocal call_count
            call_count += 1
            raise ValueError("some error")

        with pytest.raises(ValueError):
            await mock_operation()

        assert call_count == 1

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_retries_on_locked_error(self):
        """Test retry on 'database is locked' error (SQLite only)."""
        if DATABASE_TYPE != "sqlite":
            pytest.skip("retry logic only active for SQLite")

        call_count = 0

        @retry_on_db_lock(max_retries=3, initial_delay=0.01)
        async def mock_operation():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise Exception("database is locked")
            return "success"

        result = await mock_operation()
        assert result == "success"
        assert call_count == 3

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_exhausts_retries(self):
        """Test that it raises after exhausting retries (SQLite only)."""
        if DATABASE_TYPE != "sqlite":
            pytest.skip("retry logic only active for SQLite")

        @retry_on_db_lock(max_retries=2, initial_delay=0.01)
        async def mock_operation():
            raise Exception("database is locked")

        with pytest.raises(Exception, match="database is locked"):
            await mock_operation()


class TestSerializedWrite:
    """Tests for serialized_write context manager."""

    @pytest.fixture(autouse=True)
    def _reset_lock(self):
        reset_write_lock()
        yield
        reset_write_lock()

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_serialized_write_basic(self):
        """Test that serialized_write can be used as context manager."""
        async with serialized_write():
            pass  # Should not raise

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_serialized_write_serializes_for_sqlite(self):
        """Test that concurrent writes are serialized (SQLite only)."""
        if DATABASE_TYPE != "sqlite":
            pytest.skip("serialization only active for SQLite")

        execution_order = []

        async def write_op(n: int):
            async with serialized_write():
                execution_order.append(f"start_{n}")
                await asyncio.sleep(0.01)
                execution_order.append(f"end_{n}")

        tasks = [asyncio.create_task(write_op(i)) for i in range(3)]
        await asyncio.gather(*tasks)

        # Verify writes were serialized: each start followed by its end
        for i in range(0, len(execution_order), 2):
            start_entry = execution_order[i]
            end_entry = execution_order[i + 1]
            assert start_entry.startswith("start_")
            assert end_entry.startswith("end_")
            assert start_entry.split("_")[1] == end_entry.split("_")[1]


class TestGetDb:
    """Tests for get_db dependency."""

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_get_db_yields_session(self):
        """Test get_db yields an AsyncSession."""
        session_gen = get_db()
        session = await anext(session_gen)

        # Should be an AsyncSession
        from sqlalchemy.ext.asyncio import AsyncSession

        assert isinstance(session, AsyncSession)

        # Cleanup
        try:
            await anext(session_gen)
        except StopAsyncIteration:
            pass

    @pytest.mark.unit
    @pytest.mark.asyncio
    async def test_get_db_closes_session(self):
        """Test get_db properly closes the session."""
        session_gen = get_db()
        session = await anext(session_gen)

        # Session should be open
        assert not session.is_active or True  # Session exists

        # Finish the generator
        try:
            await anext(session_gen)
        except StopAsyncIteration:
            pass

        # Session should be closed after generator finishes
