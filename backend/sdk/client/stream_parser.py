"""StreamParser - Parses Claude Agent SDK streaming messages using typed message classes."""

import logging
from dataclasses import dataclass, field
from typing import Optional

from claude_agent_sdk.types import (
    AssistantMessage,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
)

logger = logging.getLogger(__name__)


@dataclass
class ParsedStreamMessage:
    """Structured result from parsing SDK stream messages.

    Attributes:
        response_text: Accumulated response text (previous + new delta)
        thinking_text: Accumulated thinking text (previous + new delta)
        session_id: Session ID if found in this message, None otherwise
        skip_used: True if skip tool was called in this message
        memory_entries: List of new memory entries from this message
        anthropic_calls: List of anthropic tool call arguments from this message
        structured_output: Structured output data if using output_format (e.g., WorldSeed)
        usage: Token usage data from ResultMessage (input_tokens, output_tokens, cache info)
        tool_start_name: Tool name from content_block_start (tool_use), None otherwise
        tool_input_delta: Partial JSON from input_json_delta, None otherwise
        content_block_stopped: True if content_block_stop event
    """

    response_text: str
    thinking_text: str
    session_id: Optional[str] = None
    skip_used: bool = False
    memory_entries: list[str] = field(default_factory=list)
    anthropic_calls: list[str] = field(default_factory=list)
    structured_output: Optional[dict] = None
    usage: Optional[dict] = None
    tool_start_name: Optional[str] = None
    tool_input_delta: Optional[str] = None
    content_block_stopped: bool = False

    @property
    def has_tool_usage(self) -> bool:
        """Check if any tools were used in this message."""
        return self.skip_used or bool(self.memory_entries) or bool(self.anthropic_calls)


class StreamParser:
    """Parses Claude Agent SDK streaming messages using typed message classes.

    This class is stateless - all methods can be static or class methods.
    """

    @staticmethod
    def parse_message(message, current_response: str, current_thinking: str) -> ParsedStreamMessage:
        """Parse a streaming message from Claude Agent SDK.

        Args:
            message: SDK message (AssistantMessage, SystemMessage, StreamEvent, etc.)
            current_response: Accumulated response text so far
            current_thinking: Accumulated thinking text so far

        Returns:
            ParsedStreamMessage with extracted fields and updated accumulated text
        """
        if isinstance(message, StreamEvent):
            return StreamParser._parse_stream_event(message, current_response, current_thinking)

        content_delta = ""
        thinking_delta = ""
        new_session_id = None
        skip_tool_called = False
        memory_entries: list[str] = []
        anthropic_calls: list[str] = []
        structured_output = None
        usage = None

        if isinstance(message, ResultMessage):
            if message.usage:
                usage = message.usage
                logger.info(f"ResultMessage.usage raw: {type(usage).__name__} = {usage}")
            if message.structured_output:
                structured_output = message.structured_output
                logger.debug(f"Extracted structured_output: {type(structured_output)}")

        if isinstance(message, SystemMessage):
            if "session_id" in message.data:
                new_session_id = message.data["session_id"]
                logger.debug(f"Extracted session_id: {new_session_id}")

        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    if block.name.endswith("__skip"):
                        skip_tool_called = True
                        logger.info("Agent chose to skip")
                    elif block.name.endswith("__memorize"):
                        memory_entry = block.input.get("memory_entry", "")
                        if memory_entry:
                            memory_entries.append(memory_entry)
                            logger.info(f"Agent recorded memory: {memory_entry}")
                    elif block.name.endswith("__anthropic"):
                        situation = block.input.get("situation", "")
                        if situation:
                            anthropic_calls.append(situation)
                            logger.info(f"Agent called anthropic tool: {situation}")
                elif isinstance(block, ThinkingBlock):
                    # Skip if already accumulated from StreamEvent deltas
                    if not current_thinking:
                        thinking_delta = block.thinking
                elif isinstance(block, TextBlock):
                    # Skip if already accumulated from StreamEvent deltas.
                    # AssistantMessage/ResultMessage TextBlocks contain the complete
                    # turn text, not an incremental delta - appending would duplicate.
                    if not current_response:
                        content_delta += block.text

        return ParsedStreamMessage(
            response_text=current_response + content_delta,
            thinking_text=current_thinking + thinking_delta,
            session_id=new_session_id,
            skip_used=skip_tool_called,
            memory_entries=memory_entries,
            anthropic_calls=anthropic_calls,
            structured_output=structured_output,
            usage=usage,
        )

    @staticmethod
    def _parse_stream_event(message: StreamEvent, current_response: str, current_thinking: str) -> ParsedStreamMessage:
        """Parse a StreamEvent containing raw Claude API streaming events.

        StreamEvent.event is a raw Claude API event dict. Handles:
        - content_block_delta with text_delta or thinking_delta (text streaming)
        - content_block_delta with input_json_delta (tool input streaming)
        - content_block_start with tool_use type (tool invocation start)
        - content_block_stop (content block completion)
        """
        event = message.event
        content_delta = ""
        thinking_delta = ""
        tool_start_name = None
        tool_input_delta = None
        content_block_stopped = False

        event_type = event.get("type")

        if event_type == "content_block_delta":
            delta = event.get("delta", {})
            delta_type = delta.get("type", "")

            if delta_type == "text_delta":
                content_delta = delta.get("text", "")
            elif delta_type == "thinking_delta":
                thinking_delta = delta.get("thinking", "")
            elif delta_type == "input_json_delta":
                tool_input_delta = delta.get("partial_json", "")

        elif event_type == "content_block_start":
            content_block = event.get("content_block", {})
            if content_block.get("type") == "tool_use":
                tool_start_name = content_block.get("name", "")

        elif event_type == "content_block_stop":
            content_block_stopped = True

        return ParsedStreamMessage(
            response_text=current_response + content_delta,
            thinking_text=current_thinking + thinking_delta,
            session_id=message.session_id if message.session_id and not current_response else None,
            tool_start_name=tool_start_name,
            tool_input_delta=tool_input_delta,
            content_block_stopped=content_block_stopped,
        )


class NarrationStreamExtractor:
    """Extracts the 'narrative' field value incrementally from streaming JSON tool input.

    The narration tool receives JSON like: {"narrative": "Once upon a time...", "options": [...]}
    This class accumulates partial_json fragments and extracts the narrative string
    value as it streams in, handling JSON escape sequences.
    """

    def __init__(self):
        self._buffer = ""
        self._in_narrative = False
        self._emitted = 0  # chars already returned from narrative value
        self._narrative_value = ""  # decoded narrative so far

    def feed(self, partial_json: str) -> str:
        """Feed a partial JSON fragment and return any new narrative text.

        Args:
            partial_json: A fragment of the JSON tool input

        Returns:
            New narrative text delta (empty string if nothing new yet)
        """
        self._buffer += partial_json

        if not self._in_narrative:
            # Look for the "narrative" key pattern: "narrative": "
            # Also handle "narrative" : " (with optional whitespace)
            marker = '"narrative"'
            idx = self._buffer.find(marker)
            if idx == -1:
                return ""
            # Find the colon and opening quote after the key
            rest = self._buffer[idx + len(marker):]
            # Skip whitespace and colon
            colon_idx = rest.find(":")
            if colon_idx == -1:
                return ""
            after_colon = rest[colon_idx + 1:].lstrip()
            if not after_colon or after_colon[0] != '"':
                return ""
            # Found opening quote - start extracting
            self._in_narrative = True
            # Re-position buffer to just after the opening quote
            full_offset = idx + len(marker) + colon_idx + 1 + (len(rest[colon_idx + 1:]) - len(after_colon)) + 1
            self._buffer = self._buffer[full_offset:]

        # Now extract the string value, handling JSON escapes
        return self._extract_narrative_delta()

    def _extract_narrative_delta(self) -> str:
        """Extract new narrative text from buffer, handling JSON escape sequences."""
        new_text = ""
        i = 0
        while i < len(self._buffer):
            ch = self._buffer[i]
            if ch == '"':
                # End of the JSON string value
                self._buffer = self._buffer[i + 1:]
                break
            elif ch == '\\':
                if i + 1 >= len(self._buffer):
                    # Incomplete escape - keep in buffer for next feed
                    self._buffer = self._buffer[i:]
                    break
                esc = self._buffer[i + 1]
                if esc == 'n':
                    new_text += '\n'
                    i += 2
                elif esc == 't':
                    new_text += '\t'
                    i += 2
                elif esc == '"':
                    new_text += '"'
                    i += 2
                elif esc == '\\':
                    new_text += '\\'
                    i += 2
                elif esc == '/':
                    new_text += '/'
                    i += 2
                elif esc == 'r':
                    new_text += '\r'
                    i += 2
                elif esc == 'b':
                    new_text += '\b'
                    i += 2
                elif esc == 'f':
                    new_text += '\f'
                    i += 2
                elif esc == 'u':
                    if i + 5 < len(self._buffer):
                        hex_str = self._buffer[i + 2:i + 6]
                        try:
                            new_text += chr(int(hex_str, 16))
                        except ValueError:
                            new_text += '\\u' + hex_str
                        i += 6
                    else:
                        # Incomplete unicode escape - keep in buffer
                        self._buffer = self._buffer[i:]
                        break
                else:
                    new_text += esc
                    i += 2
            else:
                new_text += ch
                i += 1
        else:
            # Consumed entire buffer
            self._buffer = ""

        self._narrative_value += new_text
        return new_text
