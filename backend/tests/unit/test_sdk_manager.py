"""
Unit tests for SDK AgentManager.

Tests agent manager functionality including client pooling,
interruption handling, and response generation.
"""

import asyncio
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import pytest
from claude_agent_sdk.types import (
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
)
from domain.entities.agent_config import AgentConfigData
from domain.value_objects.contexts import AgentResponseContext
from domain.value_objects.task_identifier import TaskIdentifier
from sdk import AgentManager, ClientPool
from sdk.agent.options_builder import build_agent_options
from sdk.client.client_pool import PooledClient


class TestAgentManagerInit:
    """Tests for AgentManager initialization."""

    def test_init_creates_empty_state(self):
        """Test that AgentManager initializes with empty state."""
        manager = AgentManager()

        assert manager.active_clients == {}
        assert isinstance(manager.client_pool, ClientPool)
        assert manager.client_pool.pool == {}


class TestInterruptAll:
    """Tests for interrupt_all method."""

    @pytest.mark.asyncio
    async def test_interrupt_all_with_clients(self):
        """Test interrupting all active clients."""
        manager = AgentManager()

        # Create mock clients
        mock_client1 = AsyncMock()
        mock_client2 = AsyncMock()

        manager.active_clients = {
            TaskIdentifier(room_id=1, agent_id=1): mock_client1,
            TaskIdentifier(room_id=1, agent_id=2): mock_client2,
        }

        await manager.interrupt_all()

        # Verify both clients were interrupted
        mock_client1.interrupt.assert_awaited_once()
        mock_client2.interrupt.assert_awaited_once()

        # Verify active_clients was cleared
        assert manager.active_clients == {}

    @pytest.mark.asyncio
    async def test_interrupt_all_with_no_clients(self):
        """Test interrupt_all with no active clients."""
        manager = AgentManager()

        # Should not raise any errors
        await manager.interrupt_all()

        assert manager.active_clients == {}

    @pytest.mark.asyncio
    async def test_interrupt_all_handles_errors(self):
        """Test that interrupt_all handles client errors gracefully."""
        manager = AgentManager()

        # Create mock client that raises error on interrupt
        mock_client = AsyncMock()
        mock_client.interrupt.side_effect = Exception("Interrupt failed")

        manager.active_clients = {TaskIdentifier(room_id=1, agent_id=1): mock_client}

        # Should not raise - error is logged
        await manager.interrupt_all()

        # Active clients still cleared despite error
        assert manager.active_clients == {}


class TestInterruptRoom:
    """Tests for interrupt_room method."""

    @pytest.mark.asyncio
    async def test_interrupt_room_with_matching_clients(self):
        """Test interrupting clients in a specific room."""
        manager = AgentManager()

        # Create mock clients for different rooms
        mock_client_room1 = AsyncMock()
        mock_client_room2 = AsyncMock()

        manager.active_clients = {
            TaskIdentifier(room_id=1, agent_id=1): mock_client_room1,
            TaskIdentifier(room_id=2, agent_id=1): mock_client_room2,
        }

        await manager.interrupt_room(1)

        # Only room 1 client should be interrupted
        mock_client_room1.interrupt.assert_awaited_once()
        mock_client_room2.interrupt.assert_not_awaited()

        # Only room 1 task should be removed
        assert TaskIdentifier(room_id=1, agent_id=1) not in manager.active_clients
        assert TaskIdentifier(room_id=2, agent_id=1) in manager.active_clients

    @pytest.mark.asyncio
    async def test_interrupt_room_with_no_matching_clients(self):
        """Test interrupt_room when no clients match the room."""
        manager = AgentManager()

        mock_client = AsyncMock()
        manager.active_clients = {TaskIdentifier(room_id=2, agent_id=1): mock_client}

        await manager.interrupt_room(1)

        # Client should not be interrupted
        mock_client.interrupt.assert_not_awaited()
        assert TaskIdentifier(room_id=2, agent_id=1) in manager.active_clients


class TestBuildAgentOptions:
    """Tests for build_agent_options function."""

    def test_build_agent_options_basic(self):
        """Test building basic agent options."""
        config = AgentConfigData(in_a_nutshell="Test agent", characteristics="Friendly", recent_events="Recent event")

        context = Mock(agent_name="TestAgent", config=config, session_id=None, output_format=None)

        # Mock the MCP registry
        mock_registry = Mock()
        mock_mcp_config = Mock()
        mock_mcp_config.mcp_servers = {"guidelines": Mock(), "action": Mock()}
        mock_mcp_config.allowed_tool_names = ["mcp__guidelines__*", "mcp__action__*"]
        mock_mcp_config.config_hash = "test_hash"
        mock_registry.build_mcp_config.return_value = mock_mcp_config

        with patch("sdk.agent.options_builder.get_mcp_registry", return_value=mock_registry):
            with patch("sdk.agent.options_builder.build_subagent_definitions_for_agent", return_value=None):
                options, config_hash = build_agent_options(context, "System prompt")

                # Verify options were created correctly
                assert options.system_prompt == "System prompt"
                # Model is hardcoded to opus in options_builder.py (or sonnet if USE_SONNET)
                assert options.model is not None and "claude" in options.model
                # Adaptive thinking replaced the deprecated max_thinking_tokens budget.
                # display="summarized" is load-bearing: the models omit thinking text
                # without it, and ThinkingPreview in the UI renders it.
                assert options.thinking == {"type": "adaptive", "display": "summarized"}
                assert isinstance(options.mcp_servers, dict)
                assert "guidelines" in options.mcp_servers
                assert "action" in options.mcp_servers
                assert config_hash == "test_hash"

    def test_build_agent_options_with_session(self):
        """Test building options with session ID."""
        config = AgentConfigData(in_a_nutshell="Test")
        context = Mock(agent_name="TestAgent", config=config, session_id="test_session_123", output_format=None)

        # Mock the MCP registry
        mock_registry = Mock()
        mock_mcp_config = Mock()
        mock_mcp_config.mcp_servers = {}
        mock_mcp_config.allowed_tool_names = []
        mock_mcp_config.config_hash = "test_hash"
        mock_registry.build_mcp_config.return_value = mock_mcp_config

        with patch("sdk.agent.options_builder.get_mcp_registry", return_value=mock_registry):
            with patch("sdk.agent.options_builder.build_subagent_definitions_for_agent", return_value=None):
                options, config_hash = build_agent_options(context, "System prompt")

                # Should include resume session
                assert options.resume == "test_session_123"


class _CancellingQueue:
    """Stands in for PooledClient.msg_queue and cancels the consumer.

    Mirrors what interrupt_room does in production: the response task is parked
    on ``await pooled.msg_queue.get()`` when it gets cancelled.
    """

    async def get(self):
        raise asyncio.CancelledError()


def _pooled(messages: list[Any] | None = None, *, queue: Any = None) -> tuple[Any, Any]:
    """Build a (PooledClient, mock_client) pair for generate_sdk_response.

    generate_sdk_response does not read ``client.receive_response()`` -- a pump
    task in ClientPool drains the client into ``pooled.msg_queue`` and the
    generator reads only from that queue. So the queue is what tests must fill,
    and it needs to be a real asyncio.Queue (or a stub with an async ``get``):
    an AsyncMock queue hands back a fresh MagicMock forever, which is neither the
    ``None`` sentinel nor a ResultMessage, so the read loop never terminates.
    """
    mock_client = AsyncMock()

    if queue is None:
        queue = asyncio.Queue()
        for message in messages or []:
            queue.put_nowait(message)
        # End sentinel, in case no ResultMessage terminates the loop first.
        queue.put_nowait(None)

    return PooledClient(client=mock_client, config_hash="test_hash", msg_queue=queue), mock_client


def _context(**overrides) -> AgentResponseContext:
    """Build an AgentResponseContext with test defaults."""
    defaults = dict(
        system_prompt="Test prompt",
        user_message="Hello",
        agent_name="TestAgent",
        config=AgentConfigData(in_a_nutshell="Test"),
        room_id=1,
        agent_id=1,
        session_id=None,
        task_id=TaskIdentifier(room_id=1, agent_id=1),
    )
    defaults.update(overrides)
    return AgentResponseContext(**defaults)


def _result_message(**overrides) -> ResultMessage:
    """Terminal message that ends generate_sdk_response's read loop."""
    defaults = dict(
        subtype="result",
        duration_ms=0,
        duration_api_ms=0,
        is_error=False,
        num_turns=1,
        session_id="session123",
    )
    defaults.update(overrides)
    return ResultMessage(**defaults)


class TestGenerateSDKResponse:
    """Tests for generate_sdk_response async generator."""

    @pytest.mark.asyncio
    async def test_generate_response_basic_flow(self):
        """Test basic response generation flow."""
        manager = AgentManager()
        context = _context()

        pooled, _ = _pooled([
            SystemMessage(subtype="init", data={"session_id": "session123"}),
            AssistantMessage(content=[TextBlock(text="Hello")], model="test"),
            _result_message(),
        ])

        with (
            patch.object(manager.client_pool, "get_or_create", return_value=(pooled, True, asyncio.Lock())),
            patch("sdk.agent.agent_manager.write_debug_log"),
            patch("sdk.agent.agent_manager.append_response_to_debug_log"),
        ):
            events = [event async for event in manager.generate_sdk_response(context)]

        # Should have stream_start and stream_end events
        assert events[0]["type"] == "stream_start"
        assert events[-1]["type"] == "stream_end"
        assert events[-1]["session_id"] == "session123"
        assert events[-1]["response_text"] == "Hello"
        assert events[-1]["skipped"] is False

        # Client should be registered and unregistered
        assert TaskIdentifier(room_id=1, agent_id=1) not in manager.active_clients
        # The new session is written back to the pooled client for the next turn
        assert pooled.session_id == "session123"

    @pytest.mark.asyncio
    async def test_generate_response_stops_at_end_sentinel(self):
        """A None sentinel from the pump ends the stream even without a ResultMessage."""
        manager = AgentManager()
        context = _context()

        pooled, _ = _pooled([AssistantMessage(content=[TextBlock(text="Partial")], model="test")])

        with (
            patch.object(manager.client_pool, "get_or_create", return_value=(pooled, True, asyncio.Lock())),
            patch("sdk.agent.agent_manager.write_debug_log"),
            patch("sdk.agent.agent_manager.append_response_to_debug_log"),
        ):
            events = [event async for event in manager.generate_sdk_response(context)]

        assert events[-1]["type"] == "stream_end"
        assert events[-1]["response_text"] == "Partial"

    @pytest.mark.asyncio
    async def test_generate_response_handles_cancellation(self):
        """Test response generation handles cancellation."""
        manager = AgentManager()
        context = _context()

        pooled, _ = _pooled(queue=_CancellingQueue())

        with (
            patch.object(manager.client_pool, "get_or_create", return_value=(pooled, True, asyncio.Lock())),
            patch("sdk.agent.agent_manager.write_debug_log"),
            patch("sdk.agent.agent_manager.append_response_to_debug_log"),
        ):
            events = [event async for event in manager.generate_sdk_response(context)]

        # Should yield stream_end with skipped=True
        assert events[-1]["type"] == "stream_end"
        assert events[-1]["skipped"] is True
        assert events[-1]["response_text"] is None
        # Cancellation must still unregister the client
        assert TaskIdentifier(room_id=1, agent_id=1) not in manager.active_clients

    @pytest.mark.asyncio
    async def test_generate_response_handles_errors(self):
        """Test response generation handles errors gracefully."""
        manager = AgentManager()
        context = _context()

        pooled, mock_client = _pooled([_result_message()])
        # The failure has to be on the pooled client -- that is what the
        # generator calls (`pooled.client.query`).
        mock_client.query.side_effect = Exception("Connection error")

        with (
            patch.object(manager.client_pool, "get_or_create", return_value=(pooled, True, asyncio.Lock())),
            patch("sdk.agent.agent_manager.write_debug_log"),
            patch("sdk.agent.agent_manager.append_response_to_debug_log"),
        ):
            events = [event async for event in manager.generate_sdk_response(context)]

        # Should yield error in stream_end
        assert events[-1]["type"] == "stream_end"
        assert "Error" in events[-1]["response_text"]
        assert "Connection error" in events[-1]["response_text"]
        assert TaskIdentifier(room_id=1, agent_id=1) not in manager.active_clients
