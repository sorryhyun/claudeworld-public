"""
Slash command parser for chat mode.

Parses player input for /chat and /end commands to control chat mode.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class SlashCommandType(Enum):
    """Types of slash commands supported."""

    CHAT = "chat"  # Enter chat mode
    END = "end"  # Exit chat mode
    NONE = "none"  # Not a slash command


@dataclass
class ParsedCommand:
    """Result of parsing a slash command."""

    command_type: SlashCommandType
    args: Optional[str] = None


def parse_slash_command(action_text: str) -> ParsedCommand:
    """
    Parse action text for slash commands.

    Args:
        action_text: The player's input text

    Returns:
        ParsedCommand with the command type and any arguments

    Examples:
        >>> parse_slash_command("/chat")
        ParsedCommand(command_type=SlashCommandType.CHAT, args=None)
        >>> parse_slash_command("/end")
        ParsedCommand(command_type=SlashCommandType.END, args=None)
        >>> parse_slash_command("hello world")
        ParsedCommand(command_type=SlashCommandType.NONE, args=None)
    """
    text = action_text.strip()

    # Check for /chat command
    if text.lower() == "/chat":
        return ParsedCommand(SlashCommandType.CHAT)

    # Check for /end command
    if text.lower() == "/end":
        return ParsedCommand(SlashCommandType.END)

    # Not a recognized slash command
    return ParsedCommand(SlashCommandType.NONE)
