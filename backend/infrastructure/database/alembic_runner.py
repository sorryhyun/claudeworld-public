"""Programmatic Alembic driver.

Schema changes used to be a 929-line pile of hand-written "add the column if it
is missing" checks (``migrations.py``) re-executed on every boot, with no record
of what a given database had already seen. Alembic owns forward schema changes
now; ``migrations.py`` survives only as the one-time catch-up path for databases
created before it was adopted.

There is deliberately no ``alembic.ini``. The config is built here so the URL
and the target metadata have exactly one definition, and so the Windows ``.exe``
has one fewer data file to bundle.
"""

from __future__ import annotations

import logging
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, inspect
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

def alembic_dir() -> Path:
    """Locate env.py and the revision scripts, bundled or not.

    Alembic finds revisions by scanning this directory on disk, so it must be
    the *data file* location, not the module location. In the PyInstaller build
    that is ``sys._MEIPASS/backend/...``, which is what ``settings.backend_dir``
    resolves to; falling back to ``__file__`` keeps this working if settings
    cannot be loaded.
    """
    try:
        from core.settings import get_settings

        return get_settings().backend_dir / "infrastructure" / "database" / "alembic"
    except Exception:  # pragma: no cover - settings are always available in practice
        return Path(__file__).resolve().parent / "alembic"


def build_alembic_config(connection: Connection | None = None) -> Config:
    """Build an Alembic Config pointed at this package's revisions.

    Args:
        connection: An open synchronous connection for ``env.py`` to reuse.
            Omit it to let Alembic create its own engine from the URL (the CLI
            path).
    """
    from infrastructure.database.connection import DATABASE_URL

    script_location = alembic_dir()

    config = Config()
    config.set_main_option("script_location", str(script_location))
    config.set_main_option("version_locations", str(script_location / "versions"))
    # Escape %, which ConfigParser would otherwise read as interpolation --
    # PostgreSQL URLs can carry percent-encoded passwords.
    config.set_main_option("sqlalchemy.url", DATABASE_URL.replace("%", "%%"))

    if connection is not None:
        config.attributes["connection"] = connection

    return config


def head_revision() -> str | None:
    """The newest revision id on disk."""
    return ScriptDirectory.from_config(build_alembic_config()).get_current_head()


def current_revision(connection: Connection) -> str | None:
    """The revision a database is stamped with, or None if it has never been stamped."""
    return MigrationContext.configure(connection).get_current_revision()


def has_alembic_version_table(connection: Connection) -> bool:
    """Whether this database has been placed under Alembic control."""
    return inspect(connection).has_table("alembic_version")


def has_any_table(connection: Connection) -> bool:
    """Whether this database has any application tables at all.

    Distinguishes a fresh install from an existing database that predates
    Alembic; the two need different adoption paths.
    """
    return any(name != "alembic_version" for name in inspect(connection).get_table_names())


# -- operations --------------------------------------------------------------


def _stamp(connection: Connection, revision: str) -> None:
    command.stamp(build_alembic_config(connection), revision)


def _upgrade(connection: Connection, revision: str) -> None:
    command.upgrade(build_alembic_config(connection), revision)


async def stamp_head(engine: AsyncEngine) -> None:
    """Record a database as being at the newest revision without running anything.

    Used for schemas that already match head: a fresh ``create_all`` install, or
    a pre-Alembic database that the legacy catch-up has just brought up to date.
    """
    async with engine.begin() as conn:
        await conn.run_sync(_stamp, "head")
    logger.info(f"✅ Database stamped at Alembic head ({head_revision()})")


class SchemaDriftError(RuntimeError):
    """The live schema is missing tables or columns that models.py declares."""


# Diff kinds that break the application outright: the ORM will reference a
# table or column the database does not have. Everything else autogenerate
# reports (type widths, server defaults, index naming) is cosmetic on a database
# that grew through years of hand-written ALTERs, and is only worth a warning.
_FATAL_DIFF_KINDS = frozenset({"add_table", "add_column"})


def _schema_diffs(connection: Connection) -> list:
    """Diff the live schema against models.py, as autogenerate would."""
    from alembic.autogenerate import compare_metadata

    from infrastructure.database.connection import Base

    context = MigrationContext.configure(
        connection,
        opts={"compare_type": True, "compare_server_default": True},
    )
    return compare_metadata(context, Base.metadata)


def _describe_diff(diff) -> str:
    """Render one autogenerate diff entry for a log line."""
    if isinstance(diff, list):  # grouped per-table diffs
        return "; ".join(_describe_diff(item) for item in diff)
    kind = diff[0]
    if kind == "add_table":
        return f"missing table '{diff[1].name}'"
    if kind == "add_column":
        return f"missing column '{diff[2]}.{diff[3].name}'"
    return f"{kind}: {diff[1:]}"


def _diff_kind(diff) -> str:
    return diff[0][0] if isinstance(diff, list) else diff[0]


async def verify_schema_matches_models(engine: AsyncEngine) -> None:
    """Fail loudly if the live schema is missing anything models.py declares.

    The gate that keeps drift from being silent. ``create_all`` handled fresh
    installs and hand-written ALTERs handled upgrades, with nothing checking the
    two agreed -- so a column added to models.py but not to migrations.py worked
    on fresh installs and was simply absent on upgraded ones, surfacing as an
    OperationalError in whatever request touched it first.

    Raises:
        SchemaDriftError: A table or column is missing.
    """
    async with engine.connect() as conn:
        diffs = await conn.run_sync(_schema_diffs)

    if not diffs:
        return

    fatal = [d for d in diffs if _diff_kind(d) in _FATAL_DIFF_KINDS]
    cosmetic = [d for d in diffs if _diff_kind(d) not in _FATAL_DIFF_KINDS]

    for diff in cosmetic:
        logger.warning(f"  Schema differs from models.py (non-fatal): {_describe_diff(diff)}")

    if fatal:
        details = "\n".join(f"  - {_describe_diff(diff)}" for diff in fatal)
        raise SchemaDriftError(
            "Database schema does not match models.py after migration:\n"
            f"{details}\n"
            "Refusing to start against a half-migrated schema. Generate a revision with:\n"
            "  uv run python backend/scripts/alembic_cli.py revision --autogenerate -m '<description>'"
        )


async def upgrade_to_head(engine: AsyncEngine) -> None:
    """Apply every revision the database has not seen yet."""
    async with engine.connect() as conn:
        current = await conn.run_sync(current_revision)

    head = head_revision()
    if current == head:
        logger.info(f"✅ Database schema up to date ({head})")
        return

    logger.info(f"🔄 Upgrading database schema: {current} -> {head}")
    async with engine.begin() as conn:
        await conn.run_sync(_upgrade, "head")
    logger.info("✅ Database schema upgraded")
