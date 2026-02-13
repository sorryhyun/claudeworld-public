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
    """

    response_text: str
    thinking_text: str
    session_id: Optional[str] = None
    skip_used: bool = False
    memory_entries: list[str] = field(default_factory=list)
    anthropic_calls: list[str] = field(default_factory=list)
    structured_output: Optional[dict] = None
    usage: Optional[dict] = None

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
                    thinking_delta = block.thinking
                elif isinstance(block, TextBlock):
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

        StreamEvent.event is a raw Claude API event dict. Only content_block_delta
        events with text_delta or thinking_delta subtypes carry useful content.
        """
        event = message.event
        content_delta = ""
        thinking_delta = ""

        if event.get("type") == "content_block_delta":
            delta = event.get("delta", {})
            delta_type = delta.get("type", "")

            if delta_type == "text_delta":
                content_delta = delta.get("text", "")
            elif delta_type == "thinking_delta":
                thinking_delta = delta.get("thinking", "")

        return ParsedStreamMessage(
            response_text=current_response + content_delta,
            thinking_text=current_thinking + thinking_delta,
            session_id=message.session_id if message.session_id and not current_response else None,
        )
