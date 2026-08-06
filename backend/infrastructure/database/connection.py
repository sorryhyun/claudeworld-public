import asyncio
import functools
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import declarative_base
from sqlalchemy.pool import NullPool

logger = logging.getLogger(__name__)

# Database connection URL from environment variable
# Supports both SQLite (default for dev) and PostgreSQL (production)
# SQLite format: sqlite+aiosqlite:///./claudeworld.db
# PostgreSQL format: postgresql+asyncpg://user:password@host:port/database
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://postgres:postgres@localhost:5432/claudeworld")


def get_database_type(url: str) -> str:
    """
    Extract database type from connection URL.

    Args:
        url: Database connection URL

    Returns:
        "sqlite" or "postgresql" or "unknown"
    """
    if url.startswith("sqlite"):
        return "sqlite"
    elif url.startswith("postgresql"):
        return "postgresql"
    return "unknown"


DATABASE_TYPE = get_database_type(DATABASE_URL)

# Configure engine with database-specific settings
if DATABASE_TYPE == "sqlite":
    # SQLite configuration: No connection pooling, allow multi-threading
    engine = create_async_engine(
        DATABASE_URL,
        echo=False,
        connect_args={"check_same_thread": False},
        poolclass=NullPool,  # SQLite doesn't need connection pooling
    )

    # Enable foreign key constraints for SQLite
    @event.listens_for(engine.sync_engine, "connect")
    def set_sqlite_pragma(dbapi_conn, connection_record):
        """Enable foreign key constraints in SQLite."""
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    logger.info("Database configured: SQLite (file-based, serialized writes)")
else:
    # PostgreSQL configuration: Connection pooling for concurrent access
    engine = create_async_engine(
        DATABASE_URL,
        echo=False,
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,  # Verify connections before use
        pool_recycle=3600,  # Recycle connections after 1 hour
    )
    logger.info("Database configured: PostgreSQL (with connection pooling)")

# Session factory with sensible defaults
async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)

Base = declarative_base()


async def get_db():
    """Yield a database session for dependency injection."""
    async with async_session_maker() as session:
        yield session


@asynccontextmanager
async def background_session() -> AsyncIterator[AsyncSession]:
    """Yield a database session for work that outlives a request.

    Do NOT use ``get_db()`` for this. It is a FastAPI dependency generator: its
    cleanup runs when the generator is closed, and breaking out of
    ``async for ... in get_db()`` never closes it. Finalization is then deferred
    to the event loop's async-generator hooks at GC time, so the session (and,
    under SQLite's NullPool, its connection) leaks until then.

    On cancellation the session is treated as tainted and its connection is
    dropped rather than closed cleanly. Background orchestration tasks get
    cancelled mid-turn (a new player action interrupts the previous one, or the
    processing timeout fires), and that cancellation can land inside
    ``await session.execute(...)`` with the DBAPI connection part-way through a
    statement. A normal close() issues a ROLLBACK on that connection, which can
    raise or hang. The session is being discarded either way, so invalidating is
    strictly safer than negotiating with a connection in an unknown state.
    """
    session = async_session_maker()
    try:
        yield session
    except BaseException:
        await _discard_session(session)
        raise
    else:
        await session.close()


async def _discard_session(session: AsyncSession) -> None:
    """Drop a session's connection without trying to use it first.

    ``invalidate()`` returns the connection to the pool marked dead (and closes
    it outright under SQLite's NullPool) instead of issuing a ROLLBACK on it.
    """
    try:
        await session.invalidate()
    except Exception:
        logger.exception("Failed to invalidate a tainted database session")


async def init_db():
    """
    Initialize the database schema.

    Three cases, distinguished by what the database already contains:

    1. **Empty** -- fresh install. Run every Alembic revision from scratch.
    2. **Tables but no ``alembic_version``** -- predates Alembic. Run the legacy
       catch-up ALTERs in ``migrations.py`` once, create any tables added since,
       verify the result against models.py, then stamp it at head. From the next
       boot it takes path 3 and never touches the legacy code again.
    3. **Stamped** -- apply whatever revisions it has not seen.

    The filesystem agent sync runs afterwards, in its own transaction: it is a
    data migration doing filesystem I/O and has no business inside a DDL
    transaction, where a slow or failing read would roll back the schema work.
    """
    from infrastructure.database.alembic_runner import (
        has_alembic_version_table,
        has_any_table,
        stamp_head,
        upgrade_to_head,
        verify_schema_matches_models,
    )

    async with engine.connect() as conn:
        already_populated = await conn.run_sync(has_any_table)
        under_alembic = await conn.run_sync(has_alembic_version_table)

    if not already_populated:
        logger.info("🆕 Fresh database - creating schema from migrations")
        await upgrade_to_head(engine)
    elif not under_alembic:
        logger.info("⬆️  Pre-Alembic database detected - running one-time catch-up")
        from infrastructure.database.migrations import run_legacy_migrations

        await run_legacy_migrations(engine)
        # Tables added to models.py after the legacy migrations stopped being
        # maintained: those were only ever created by create_all.
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await verify_schema_matches_models(engine)
        await stamp_head(engine)
    else:
        await upgrade_to_head(engine)

    await _run_startup_data_sync()


async def _run_startup_data_sync() -> None:
    """Sync agent rows from the filesystem, outside the schema transaction.

    A failure here leaves stale agent metadata, which is recoverable, so it is
    logged rather than allowed to abort startup -- unlike a schema failure.
    """
    from infrastructure.database.migrations import sync_agents_from_filesystem

    try:
        async with engine.begin() as conn:
            await sync_agents_from_filesystem(conn)
    except Exception:
        logger.exception("Agent filesystem sync failed; agent metadata may be stale")


# =============================================================================
# SQLite Write Serialization
# =============================================================================
# SQLite only supports one writer at a time. These primitives ensure all
# concurrent async writes are serialized through a process-wide lock.
# For PostgreSQL, these are transparent no-ops.

# Process-wide async lock for SQLite writes. Lazily created per event loop.
_sqlite_write_lock: asyncio.Lock | None = None


def _get_write_lock() -> asyncio.Lock:
    """Get or create the process-wide SQLite write lock (lazy, per event loop)."""
    global _sqlite_write_lock
    if _sqlite_write_lock is None:
        _sqlite_write_lock = asyncio.Lock()
    return _sqlite_write_lock


def reset_write_lock() -> None:
    """Reset the write lock. Used in tests when the event loop changes."""
    global _sqlite_write_lock
    _sqlite_write_lock = None


# The only messages SQLite emits for genuine write-lock contention. Anything
# else that merely contains the substring "locked" -- "deadlocked", or an
# application error like "account is locked" -- must NOT be retried.
_SQLITE_LOCK_MESSAGES = ("database is locked", "database table is locked")


def _is_sqlite_lock_error(exc: BaseException) -> bool:
    """True only for SQLite's write-lock contention errors.

    Checks the DBAPI exception underneath the SQLAlchemy wrapper (``.orig``)
    when there is one, so a wrapped OperationalError is classified on the
    driver's own message rather than SQLAlchemy's decorated string.
    """
    original = getattr(exc, "orig", None) or exc
    message = str(original).lower()
    return any(lock_msg in message for lock_msg in _SQLITE_LOCK_MESSAGES)


def _find_session(args: tuple, kwargs: dict) -> AsyncSession | None:
    """Locate the AsyncSession a decorated CRUD function was called with.

    Every function using this decorator takes the session as its first
    positional parameter, but check kwargs too so keyword calls still work.
    """
    for candidate in (*args, *kwargs.values()):
        if isinstance(candidate, AsyncSession):
            return candidate
    return None


def retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2):
    """Retry on SQLite 'database is locked' errors with exponential backoff.

    For PostgreSQL this is a no-op passthrough.

    A failure part-way through a transaction leaves the session in a failed
    state, where every subsequent statement raises until someone rolls back. So
    the session is rolled back between attempts; without that, the retries are
    guaranteed to fail and only add the backoff delay to the latency.
    """
    if DATABASE_TYPE != "sqlite":

        def noop_decorator(func):
            return func

        return noop_decorator

    if max_retries < 1:
        raise ValueError(f"max_retries must be at least 1, got {max_retries}")

    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            delay = initial_delay
            for attempt in range(max_retries):
                try:
                    return await func(*args, **kwargs)
                except Exception as exc:
                    if not _is_sqlite_lock_error(exc) or attempt == max_retries - 1:
                        raise

                    session = _find_session(args, kwargs)
                    if session is not None:
                        try:
                            await session.rollback()
                        except Exception:
                            logger.exception("Rollback failed before retrying %s", func.__name__)
                            raise exc from None

                    logger.warning(
                        f"SQLite locked in {func.__name__} (attempt {attempt + 1}/{max_retries}), "
                        f"retrying in {delay:.2f}s"
                    )
                    await asyncio.sleep(delay)
                    delay *= backoff_factor

            # Unreachable: the loop either returns or raises on the final attempt.
            raise AssertionError("retry_on_db_lock exited its loop without a result")

        return wrapper

    return decorator


class SerializedWrite:
    """Async context manager that serializes writes for SQLite.

    For PostgreSQL this is a transparent no-op.
    """

    def __init__(self):
        self._is_sqlite = DATABASE_TYPE == "sqlite"

    async def __aenter__(self):
        if self._is_sqlite:
            await _get_write_lock().acquire()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._is_sqlite:
            _get_write_lock().release()
        return False


def serialized_write() -> SerializedWrite:
    """Return a context manager that serializes writes for SQLite."""
    return SerializedWrite()


async def serialized_commit(db: AsyncSession) -> None:
    """Commit under the write lock (SQLite) or directly (PostgreSQL)."""
    async with serialized_write():
        await db.commit()
