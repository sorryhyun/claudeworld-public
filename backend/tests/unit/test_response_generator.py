"""
Unit tests for ResponseGenerator.

Tests response generation logic and message handling.
"""

import time
from datetime import datetime
from unittest.mock import AsyncMock, Mock, patch

import pytest
from domain.value_objects.contexts import OrchestrationContext
from orchestration.response_generator import ResponseGenerator


class TestResponseGeneratorInit:
    """Tests for ResponseGenerator initialization."""

    def test_init(self):
        """Test initialization."""
        last_user_msg_time = {1: 123.456}
        generator = ResponseGenerator(last_user_msg_time)

        assert generator.last_user_message_time == last_user_msg_time


class TestGenerateResponse:
    """Tests for generate_response method."""

    @pytest.mark.asyncio
    async def test_generate_response_basic_flow(self):
        """Test basic response generation."""
        generator = ResponseGenerator({})

        mock_db = AsyncMock()
        mock_agent_manager = Mock()  # Use Mock instead of AsyncMock for generate_sdk_response
        mock_agent = Mock()
        mock_agent.configure_mock(id=1, system_prompt="You are Alice", profile_pic=None, group=None)
        mock_agent.name = "Alice"  # name is special in Mock, set separately
        mock_agent.get_config_data.return_value = Mock(in_a_nutshell="Brief", long_term_memory_index=None)

        orch_context = OrchestrationContext(db=mock_db, room_id=1, agent_manager=mock_agent_manager)

        # Mock dependencies
        mock_room = Mock(created_at=datetime.utcnow(), agents=[mock_agent], is_paused=False, world=None)
        mock_messages = []

        # Mock streaming response - define as async generator
        async def mock_stream_response():
            yield {"type": "stream_start", "temp_id": "temp_123"}
            yield {"type": "content_delta", "delta": "Hello"}
            yield {
                "type": "stream_end",
                "response_text": "Hello",
                "thinking_text": "",
                "session_id": "session_123",
                "memory_entries": [],
                "skipped": False,
            }

        # Configure mock to return async generator when called
        mock_agent_manager.generate_sdk_response = Mock(side_effect=lambda ctx: mock_stream_response())

        with (
            patch("orchestration.response_generator.crud.get_room_cached", new=AsyncMock(return_value=mock_room)),
            patch(
                "orchestration.response_generator.crud.get_messages_after_agent_response_cached",
                new=AsyncMock(return_value=mock_messages),
            ),
            patch("orchestration.response_generator.crud.get_room_agent_session", return_value=None),
            patch("orchestration.response_generator.crud.update_room_agent_session", new=AsyncMock()),
            patch(
                "orchestration.response_generator.crud.create_message",
                new=AsyncMock(return_value=Mock(id=1, timestamp=datetime.utcnow())),
            ),
            patch("orchestration.response_generator.build_conversation_context", return_value="Context"),
            patch("orchestration.response_generator.save_agent_message", new=AsyncMock(return_value=1)),
        ):
            responded = await generator.generate_response(
                orch_context=orch_context, agent=mock_agent, user_message_content="Hello"
            )

            # Should return True (agent responded)
            assert responded is True

    @pytest.mark.asyncio
    async def test_generate_response_handles_skip(self):
        """Test when agent chooses to skip."""
        generator = ResponseGenerator({})

        mock_db = AsyncMock()
        mock_agent_manager = Mock()
        mock_agent = Mock()
        mock_agent.configure_mock(id=1, system_prompt="Prompt", profile_pic=None, group=None)
        mock_agent.name = "Alice"  # name is special in Mock, set separately
        mock_agent.get_config_data.return_value = Mock(long_term_memory_index=None)

        orch_context = OrchestrationContext(db=mock_db, room_id=1, agent_manager=mock_agent_manager)

        # Mock skip response
        async def mock_stream_skip():
            yield {"type": "stream_start", "temp_id": "temp_123"}
            yield {
                "type": "stream_end",
                "response_text": None,
                "thinking_text": "",
                "session_id": "session_123",
                "memory_entries": [],
                "skipped": True,
            }

        mock_agent_manager.generate_sdk_response = Mock(side_effect=lambda ctx: mock_stream_skip())

        with (
            patch(
                "orchestration.response_generator.crud.get_room_cached",
                new=AsyncMock(
                    return_value=Mock(created_at=datetime.utcnow(), agents=[mock_agent], is_paused=False, world=None)
                ),
            ),
            patch(
                "orchestration.response_generator.crud.get_messages_after_agent_response_cached",
                new=AsyncMock(return_value=[]),
            ),
            patch("orchestration.response_generator.crud.get_room_agent_session", return_value=None),
            patch("orchestration.response_generator.crud.update_room_agent_session", new=AsyncMock()),
            patch(
                "orchestration.response_generator.crud.create_message",
                new=AsyncMock(return_value=Mock(id=1, timestamp=datetime.utcnow())),
            ),
            patch("orchestration.response_generator.build_conversation_context", return_value="Context"),
        ):
            responded = await generator.generate_response(
                orch_context=orch_context, agent=mock_agent, user_message_content="Hello"
            )

            # Should return False (agent skipped)
            assert responded is False

    @pytest.mark.asyncio
    async def test_generate_response_checks_interruption(self):
        """Test that interrupted responses are discarded."""
        generator = ResponseGenerator({1: time.time() + 1000})  # Future time = interrupted

        mock_db = AsyncMock()
        mock_agent_manager = Mock()
        mock_agent = Mock()
        mock_agent.configure_mock(id=1, system_prompt="Prompt", profile_pic=None, group=None)
        mock_agent.name = "Alice"  # name is special in Mock, set separately
        mock_agent.get_config_data.return_value = Mock(long_term_memory_index=None)

        orch_context = OrchestrationContext(db=mock_db, room_id=1, agent_manager=mock_agent_manager)

        # Mock response
        async def mock_stream():
            yield {"type": "stream_start", "temp_id": "temp_123"}
            yield {
                "type": "stream_end",
                "response_text": "Response",
                "thinking_text": "",
                "session_id": "session_123",
                "memory_entries": [],
                "skipped": False,
            }

        mock_agent_manager.generate_sdk_response = Mock(side_effect=lambda ctx: mock_stream())

        with (
            patch(
                "orchestration.response_generator.crud.get_room_cached",
                new=AsyncMock(
                    return_value=Mock(created_at=datetime.utcnow(), agents=[mock_agent], is_paused=False, world=None)
                ),
            ),
            patch(
                "orchestration.response_generator.crud.get_messages_after_agent_response_cached",
                new=AsyncMock(return_value=[]),
            ),
            patch("orchestration.response_generator.crud.get_room_agent_session", return_value=None),
            patch("orchestration.response_generator.crud.update_room_agent_session", new=AsyncMock()),
            patch("orchestration.response_generator.build_conversation_context", return_value="Context"),
        ):
            responded = await generator.generate_response(
                orch_context=orch_context, agent=mock_agent, user_message_content="Hello"
            )

            # Should return False (response was interrupted)
            assert responded is False

    @pytest.mark.asyncio
    async def test_generate_response_checks_paused_room(self):
        """Test that responses are discarded if room was paused."""
        generator = ResponseGenerator({})

        mock_db = AsyncMock()
        mock_agent_manager = Mock()
        mock_agent = Mock()
        mock_agent.configure_mock(id=1, system_prompt="Prompt", profile_pic=None, group=None)
        mock_agent.name = "Alice"  # name is special in Mock, set separately
        mock_agent.get_config_data.return_value = Mock(long_term_memory_index=None)

        orch_context = OrchestrationContext(db=mock_db, room_id=1, agent_manager=mock_agent_manager)

        # Mock response
        async def mock_stream():
            yield {"type": "stream_start", "temp_id": "temp_123"}
            yield {
                "type": "stream_end",
                "response_text": "Response",
                "thinking_text": "",
                "session_id": "session_123",
                "memory_entries": [],
                "skipped": False,
            }

        mock_agent_manager.generate_sdk_response = Mock(side_effect=lambda ctx: mock_stream())

        # Room is paused
        paused_room = Mock(created_at=datetime.utcnow(), agents=[mock_agent], is_paused=True, world=None)

        with (
            patch("orchestration.response_generator.crud.get_room_cached", new=AsyncMock(return_value=paused_room)),
            patch(
                "orchestration.response_generator.crud.get_messages_after_agent_response_cached",
                new=AsyncMock(return_value=[]),
            ),
            patch("orchestration.response_generator.crud.get_room_agent_session", return_value=None),
            patch("orchestration.response_generator.crud.update_room_agent_session", new=AsyncMock()),
            patch("orchestration.response_generator.build_conversation_context", return_value="Context"),
        ):
            responded = await generator.generate_response(
                orch_context=orch_context, agent=mock_agent, user_message_content="Hello"
            )

            # Should return False (room was paused)
            assert responded is False

    @pytest.mark.asyncio
    async def test_generate_response_skip_if_no_new_messages(self):
        """Test skipping when no new messages in follow-up round."""
        generator = ResponseGenerator({})

        mock_db = AsyncMock()
        mock_agent_manager = AsyncMock()
        mock_agent = Mock(id=1, name="Alice")
        mock_agent.get_config_data.return_value = Mock()

        orch_context = OrchestrationContext(db=mock_db, room_id=1, agent_manager=mock_agent_manager)

        with (
            patch(
                "orchestration.response_generator.crud.get_room_cached",
                new=AsyncMock(return_value=Mock(created_at=datetime.utcnow(), agents=[mock_agent])),
            ),
            patch(
                "orchestration.response_generator.crud.get_messages_after_agent_response_cached",
                new=AsyncMock(return_value=[]),
            ),
            patch("orchestration.response_generator.crud.get_room_agent_session", return_value=None),
            patch("orchestration.response_generator.build_conversation_context", return_value=""),
        ):  # Empty context
            responded = await generator.generate_response(
                orch_context=orch_context,
                agent=mock_agent,
                user_message_content=None,  # Follow-up round
            )

            # Should return False (no new messages)
            assert responded is False
