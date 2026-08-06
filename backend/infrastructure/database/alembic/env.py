"""Alembic environment for ClaudeWorld.

Always driven programmatically from ``alembic_runner.py`` (and from the CLI via
``scripts/alembic_cli.py``), never from a generated ``alembic.ini``. Keeping the
configuration in Python means there is no extra data file for PyInstaller to
bundle into the Windows ``.exe``, and one definition of the URL and the target
metadata rather than two that can drift.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

# Revisions import backend modules (`infrastructure.database.models`), which
# assume the backend directory is importable.
_BACKEND_DIR = Path(__file__).resolve().parents[3]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from infrastructure.database import models  # noqa: E402,F401  (registers the ORM classes on Base)
from infrastructure.database.connection import Base  # noqa: E402

config = context.config
target_metadata = Base.metadata


def _configure_kwargs() -> dict:
    """Options shared by offline and online runs.

    ``render_as_batch`` is what makes column alters work on SQLite, which has no
    real ``ALTER COLUMN``: Alembic recreates the table and copies the data.
    """
    return {
        "target_metadata": target_metadata,
        "compare_type": True,
        "compare_server_default": True,
        "render_as_batch": True,
    }


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of running it against a database."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **_configure_kwargs(),
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection) -> None:
    context.configure(connection=connection, **_configure_kwargs())
    with context.begin_transaction():
        context.run_migrations()


async def _run_async_migrations() -> None:
    """Build an async engine and drive the migrations through run_sync.

    DATABASE_URL always names an async driver (``sqlite+aiosqlite``,
    ``postgresql+asyncpg``), so a plain ``engine_from_config`` would fail. Going
    async here means the CLI uses the same URL as the app, with no sync-driver
    translation table to keep in step.
    """
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    """Run against a live connection.

    ``alembic_runner`` passes an already-open synchronous connection through
    ``config.attributes``; that is the path used at application startup, where
    the engine is async and the caller has entered it via ``run_sync``. The
    fallback opens its own async engine, which is what the CLI uses.
    """
    connection = config.attributes.get("connection")

    if connection is not None:
        _do_run_migrations(connection)
        return

    asyncio.run(_run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
