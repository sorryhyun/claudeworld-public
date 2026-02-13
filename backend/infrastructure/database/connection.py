import asyncio
import functools
import logging
import os

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


async def init_db():
    """
    Initialize database schema and run migrations.

    This function:
    1. Creates all tables if they don't exist (for fresh installs)
    2. Runs migrations to add missing columns (for upgrades)
    """
    from infrastructure.database.migrations import run_migrations

    # Create any missing tables first (for fresh installs)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Then run migrations to add any missing columns to existing tables
    await run_migrations(engine)


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


def retry_on_db_lock(max_retries=5, initial_delay=0.1, backoff_factor=2):
    """Retry on SQLite 'database is locked' errors with exponential backoff.

    For PostgreSQL this is a no-op passthrough.
    """
    if DATABASE_TYPE != "sqlite":

        def noop_decorator(func):
            return func

        return noop_decorator

    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            delay = initial_delay
            last_exc = None
            for attempt in range(max_retries):
                try:
                    return await func(*args, **kwargs)
                except Exception as exc:
                    exc_msg = str(exc).lower()
                    if "database is locked" in exc_msg or "locked" in exc_msg:
                        last_exc = exc
                        if attempt < max_retries - 1:
                            logger.warning(
                                f"SQLite locked (attempt {attempt + 1}/{max_retries}), "
                                f"retrying in {delay:.2f}s"
                            )
                            await asyncio.sleep(delay)
                            delay *= backoff_factor
                        continue
                    raise
            raise last_exc  # type: ignore[misc]

        return wrapper

    return decorator


class SerializedWrite:
    """Async context manager that serializes writes for SQLite.

    For PostgreSQL this is a transparent no-op.
    """

    def __init__(self, lock_key=None):
        self._is_sqlite = DATABASE_TYPE == "sqlite"

    async def __aenter__(self):
        if self._is_sqlite:
            await _get_write_lock().acquire()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._is_sqlite:
            _get_write_lock().release()
        return False


def serialized_write(lock_key=None) -> SerializedWrite:
    """Return a context manager that serializes writes for SQLite."""
    return SerializedWrite(lock_key)


async def serialized_commit(db: AsyncSession, lock_key=None) -> None:
    """Commit under the write lock (SQLite) or directly (PostgreSQL)."""
    async with serialized_write(lock_key):
        await db.commit()
