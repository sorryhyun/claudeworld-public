"""
Unit tests for orchestration context builder.

Tests conversation context building from room messages.
"""

import os
from unittest.mock import Mock, patch

from domain.value_objects.contexts import ConversationContextParams, ConversationMode
from orchestration.context import build_conversation_context


class TestBuildConversationContext:
    """Tests for build_conversation_context function."""

    @patch("orchestration.context.get_conversation_context_config")
    def test_build_context_with_no_messages(self, mock_get_config):
        """Test building context with no messages."""
        mock_get_config.return_value = {
            "conversation_context": {
                "header": "Conversation:",
                "footer": "",
            }
        }

        params = ConversationContextParams(messages=[])
        context = build_conversation_context(params)

        assert context == ""

    @patch("orchestration.context.get_conversation_context_config")
    @patch("orchestration.context._settings")
    def test_build_context_with_user_messages(self, mock_settings, mock_get_config):
        """Test building context with user messages."""
        mock_get_config.return_value = {
            "conversation_context": {
                "header": "Conversation:",
                "footer": "",
            }
        }

        # Mock the settings object to return our test user name
        mock_settings.user_name = "TestUser"

        # Create mock messages with image_data=None and images=None to avoid Mock truthiness
        msg1 = Mock(
            role="user",
            content="Hello!",
            participant_type="user",
            participant_name=None,
            agent_id=None,
            image_data=None,
            images=None,
        )

        msg2 = Mock(
            role="user",
            content="How are you?",
            participant_type="user",
            participant_name=None,
            agent_id=None,
            image_data=None,
            images=None,
        )

        params = ConversationContextParams(messages=[msg1, msg2])
        context = build_conversation_context(params)

        assert "Conversation:" in context
        assert "TestUser: Hello!" in context
        assert "TestUser: How are you?" in context

    @patch("orchestration.context.get_conversation_context_config")
    def test_build_context_with_agent_messages(self, mock_get_config):
        """Test building context with agent messages."""
        mock_get_config.return_value = {"conversation_context": {"header": "Conversation:", "footer": ""}}

        # Create mock agent with name attribute properly set
        mock_agent = Mock()
        mock_agent.name = "Alice"

        msg = Mock(role="assistant", content="Hi there!", agent_id=1, agent=mock_agent, image_data=None, images=None)

        params = ConversationContextParams(messages=[msg])
        context = build_conversation_context(params)

        assert "Alice: Hi there!" in context

    @patch("orchestration.context.get_conversation_context_config")
    def test_build_context_skips_skip_messages(self, mock_get_config):
        """Test that skip messages are excluded from context."""
        mock_get_config.return_value = {"conversation_context": {"header": "Conversation:", "footer": ""}}

        # Import SKIP_MESSAGE_TEXT
        from core.settings import SKIP_MESSAGE_TEXT

        msg1 = Mock(
            role="assistant",
            content=SKIP_MESSAGE_TEXT,
            agent_id=1,
            agent=Mock(name="Alice"),
            image_data=None,
            images=None,
        )

        msg2 = Mock(
            role="assistant", content="Real message", agent_id=2, agent=Mock(name="Bob"), image_data=None, images=None
        )

        params = ConversationContextParams(messages=[msg1, msg2])
        context = build_conversation_context(params)

        # Should not include skip message
        assert SKIP_MESSAGE_TEXT not in context
        assert "Real message" in context

    @patch("orchestration.context.get_conversation_context_config")
    def test_build_context_with_agent_id_filter(self, mock_get_config):
        """Test building context with agent filter (only new messages)."""
        mock_get_config.return_value = {"conversation_context": {"header": "Conversation:", "footer": ""}}

        # Create mock agent for filtering
        mock_agent = Mock()
        mock_agent.id = 1
        mock_agent.name = "Alice"
        mock_agent.group = None

        # Create messages before and after agent's last response
        messages = [
            Mock(
                role="user", content="Message 1", agent_id=None, participant_type="user", image_data=None, images=None
            ),
            Mock(
                role="assistant",
                content="Agent response",
                agent_id=1,
                agent=Mock(name="Alice"),
                image_data=None,
                images=None,
            ),
            Mock(
                role="user", content="Message 2", agent_id=None, participant_type="user", image_data=None, images=None
            ),
            Mock(
                role="user", content="Message 3", agent_id=None, participant_type="user", image_data=None, images=None
            ),
        ]

        with patch.dict(os.environ, {"USER_NAME": "User"}):
            params = ConversationContextParams(messages=messages, agent=mock_agent)
            context = build_conversation_context(params)

        # Should only include messages after agent's last response
        assert "Message 1" not in context
        assert "Agent response" not in context
        assert "Message 2" in context
        assert "Message 3" in context

    @patch("orchestration.context.get_conversation_context_config")
    def test_build_context_with_limit(self, mock_get_config):
        """Test building context respects message limit."""
        mock_get_config.return_value = {"conversation_context": {"header": "", "footer": ""}}

        # Create many messages
        messages = [
            Mock(
                role="user",
                content=f"Message {i}",
                agent_id=None,
                participant_type="user",
                image_data=None,
                images=None,
            )
            for i in range(100)
        ]

        params = ConversationContextParams(messages=messages, limit=5)
        context = build_conversation_context(params)

        # Should only include last 5 messages (+ header/footer)
        assert "Message 95" in context
        assert "Message 99" in context
        assert "Message 0" not in context
        assert "Message 90" not in context

    @patch("orchestration.context.get_conversation_context_config")
    def test_build_context_with_character_participant(self, mock_get_config):
        """Test building context with character participant type."""
        mock_get_config.return_value = {"conversation_context": {"header": "", "footer": ""}}

        msg = Mock(
            role="user",
            content="Hello from character!",
            participant_type="character",
            participant_name="Charlie",
            agent_id=None,
            image_data=None,
            images=None,
        )

        params = ConversationContextParams(messages=[msg])
        context = build_conversation_context(params)

        # Should use participant_name as speaker
        assert "Charlie: Hello from character!" in context

    @patch("orchestration.context.get_conversation_context_config")
    @patch("orchestration.context.format_with_particles")
    def test_build_context_chat_mode_with_user_instruction(self, mock_format_particles, mock_get_config):
        """Test chat mode conversation instruction with user."""
        mock_get_config.return_value = {
            "conversation_context": {
                "header": "",
                "footer": "",
                "response_agent": {
                    "en": "Respond to {user_name}.",
                    "ko": "Respond to {user_name}.",
                    "jp": "Respond to {user_name}.",
                },
            }
        }
        mock_format_particles.return_value = "Respond to TestUser."

        # Create mock agent
        mock_agent = Mock()
        mock_agent.id = 1
        mock_agent.name = "Alice"
        mock_agent.group = None

        msg = Mock(
            role="user",
            content="Hello",
            participant_type="user",
            participant_name=None,
            agent_id=None,
            image_data=None,
            images=None,
        )

        params = ConversationContextParams(
            messages=[msg], agent=mock_agent, agent_count=1, mode=ConversationMode.CHAT, world_user_name="TestUser"
        )
        context = build_conversation_context(params)

        # Should use response_agent instruction template
        mock_format_particles.assert_called_once()
        assert "Respond to TestUser." in context

    @patch("orchestration.context.get_conversation_context_config")
    @patch("orchestration.context.format_with_particles")
    def test_build_context_multi_agent_instruction(self, mock_format_particles, mock_get_config):
        """Test multi-agent conversation instruction."""
        mock_get_config.return_value = {
            "conversation_context": {
                "header": "",
                "footer": "",
                "response_agent": {
                    "en": "Respond as {agent_name}.",
                    "ko": "Respond as {agent_name}.",
                    "jp": "Respond as {agent_name}.",
                },
            }
        }
        mock_format_particles.return_value = "Respond as Alice."

        # Create mock agent
        mock_agent = Mock()
        mock_agent.id = 1
        mock_agent.name = "Alice"
        mock_agent.group = None

        msg = Mock(
            role="user",
            content="Hello everyone",
            participant_type="user",
            participant_name=None,
            agent_id=None,
            image_data=None,
            images=None,
        )

        params = ConversationContextParams(
            messages=[msg],
            agent=mock_agent,
            agent_count=3,  # Multiple agents
            mode=ConversationMode.GAME,
            world_user_name="TestUser",
        )
        context = build_conversation_context(params)

        # Should use response_agent instruction template
        mock_format_particles.assert_called_once()
        assert "Respond as Alice." in context

    @patch("orchestration.context.get_conversation_context_config")
    def test_build_context_deduplicates_messages(self, mock_get_config):
        """Test that duplicate messages are filtered out."""
        mock_get_config.return_value = {"conversation_context": {"header": "", "footer": ""}}

        # Create duplicate messages
        messages = [
            Mock(
                role="user",
                content="Same message",
                agent_id=None,
                participant_type="user",
                participant_name=None,
                image_data=None,
                images=None,
            ),
            Mock(
                role="user",
                content="Same message",
                agent_id=None,
                participant_type="user",
                participant_name=None,
                image_data=None,
                images=None,
            ),
            Mock(
                role="user",
                content="Different message",
                agent_id=None,
                participant_type="user",
                participant_name=None,
                image_data=None,
                images=None,
            ),
        ]

        with patch.dict(os.environ, {"USER_NAME": "User"}):
            params = ConversationContextParams(messages=messages)
            context = build_conversation_context(params)

        # Should only include "Same message" once
        assert context.count("Same message") == 1
        assert "Different message" in context

    @patch("orchestration.context.get_conversation_context_config")
    def test_build_context_keeps_only_latest_action_manager_message(self, mock_get_config):
        """Test that only the most recent Action Manager message is kept when flag is set."""
        mock_get_config.return_value = {"conversation_context": {"header": "", "footer": ""}}

        # Create mock agent
        action_manager = Mock()
        action_manager.name = "Action_Manager"

        # Create messages with multiple Action Manager narrations
        messages = [
            Mock(
                role="user",
                content="First player action",
                agent_id=None,
                participant_type="user",
                participant_name="카즈마",
                image_data=None,
                images=None,
            ),
            Mock(
                role="assistant",
                content="Old GM narration - should be filtered",
                agent_id=1,
                agent=action_manager,
                image_data=None,
                images=None,
            ),
            Mock(
                role="user",
                content="Second player action",
                agent_id=None,
                participant_type="user",
                participant_name="카즈마",
                image_data=None,
                images=None,
            ),
            Mock(
                role="assistant",
                content="Latest GM narration - should be kept",
                agent_id=1,
                agent=action_manager,
                image_data=None,
                images=None,
            ),
            Mock(
                role="user",
                content="Third player action",
                agent_id=None,
                participant_type="user",
                participant_name="카즈마",
                image_data=None,
                images=None,
            ),
        ]

        # Without flag - all Action Manager messages should be included
        params_all = ConversationContextParams(messages=messages, keep_only_latest_action_manager=False)
        context_all = build_conversation_context(params_all)
        assert "Old GM narration" in context_all
        assert "Latest GM narration" in context_all

        # With flag - only the LATEST Action Manager message should be kept
        params_latest = ConversationContextParams(messages=messages, keep_only_latest_action_manager=True)
        context_latest_only = build_conversation_context(params_latest)
        assert "Old GM narration" not in context_latest_only  # Older one filtered
        assert "Latest GM narration" in context_latest_only  # Latest one kept
        assert "First player action" in context_latest_only
        assert "Second player action" in context_latest_only
        assert "Third player action" in context_latest_only
