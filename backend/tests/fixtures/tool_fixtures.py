"""
Test fixtures for SDK tools.

Provides reusable fixtures for testing tool handlers and factories.

Sub-agent invocation uses SDK native Task tool + persist tools pattern.
Sub-agents are invoked via Task tool and use persist_* tools directly.
"""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from sdk.handlers.context import ToolContext


@pytest.fixture
def mock_tool_context(tmp_path: Path) -> ToolContext:
    """Create a mock tool context for testing.

    Creates a minimal ToolContext with a temporary config file.
    Useful for testing action tools that don't need full dependencies.
    """
    config_file = tmp_path / "test_agent" / "consolidated_memory.md"
    config_file.parent.mkdir(parents=True)
    config_file.write_text("## Test Memory\nSome content")

    return ToolContext(
        agent_name="TestAgent",
        agent_id=1,
        config_file=config_file,
        group_name=None,
        room_id=1,
        world_name="test_world",
        world_id=1,
        long_term_memory_index={"Test Memory": "Some content"},
    )


@pytest.fixture
def mock_db_session() -> AsyncMock:
    """Mock async database session.

    Provides an AsyncMock that simulates an SQLAlchemy AsyncSession.
    """
    session = AsyncMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    session.refresh = AsyncMock()
    session.execute = AsyncMock()
    session.scalar = AsyncMock()
    session.scalars = AsyncMock()
    return session


@pytest.fixture
def full_tool_context(
    mock_tool_context: ToolContext,
    mock_db_session: AsyncMock,
) -> ToolContext:
    """Tool context with all dependencies configured.

    Combines mock_tool_context with database dependency.
    Useful for testing gameplay tools that require full context.
    """
    mock_tool_context.db = mock_db_session
    return mock_tool_context


@pytest.fixture
def mock_character_design() -> MagicMock:
    """Mock CharacterDesign result from Character Designer.

    Provides a typical character design response for testing.
    """
    from domain.entities.gameplay_models import CharacterDesign

    return CharacterDesign(
        name="Test NPC",
        role="Merchant",
        appearance="A friendly-looking merchant with a warm smile",
        personality="Helpful and honest, always willing to make a fair deal",
        which_location="Town Square",
        location_name="Town Square",
        secret="Has a hidden past as a former adventurer",
        initial_disposition="friendly",
    )


@pytest.fixture
def mock_location_design() -> MagicMock:
    """Mock LocationDesign result from Location Designer.

    Provides a typical location design response for testing.
    """
    from domain.entities.gameplay_models import LocationDesign

    return LocationDesign(
        name="forest_clearing",
        display_name="Forest Clearing",
        description="A peaceful clearing in the forest, dappled sunlight filtering through the canopy.",
        position_x=10,
        position_y=20,
        adjacent_hints=["forest_path", "river_bank"],
    )


@pytest.fixture
def mock_stat_calc_result() -> MagicMock:
    """Mock StatCalcResult from Stat Calculator.

    Provides a typical stat calculation response for testing.
    """
    from domain.entities.gameplay_models import InventoryChange, StatCalcResult, StatChange

    return StatCalcResult(
        summary="The attack hits! You deal damage to the enemy.",
        stat_changes=[
            StatChange(stat_name="health", old_value=100, new_value=85, delta=-15),
        ],
        inventory_changes=[
            InventoryChange(
                action="remove",
                item_id="arrow_001",
                name="Arrow",
                description="A simple arrow",
                quantity=1,
                properties={},
            ),
        ],
    )


@pytest.fixture
def mock_summary_result() -> MagicMock:
    """Mock SummaryResult from Summarizer.

    Provides a typical summary response for testing.
    """
    from domain.entities.gameplay_models import SummaryResult

    return SummaryResult(summary="The player explored the town square and met the local merchant.")


def make_test_context(
    agent_name: str = "TestAgent",
    agent_id: int = 1,
    world_name: str = "test_world",
    world_id: int = 1,
    room_id: int = 1,
    group_name: str | None = None,
    config_file: Path | None = None,
    long_term_memory_index: dict[str, str] | None = None,
    db: AsyncMock | None = None,
) -> ToolContext:
    """Helper function to create ToolContext for tests.

    Allows creating customized contexts without fixtures.
    """
    return ToolContext(
        agent_name=agent_name,
        agent_id=agent_id,
        world_name=world_name,
        world_id=world_id,
        room_id=room_id,
        group_name=group_name,
        config_file=config_file,
        long_term_memory_index=long_term_memory_index or {},
        db=db,
    )
