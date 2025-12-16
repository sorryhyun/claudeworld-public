"""
Unit tests for gameplay tools.

Tests tool creation, input validation, and execution using ToolContext.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError
from sdk.config.gameplay_inputs import (
    RemoveCharacterInput,
    TravelInput,
)
from sdk.tools.context import ToolContext


class TestGameplayInputModels:
    """Tests for gameplay input Pydantic models."""

    def test_remove_character_input_required_name(self):
        """Test that character_name is required."""
        with pytest.raises(ValidationError):
            RemoveCharacterInput()

    def test_remove_character_input_validates_empty_name(self):
        """Test that empty character name is rejected."""
        with pytest.raises(ValidationError):
            RemoveCharacterInput(character_name="   ")

    def test_remove_character_input_normalizes_reason(self):
        """Test that reason is normalized to lowercase."""
        inp = RemoveCharacterInput(character_name="Test", reason="DEATH")
        assert inp.reason == "death"

    def test_travel_input_required_destination(self):
        """Test that destination is required."""
        with pytest.raises(ValidationError):
            TravelInput()

    def test_travel_input_defaults(self):
        """Test TravelInput default values."""
        inp = TravelInput(
            destination="Forest",
            narration="You travel to the forest.",
            action_1="Explore",
            action_2="Rest",
            chat_summary="The player left the area.",
            user_action="Go to Forest",
        )
        assert inp.destination == "Forest"
        assert inp.bring_characters == []

    def test_travel_input_normalizes_characters(self):
        """Test that bring_characters list is normalized."""
        inp = TravelInput(
            destination="Forest",
            bring_characters=["  Alice  ", "Bob", ""],
            narration="You travel to the forest with companions.",
            action_1="Explore together",
            action_2="Set up camp",
            chat_summary="The party departed.",
            user_action="Go to Forest",
        )
        assert inp.bring_characters == ["Alice", "Bob"]


class TestToolContext:
    """Tests for ToolContext dataclass."""

    def test_basic_context_creation(self):
        """Test creating a basic ToolContext."""
        ctx = ToolContext(agent_name="TestAgent")
        assert ctx.agent_name == "TestAgent"
        assert ctx.agent_id is None
        assert ctx.db is None

    def test_require_db_raises_without_db(self):
        """Test that require_db raises when db is None."""
        ctx = ToolContext(agent_name="TestAgent")
        with pytest.raises(RuntimeError, match="Database session not configured"):
            ctx.require_db()

    def test_require_db_returns_db(self):
        """Test that require_db returns the db when configured."""
        mock_db = AsyncMock()
        ctx = ToolContext(agent_name="TestAgent", db=mock_db)
        assert ctx.require_db() is mock_db

    def test_require_world_name_raises_without_world(self):
        """Test that require_world_name raises when not configured."""
        ctx = ToolContext(agent_name="TestAgent")
        with pytest.raises(RuntimeError, match="World name not configured"):
            ctx.require_world_name()

    def test_require_room_id_raises_without_room(self):
        """Test that require_room_id raises when not configured."""
        ctx = ToolContext(agent_name="TestAgent")
        with pytest.raises(RuntimeError, match="Room ID not configured"):
            ctx.require_room_id()


class TestCharacterToolsCreation:
    """Tests for character tools creation."""

    @patch("sdk.tools.gameplay_tools.character_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.character_tools.get_tool_description")
    def test_create_character_tools_requires_dependencies(
        self,
        mock_get_description,
        mock_is_enabled,
    ):
        """Test that character tools require all dependencies."""
        from sdk.tools.gameplay_tools.character_tools import create_character_tools

        mock_is_enabled.return_value = True
        mock_get_description.return_value = "Tool description"

        # Missing db should raise
        ctx = ToolContext(
            agent_name="TestAgent",
            world_name="test_world",
            world_id=1,
            room_id=1,
        )

        with pytest.raises(RuntimeError, match="Database session not configured"):
            create_character_tools(ctx)

    @patch("sdk.tools.gameplay_tools.character_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.character_tools.get_tool_description")
    def test_create_character_tools_when_disabled(
        self,
        mock_get_description,
        mock_is_enabled,
    ):
        """Test that disabled tools are not created."""
        from sdk.tools.gameplay_tools.character_tools import create_character_tools

        mock_is_enabled.return_value = False

        ctx = ToolContext(
            agent_name="TestAgent",
            world_name="test_world",
            world_id=1,
            room_id=1,
            db=AsyncMock(),
        )

        tools = create_character_tools(ctx)
        assert len(tools) == 0


class TestMechanicsToolsCreation:
    """Tests for mechanics tools creation."""

    @patch("sdk.tools.gameplay_tools.mechanics_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.mechanics_tools.get_tool_description")
    def test_create_mechanics_tools_when_disabled(
        self,
        mock_get_description,
        mock_is_enabled,
    ):
        """Test that disabled tools are not created."""
        from sdk.tools.gameplay_tools.mechanics_tools import create_mechanics_tools

        mock_is_enabled.return_value = False

        ctx = ToolContext(
            agent_name="TestAgent",
            world_name="test_world",
            world_id=1,
            db=AsyncMock(),
        )

        tools = create_mechanics_tools(ctx)
        assert len(tools) == 0


class TestLocationToolsCreation:
    """Tests for location tools creation."""

    @patch("sdk.tools.gameplay_tools.location_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.location_tools.get_tool_description")
    def test_create_location_tools_when_disabled(
        self,
        mock_get_description,
        mock_is_enabled,
    ):
        """Test that disabled tools are not created."""
        from sdk.tools.gameplay_tools.location_tools import create_location_tools

        mock_is_enabled.return_value = False

        ctx = ToolContext(
            agent_name="TestAgent",
            world_name="test_world",
            world_id=1,
            db=AsyncMock(),
        )

        tools = create_location_tools(ctx)
        assert len(tools) == 0


class TestActionManagerMCPServer:
    """Tests for action manager MCP server creation."""

    @patch("sdk.tools.gameplay_tools.create_mechanics_tools")
    @patch("sdk.tools.gameplay_tools.create_location_tools")
    @patch("sdk.tools.gameplay_tools.create_character_tools")
    @patch("sdk.tools.gameplay_tools.create_sdk_mcp_server")
    def test_create_action_manager_mcp_server(
        self,
        mock_create_mcp,
        mock_create_char,
        mock_create_loc,
        mock_create_mech,
    ):
        """Test creating action manager MCP server."""
        from sdk.tools.gameplay_tools import create_action_manager_mcp_server

        mock_create_char.return_value = [MagicMock(name="add_character")]
        mock_create_loc.return_value = [MagicMock(name="travel")]
        mock_create_mech.return_value = [MagicMock(name="stat_calc")]
        mock_create_mcp.return_value = MagicMock()

        ctx = ToolContext(
            agent_name="ActionManager",
            world_name="test_world",
            world_id=1,
            room_id=1,
            db=AsyncMock(),
        )

        server = create_action_manager_mcp_server(ctx)

        # All tool creators should be called with the context
        mock_create_char.assert_called_once_with(ctx)
        mock_create_loc.assert_called_once_with(ctx)
        mock_create_mech.assert_called_once_with(ctx)

        # MCP server should be created with all tools combined
        mock_create_mcp.assert_called_once()
        call_args = mock_create_mcp.call_args
        assert call_args.kwargs["name"] == "action_manager"
        assert len(call_args.kwargs["tools"]) == 3
