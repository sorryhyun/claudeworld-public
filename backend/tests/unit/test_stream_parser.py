"""
Unit tests for StreamParser - SDK message parsing logic.
"""

from claude_agent_sdk.types import (
    AssistantMessage,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
)

from sdk.client.stream_parser import ParsedStreamMessage, StreamParser


def _assistant(content: list, **kwargs) -> AssistantMessage:
    """Helper to create AssistantMessage with sensible defaults."""
    return AssistantMessage(content=content, model="test", **kwargs)


def _result(**kwargs) -> ResultMessage:
    """Helper to create ResultMessage with sensible defaults."""
    defaults = dict(subtype="result", duration_ms=0, duration_api_ms=0, is_error=False, num_turns=1, session_id="s1")
    defaults.update(kwargs)
    return ResultMessage(**defaults)


def _stream_event(event: dict, session_id: str = "s1") -> StreamEvent:
    """Helper to create StreamEvent with sensible defaults."""
    return StreamEvent(uuid="u1", session_id=session_id, event=event)


class TestParsedStreamMessage:
    """Test ParsedStreamMessage dataclass."""

    def test_has_tool_usage_with_skip(self):
        msg = ParsedStreamMessage(response_text="Hello", thinking_text="", skip_used=True, memory_entries=[])
        assert msg.has_tool_usage is True

    def test_has_tool_usage_with_memory(self):
        msg = ParsedStreamMessage(
            response_text="Hello", thinking_text="", skip_used=False, memory_entries=["Test memory"]
        )
        assert msg.has_tool_usage is True

    def test_has_tool_usage_with_both(self):
        msg = ParsedStreamMessage(
            response_text="Hello", thinking_text="", skip_used=True, memory_entries=["Memory 1", "Memory 2"]
        )
        assert msg.has_tool_usage is True

    def test_has_tool_usage_with_none(self):
        msg = ParsedStreamMessage(response_text="Hello", thinking_text="", skip_used=False, memory_entries=[])
        assert msg.has_tool_usage is False

    def test_default_values(self):
        msg = ParsedStreamMessage(response_text="Hello", thinking_text="World")
        assert msg.session_id is None
        assert msg.skip_used is False
        assert msg.memory_entries == []
        assert msg.structured_output is None

    def test_structured_output(self):
        structured_data = {"stat_system": {"stats": []}, "initial_location": {"name": "test"}}
        msg = ParsedStreamMessage(
            response_text="Hello",
            thinking_text="",
            structured_output=structured_data,
        )
        assert msg.structured_output == structured_data


class TestStreamParser:
    """Test StreamParser message parsing logic."""

    def test_parse_text_block(self):
        message = _assistant([TextBlock(text="Hello, world!")])

        result = StreamParser.parse_message(message, "", "")

        assert result.response_text == "Hello, world!"
        assert result.thinking_text == ""
        assert result.session_id is None
        assert not result.has_tool_usage

    def test_parse_thinking_block(self):
        message = _assistant([ThinkingBlock(thinking="Agent is thinking...", signature="sig")])

        result = StreamParser.parse_message(message, "", "")

        assert result.response_text == ""
        assert result.thinking_text == "Agent is thinking..."

    def test_parse_skip_tool_call(self):
        message = _assistant([ToolUseBlock(id="t1", name="agent_name__skip", input={})])

        result = StreamParser.parse_message(message, "", "")

        assert result.skip_used is True
        assert result.has_tool_usage is True

    def test_parse_memorize_tool_call(self):
        message = _assistant([
            ToolUseBlock(id="t1", name="agent_name__memorize", input={"memory_entry": "Important memory to save"})
        ])

        result = StreamParser.parse_message(message, "", "")

        assert result.memory_entries == ["Important memory to save"]
        assert result.has_tool_usage is True

    def test_parse_anthropic_tool_call(self):
        message = _assistant([
            ToolUseBlock(id="t1", name="agent__anthropic", input={"situation": "Need help"})
        ])

        result = StreamParser.parse_message(message, "", "")

        assert result.anthropic_calls == ["Need help"]
        assert result.has_tool_usage is True

    def test_parse_multiple_memory_entries(self):
        message = _assistant([
            ToolUseBlock(id="t1", name="agent__memorize", input={"memory_entry": "Memory 1"}),
            ToolUseBlock(id="t2", name="agent__memorize", input={"memory_entry": "Memory 2"}),
        ])

        result = StreamParser.parse_message(message, "", "")

        assert result.memory_entries == ["Memory 1", "Memory 2"]

    def test_parse_system_message_with_session_id(self):
        message = SystemMessage(subtype="sessionStarted", data={"session_id": "sess_abc123", "other": "data"})

        result = StreamParser.parse_message(message, "", "")

        assert result.session_id == "sess_abc123"

    def test_parse_system_message_without_session_id(self):
        message = SystemMessage(subtype="sessionStarted", data={"other": "data"})

        result = StreamParser.parse_message(message, "", "")

        assert result.session_id is None

    def test_parse_accumulated_text(self):
        message = _assistant([TextBlock(text=" more text")])

        result = StreamParser.parse_message(message, "Previous", "Existing thinking")

        assert result.response_text == "Previous more text"
        assert result.thinking_text == "Existing thinking"

    def test_parse_mixed_content_blocks(self):
        message = _assistant([
            TextBlock(text="Hello"),
            ThinkingBlock(thinking="Processing...", signature="sig"),
            ToolUseBlock(id="t1", name="agent__skip", input={}),
        ])

        result = StreamParser.parse_message(message, "", "")

        assert result.response_text == "Hello"
        assert result.thinking_text == "Processing..."
        assert result.skip_used is True

    def test_parse_multiple_text_blocks(self):
        message = _assistant([
            TextBlock(text="Part 1 "),
            TextBlock(text="Part 2"),
        ])

        result = StreamParser.parse_message(message, "", "")

        assert result.response_text == "Part 1 Part 2"

    def test_parse_memorize_without_memory_entry(self):
        message = _assistant([
            ToolUseBlock(id="t1", name="agent__memorize", input={"other_field": "value"})
        ])

        result = StreamParser.parse_message(message, "", "")

        assert result.memory_entries == []

    def test_parse_memorize_with_empty_memory_entry(self):
        message = _assistant([
            ToolUseBlock(id="t1", name="agent__memorize", input={"memory_entry": ""})
        ])

        result = StreamParser.parse_message(message, "", "")

        assert result.memory_entries == []

    def test_parse_unknown_tool_call(self):
        message = _assistant([
            ToolUseBlock(id="t1", name="agent__unknown_tool", input={})
        ])

        result = StreamParser.parse_message(message, "", "")

        assert not result.skip_used
        assert result.memory_entries == []
        assert not result.has_tool_usage

    def test_parse_result_message_with_structured_output(self):
        structured_data = {
            "stat_system": {"stats": [{"name": "health", "display": "HP", "default": 100}]},
            "initial_location": {"name": "test_location", "display_name": "Test Location"},
        }
        message = _result(structured_output=structured_data)

        result = StreamParser.parse_message(message, "", "")

        assert result.structured_output is not None
        assert result.structured_output["stat_system"]["stats"][0]["name"] == "health"

    def test_parse_result_message_without_structured_output(self):
        message = _result()

        result = StreamParser.parse_message(message, "", "")

        assert result.structured_output is None

    def test_parse_result_message_with_usage(self):
        message = _result(usage={"input_tokens": 100, "output_tokens": 50})

        result = StreamParser.parse_message(message, "", "")

        assert result.usage == {"input_tokens": 100, "output_tokens": 50}

    def test_parse_stream_event_text_delta(self):
        message = _stream_event({
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": "Hello"},
        })

        result = StreamParser.parse_message(message, "", "")

        assert result.response_text == "Hello"
        assert result.thinking_text == ""

    def test_parse_stream_event_thinking_delta(self):
        message = _stream_event({
            "type": "content_block_delta",
            "delta": {"type": "thinking_delta", "thinking": "Hmm..."},
        })

        result = StreamParser.parse_message(message, "", "")

        assert result.response_text == ""
        assert result.thinking_text == "Hmm..."

    def test_parse_stream_event_session_id_on_first_message(self):
        message = _stream_event({"type": "message_start"}, session_id="sess_123")

        result = StreamParser.parse_message(message, "", "")

        assert result.session_id == "sess_123"

    def test_parse_stream_event_session_id_suppressed_after_content(self):
        message = _stream_event({"type": "message_start"}, session_id="sess_123")

        result = StreamParser.parse_message(message, "already has content", "")

        assert result.session_id is None

    def test_parse_stream_event_irrelevant_event(self):
        message = _stream_event({"type": "message_stop"})

        result = StreamParser.parse_message(message, "existing", "thinking")

        assert result.response_text == "existing"
        assert result.thinking_text == "thinking"

    def test_parse_non_content_message_preserves_accumulated(self):
        """Non-content messages (e.g. SystemMessage without session_id) preserve accumulated text."""
        message = SystemMessage(subtype="other", data={})

        result = StreamParser.parse_message(message, "Existing", "Thinking")

        assert result.response_text == "Existing"
        assert result.thinking_text == "Thinking"
        assert result.session_id is None
        assert not result.has_tool_usage
