"""
Pytest configuration and shared fixtures for backend tests.

This module provides test fixtures for database sessions, test clients,
authentication, and commonly used test data.

NOTE: Heavy imports (main, models, sdk) are done lazily inside fixtures
to avoid loading the entire app for tests that don't need it.
"""

import gc
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

# Add backend directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# Type hints only - not imported at runtime
if TYPE_CHECKING:
    from typing import AsyncGenerator

    from httpx import AsyncClient
    from infrastructure.database import models
    from sqlalchemy.ext.asyncio import AsyncSession


# Files that use database fixtures (memory intensive)
DB_FIXTURE_FILES = {
    "test_crud_game.py",
    "test_crud.py",
    "test_models.py",
    "test_schemas.py",
    "test_services.py",
}

# Files that use Claude Agent SDK (may spawn subprocesses, very memory intensive)
SDK_FIXTURE_FILES = {
    "test_client_pool.py",
    "test_sdk_manager.py",
    "test_sdk_tools.py",
    "test_stream_parser.py",
    "test_response_generator.py",
    "test_gameplay_tools.py",
    "test_onboarding_tools.py",
    "test_onboarding_models.py",
}


def pytest_collection_modifyitems(items):
    """Auto-apply markers based on test directory and fixtures used."""
    for item in items:
        filepath = str(item.fspath)
        filename = Path(filepath).name

        # Apply 'unit' marker to tests in unit directory
        if "/tests/unit/" in filepath:
            item.add_marker(pytest.mark.unit)
            # Mark database-using tests
            if filename in DB_FIXTURE_FILES:
                item.add_marker(pytest.mark.db)
            # Mark SDK-using tests (memory intensive, may spawn subprocesses)
            if filename in SDK_FIXTURE_FILES:
                item.add_marker(pytest.mark.sdk)
        # Apply 'integration' marker to tests in integration directory
        elif "/tests/integration/" in filepath:
            item.add_marker(pytest.mark.integration)
            item.add_marker(pytest.mark.db)  # All integration tests use db


@pytest.fixture(autouse=True)
def cleanup_after_test():
    """Run garbage collection after each test to free memory."""
    yield
    gc.collect()


# ============================================================================
# Event loop fixture for session-scoped async fixtures
# ============================================================================


@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the test session."""
    import asyncio

    policy = asyncio.get_event_loop_policy()
    loop = policy.new_event_loop()
    yield loop
    loop.close()


# ============================================================================
# Database fixtures (only loaded when needed)
# ============================================================================


@pytest.fixture(scope="session")
async def test_engine():
    """Create a single test database engine for the entire test session."""
    from infrastructure.database.connection import Base
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        echo=False,
        connect_args={"check_same_thread": False},
    )

    # Create tables once
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    # Cleanup at end of session
    await engine.dispose()


@pytest.fixture(scope="session")
async def test_session_factory(test_engine):
    """Create session factory for tests."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    return async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(scope="function")
async def test_db(test_engine, test_session_factory) -> "AsyncGenerator[AsyncSession, None]":
    """
    Provide a test database session with automatic rollback.

    Uses a single shared database with transaction rollback for isolation.
    """
    # Start a connection and transaction
    async with test_engine.connect() as conn:
        await conn.begin()

        # Bind session to this connection
        async with test_session_factory(bind=conn) as session:
            yield session

        # Rollback the transaction (cleanup all test data)
        await conn.rollback()


# ============================================================================
# App/Client fixtures (only loaded when needed)
# ============================================================================


def _get_app():
    """Lazy import of the FastAPI app."""
    from main import app

    return app


def _setup_app_state(app):
    """Set up app state with mock instances for testing."""
    from unittest.mock import AsyncMock, MagicMock

    from orchestration import ChatOrchestrator
    from sdk import AgentManager
    from sdk.client.client_pool import ClientPool

    if not hasattr(app.state, "agent_manager") or app.state.agent_manager is None:
        app.state.agent_manager = MagicMock(spec=AgentManager)
        app.state.agent_manager.shutdown = AsyncMock()
        app.state.agent_manager.client_pool = MagicMock(spec=ClientPool)
        app.state.agent_manager.client_pool.remove_agent_from_room = MagicMock()
    if not hasattr(app.state, "chat_orchestrator") or app.state.chat_orchestrator is None:
        app.state.chat_orchestrator = MagicMock(spec=ChatOrchestrator)
    if not hasattr(app.state, "background_scheduler") or app.state.background_scheduler is None:
        app.state.background_scheduler = MagicMock()


@pytest.fixture(scope="function")
async def client(test_db: "AsyncSession") -> "AsyncGenerator[AsyncClient, None]":
    """Create a test client with authentication bypassed."""
    from httpx import ASGITransport, AsyncClient
    from infrastructure.database.connection import get_db

    app = _get_app()
    _setup_app_state(app)

    async def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.fixture(scope="function")
async def authenticated_client(test_db: "AsyncSession") -> "AsyncGenerator[tuple[AsyncClient, str], None]":
    """Create a test client with a valid JWT token."""
    from infrastructure.auth import generate_jwt_token
    from httpx import ASGITransport, AsyncClient
    from infrastructure.database.connection import get_db

    app = _get_app()
    _setup_app_state(app)

    async def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db

    token = generate_jwt_token(role="admin", user_id="admin")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test", headers={"X-API-Key": token}) as ac:
        yield ac, token

    app.dependency_overrides.clear()


@pytest.fixture(scope="function")
async def guest_client(test_db: "AsyncSession") -> "AsyncGenerator[tuple[AsyncClient, str], None]":
    """Create a test client with a valid guest JWT token."""
    from infrastructure.auth import generate_jwt_token
    from httpx import ASGITransport, AsyncClient
    from infrastructure.database.connection import get_db

    app = _get_app()
    _setup_app_state(app)

    async def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db

    token = generate_jwt_token(role="guest", user_id="guest-test")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test", headers={"X-API-Key": token}) as ac:
        yield ac, token

    app.dependency_overrides.clear()


# ============================================================================
# Sample data fixtures
# ============================================================================


@pytest.fixture
async def sample_agent(test_db: "AsyncSession") -> "models.Agent":
    """Create a sample agent for testing."""
    from infrastructure.database import models

    agent = models.Agent(
        name="test_agent",
        group="test_group",
        config_file="agents/test_agent.md",
        in_a_nutshell="A test agent for testing purposes",
        characteristics="Friendly and helpful",
        recent_events="Just created",
        system_prompt="You are a test agent.",
    )
    test_db.add(agent)
    await test_db.commit()
    await test_db.refresh(agent)
    return agent


@pytest.fixture
async def sample_room(test_db: "AsyncSession") -> "models.Room":
    """Create a sample room for testing."""
    from infrastructure.database import models

    room = models.Room(name="test_room", max_interactions=None, is_paused=False, owner_id="admin")
    test_db.add(room)
    await test_db.commit()
    await test_db.refresh(room)
    return room


@pytest.fixture
async def sample_room_with_agents(
    test_db: "AsyncSession", sample_room: "models.Room", sample_agent: "models.Agent"
) -> "models.Room":
    """Create a sample room with agents."""
    await test_db.refresh(sample_room, ["agents"])
    sample_room.agents.append(sample_agent)
    await test_db.commit()
    await test_db.refresh(sample_room, ["agents"])
    return sample_room


@pytest.fixture
async def sample_message(
    test_db: "AsyncSession", sample_room: "models.Room", sample_agent: "models.Agent"
) -> "models.Message":
    """Create a sample message for testing."""
    from infrastructure.database import models

    message = models.Message(
        room_id=sample_room.id,
        agent_id=sample_agent.id,
        content="This is a test message",
        role="assistant",
        thinking="Test thinking process",
    )
    test_db.add(message)
    await test_db.commit()
    await test_db.refresh(message)
    return message


@pytest.fixture
def mock_env_vars(monkeypatch):
    """Set up mock environment variables for testing."""
    from core import reset_settings

    test_hash = "$2b$12$H0fCIM9buSuQsCFErTRi0Omz//QVZxCKJW5Dapi2u3ealuUFzvF9O"
    monkeypatch.setenv("API_KEY_HASH", test_hash)
    monkeypatch.setenv("JWT_SECRET", "test_secret_key_for_testing_only")
    monkeypatch.setenv("ENABLE_GUEST_LOGIN", "false")

    reset_settings()

    return {
        "api_key_hash": test_hash,
        "jwt_secret": "test_secret_key_for_testing_only",
        "test_password": "test_password",
    }


@pytest.fixture
def temp_agent_config(tmp_path):
    """Create a temporary agent configuration directory."""
    agent_dir = tmp_path / "agents" / "test_agent"
    agent_dir.mkdir(parents=True)

    (agent_dir / "in_a_nutshell.md").write_text("Test agent nutshell")
    (agent_dir / "characteristics.md").write_text("Test characteristics")
    (agent_dir / "recent_events.md").write_text("Test recent events")

    return agent_dir


# ============================================================================
# Tool fixtures (imported from fixtures module)
# ============================================================================

# These are imported lazily when needed by tests
from tests.fixtures.tool_fixtures import (  # noqa: E402, F401
    full_tool_context,
    mock_character_design,
    mock_db_session,
    mock_location_design,
    mock_stat_calc_result,
    mock_summary_result,
    mock_tool_context,
)
