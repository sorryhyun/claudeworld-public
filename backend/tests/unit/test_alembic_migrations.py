"""
Unit tests for the Alembic migration path (P2).

The point of adopting Alembic was to make schema state knowable: every database
records which revisions it has seen, and drift between models.py and the
revisions is caught rather than discovered at runtime. These tests cover the
three adoption paths in init_db and the drift gate itself.
"""

import pytest
from infrastructure.database.alembic_runner import (
    SchemaDriftError,
    build_alembic_config,
    current_revision,
    has_alembic_version_table,
    has_any_table,
    head_revision,
    verify_schema_matches_models,
)
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.fixture
async def sqlite_engine(tmp_path):
    """A real on-disk SQLite database. Alembic needs a file, not :memory:.

    An in-memory database would be a fresh, empty database per connection, so
    nothing a migration did on one connection would be visible to the next.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    yield engine
    await engine.dispose()


async def _upgrade(engine):
    from infrastructure.database.alembic_runner import upgrade_to_head

    await upgrade_to_head(engine)


def _table_names(conn):
    return sorted(inspect(conn).get_table_names())


def _column_names(conn, table):
    return sorted(col["name"] for col in inspect(conn).get_columns(table))


@pytest.mark.unit
@pytest.mark.db
class TestRevisionScripts:
    """The revision scripts themselves."""

    def test_there_is_a_single_head(self):
        """Two heads means someone branched revisions without merging them."""
        from alembic.script import ScriptDirectory

        heads = ScriptDirectory.from_config(build_alembic_config()).get_heads()
        assert len(heads) == 1, f"expected one head, found {heads}"

    async def test_upgrade_from_empty_creates_the_schema(self, sqlite_engine):
        await _upgrade(sqlite_engine)

        async with sqlite_engine.connect() as conn:
            tables = await conn.run_sync(_table_names)

        for expected in ("agents", "rooms", "messages", "worlds", "locations"):
            assert expected in tables

    async def test_upgrade_stamps_the_head_revision(self, sqlite_engine):
        await _upgrade(sqlite_engine)

        async with sqlite_engine.connect() as conn:
            assert await conn.run_sync(current_revision) == head_revision()

    async def test_upgrade_is_idempotent(self, sqlite_engine):
        await _upgrade(sqlite_engine)
        await _upgrade(sqlite_engine)  # must not re-run the baseline

        async with sqlite_engine.connect() as conn:
            assert await conn.run_sync(current_revision) == head_revision()


@pytest.mark.unit
@pytest.mark.db
class TestSchemaDriftGate:
    """verify_schema_matches_models -- the check that makes drift loud."""

    async def test_migrated_schema_matches_models(self, sqlite_engine):
        """The revisions must actually reproduce models.py.

        This is the regression test for the original defect: a column added to
        models.py but not to the migrations worked on fresh installs and was
        missing on upgraded ones.
        """
        await _upgrade(sqlite_engine)
        await verify_schema_matches_models(sqlite_engine)  # must not raise

    async def test_missing_column_is_fatal(self, sqlite_engine):
        await _upgrade(sqlite_engine)
        async with sqlite_engine.begin() as conn:
            await conn.execute(text("ALTER TABLE agents DROP COLUMN priority"))

        with pytest.raises(SchemaDriftError, match="priority"):
            await verify_schema_matches_models(sqlite_engine)

    async def test_missing_table_is_fatal(self, sqlite_engine):
        await _upgrade(sqlite_engine)
        async with sqlite_engine.begin() as conn:
            await conn.execute(text("DROP TABLE locations"))

        with pytest.raises(SchemaDriftError, match="locations"):
            await verify_schema_matches_models(sqlite_engine)

    async def test_error_names_every_missing_column(self, sqlite_engine):
        await _upgrade(sqlite_engine)
        async with sqlite_engine.begin() as conn:
            await conn.execute(text("ALTER TABLE agents DROP COLUMN priority"))
            await conn.execute(text("ALTER TABLE agents DROP COLUMN transparent"))

        with pytest.raises(SchemaDriftError) as exc_info:
            await verify_schema_matches_models(sqlite_engine)

        message = str(exc_info.value)
        assert "priority" in message and "transparent" in message

    async def test_cosmetic_difference_is_only_a_warning(self, sqlite_engine, caplog):
        """A dropped non-unique index is a performance matter, not a broken app."""
        await _upgrade(sqlite_engine)
        async with sqlite_engine.begin() as conn:
            await conn.execute(text("DROP INDEX ix_agents_name"))

        await verify_schema_matches_models(sqlite_engine)  # must not raise

        assert any("non-fatal" in record.getMessage() for record in caplog.records)


@pytest.mark.unit
@pytest.mark.db
class TestDatabaseStateDetection:
    """The predicates init_db uses to pick an adoption path."""

    async def test_empty_database_has_no_tables_and_no_version(self, sqlite_engine):
        async with sqlite_engine.connect() as conn:
            assert await conn.run_sync(has_any_table) is False
            assert await conn.run_sync(has_alembic_version_table) is False

    async def test_migrated_database_has_both(self, sqlite_engine):
        await _upgrade(sqlite_engine)

        async with sqlite_engine.connect() as conn:
            assert await conn.run_sync(has_any_table) is True
            assert await conn.run_sync(has_alembic_version_table) is True

    async def test_alembic_version_alone_does_not_count_as_populated(self, sqlite_engine):
        """has_any_table asks about application tables, not bookkeeping ones."""
        async with sqlite_engine.begin() as conn:
            await conn.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)"))

        async with sqlite_engine.connect() as conn:
            assert await conn.run_sync(has_any_table) is False
            assert await conn.run_sync(has_alembic_version_table) is True


@pytest.mark.unit
@pytest.mark.db
class TestLegacyAdoption:
    """A database that predates Alembic must be caught up, verified, then stamped."""

    async def test_legacy_catch_up_restores_a_missing_column(self, sqlite_engine):
        from infrastructure.database.alembic_runner import stamp_head
        from infrastructure.database.migrations import run_legacy_migrations

        await _upgrade(sqlite_engine)

        # Simulate a pre-Alembic database: schema present, no version table,
        # and missing a column the legacy migrations know how to add back.
        async with sqlite_engine.begin() as conn:
            await conn.execute(text("DROP TABLE alembic_version"))
            await conn.execute(text("ALTER TABLE agents DROP COLUMN priority"))

        async with sqlite_engine.connect() as conn:
            assert "priority" not in await conn.run_sync(_column_names, "agents")
            assert await conn.run_sync(has_alembic_version_table) is False

        # This is the sequence init_db runs for a pre-Alembic database.
        await run_legacy_migrations(sqlite_engine)
        await verify_schema_matches_models(sqlite_engine)
        await stamp_head(sqlite_engine)

        async with sqlite_engine.connect() as conn:
            assert "priority" in await conn.run_sync(_column_names, "agents")
            assert await conn.run_sync(current_revision) == head_revision()
