"""
Unit tests for onboarding tools.

Tests for the complete tool, default world name generation,
and World Seed Generator invocation.
"""

import re
from datetime import datetime
from unittest.mock import MagicMock, patch

from sdk.tools.context import ToolContext
from sdk.tools.gameplay_tools import create_onboarding_mcp_server
from sdk.tools.gameplay_tools.onboarding_tools import (
    create_onboarding_tools,
    generate_default_world_name,
)


class TestGenerateDefaultWorldName:
    """Tests for generate_default_world_name function."""

    def test_returns_string(self):
        """Test that function returns a string."""
        name = generate_default_world_name()
        assert isinstance(name, str)

    def test_format_matches_pattern(self):
        """Test that name matches expected pattern."""
        name = generate_default_world_name()
        # Pattern: world_YYYYMMDD_xxxxxx (6 hex chars)
        pattern = r"^world_\d{8}_[a-f0-9]{6}$"
        assert re.match(pattern, name), f"Name '{name}' doesn't match pattern"

    def test_contains_current_date(self):
        """Test that name contains today's date."""
        name = generate_default_world_name()
        today = datetime.now().strftime("%Y%m%d")
        assert today in name

    def test_unique_names(self):
        """Test that multiple calls generate unique names."""
        names = [generate_default_world_name() for _ in range(100)]
        assert len(names) == len(set(names)), "Generated names should be unique"


class TestCreateOnboardingTools:
    """Tests for create_onboarding_tools function."""

    @patch("sdk.tools.gameplay_tools.onboarding_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.onboarding_tools.get_tool_description")
    def test_creates_complete_tool_when_enabled(self, mock_get_desc, mock_is_enabled):
        """Test that complete tool is created when enabled."""
        mock_is_enabled.return_value = True
        mock_get_desc.return_value = "Complete tool description"

        ctx = ToolContext(agent_name="TestAgent")
        tools = create_onboarding_tools(ctx)

        # 2 tools: persist_world_seed (always) + complete (when enabled)
        assert len(tools) == 2
        tool_names = [t.name for t in tools]
        assert "persist_world_seed" in tool_names
        assert "complete" in tool_names

    @patch("sdk.tools.gameplay_tools.onboarding_tools.is_tool_enabled")
    def test_only_persist_world_seed_when_complete_disabled(self, mock_is_enabled):
        """Test that only persist_world_seed is created when complete is disabled."""
        mock_is_enabled.return_value = False

        ctx = ToolContext(agent_name="TestAgent")
        tools = create_onboarding_tools(ctx)

        # persist_world_seed is always added
        assert len(tools) == 1
        assert tools[0].name == "persist_world_seed"

    @patch("sdk.tools.gameplay_tools.onboarding_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.onboarding_tools.get_tool_description")
    def test_passes_agent_name_to_description(self, mock_get_desc, mock_is_enabled):
        """Test that agent name is passed to get_tool_description."""
        mock_is_enabled.return_value = True
        mock_get_desc.return_value = "Description"

        ctx = ToolContext(agent_name="MyAgent", group_name="mygroup")
        create_onboarding_tools(ctx)

        mock_get_desc.assert_called_once_with("complete", agent_name="MyAgent", group_name="mygroup")


class TestCreateOnboardingMCPServer:
    """Tests for create_onboarding_mcp_server function."""

    @patch("sdk.tools.gameplay_tools.create_sdk_mcp_server")
    @patch("sdk.tools.gameplay_tools.create_onboarding_tools")
    def test_creates_mcp_server(self, mock_create_tools, mock_create_mcp):
        """Test that MCP server is created."""
        mock_tools = [MagicMock()]
        mock_create_tools.return_value = mock_tools
        mock_create_mcp.return_value = MagicMock()

        ctx = ToolContext(agent_name="TestAgent")
        server = create_onboarding_mcp_server(ctx)

        mock_create_mcp.assert_called_once_with(name="onboarding", version="1.0.0", tools=mock_tools)
        assert server is not None

    @patch("sdk.tools.gameplay_tools.create_sdk_mcp_server")
    @patch("sdk.tools.gameplay_tools.create_onboarding_tools")
    def test_passes_context(self, mock_create_tools, mock_create_mcp):
        """Test that context is passed correctly."""
        mock_create_tools.return_value = []
        mock_create_mcp.return_value = MagicMock()

        ctx = ToolContext(
            agent_name="Agent",
            world_name="TestWorld",
            group_name="mygroup",
        )
        create_onboarding_mcp_server(ctx)

        mock_create_tools.assert_called_once_with(ctx)


class TestCompleteTool:
    """Tests for the complete tool functionality.

    Note: These tests verify the tool creation with mocked dependencies.
    The actual tool execution is tested via integration tests as the
    SDK tool wrapper doesn't expose the function directly.
    """

    @patch("sdk.tools.gameplay_tools.onboarding_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.onboarding_tools.get_tool_description")
    def test_complete_tool_created_with_correct_schema(self, mock_get_desc, mock_is_enabled):
        """Test that complete tool is created with correct schema."""
        mock_is_enabled.return_value = True
        mock_get_desc.return_value = "Complete description"

        ctx = ToolContext(agent_name="TestAgent", world_name="MyWorld")
        tools = create_onboarding_tools(ctx)

        # 2 tools: persist_world_seed + complete
        assert len(tools) == 2
        complete_tool = next(t for t in tools if t.name == "complete")

        # Verify schema has required fields in properties
        schema = complete_tool.input_schema
        properties = schema.get("properties", {})
        assert "genre" in properties
        assert "theme" in properties
        assert "lore" in properties

    @patch("sdk.tools.gameplay_tools.onboarding_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.onboarding_tools.get_tool_description")
    def test_complete_tool_description_includes_agent_name(self, mock_get_desc, mock_is_enabled):
        """Test that tool description is fetched with agent name."""
        mock_is_enabled.return_value = True
        mock_get_desc.return_value = "TestAgent should use this tool"

        ctx = ToolContext(agent_name="TestAgent", world_name="MyWorld")
        create_onboarding_tools(ctx)

        mock_get_desc.assert_called_with("complete", agent_name="TestAgent", group_name=None)

    @patch("sdk.tools.gameplay_tools.onboarding_tools.is_tool_enabled")
    @patch("sdk.tools.gameplay_tools.onboarding_tools.get_tool_description")
    def test_complete_tool_created_without_world_name(self, mock_get_desc, mock_is_enabled):
        """Test that tool is created even without world_name."""
        mock_is_enabled.return_value = True
        mock_get_desc.return_value = "Complete description"

        # Create tools without world_name - should still work
        ctx = ToolContext(agent_name="TestAgent", world_name=None)
        tools = create_onboarding_tools(ctx)

        # 2 tools: persist_world_seed + complete
        assert len(tools) == 2
        tool_names = [t.name for t in tools]
        assert "complete" in tool_names
