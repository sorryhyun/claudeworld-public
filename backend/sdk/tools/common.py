"""
Common utilities for tool handlers.

This module provides:
- Response helpers for creating standardized MCP tool responses
- Error handling decorator for consistent exception handling
- Formatting utilities for common patterns
"""

import logging
from functools import wraps
from typing import TYPE_CHECKING, Any, Callable, TypeVar

from pydantic import ValidationError as PydanticValidationError

from sdk.tools.errors import ToolError

if TYPE_CHECKING:
    from sdk.tools.context import ToolContext

logger = logging.getLogger(__name__)

# Type variable for generic async functions
F = TypeVar("F", bound=Callable[..., Any])


# =============================================================================
# Response Helpers
# =============================================================================


def tool_response(text: str) -> dict[str, Any]:
    """Create standardized MCP tool response for simple text output.

    Use this for tools that return a simple string response.
    For tools with structured output, use output model classes with `to_tool_response()`.

    Args:
        text: The text content to return.

    Returns:
        MCP-formatted tool response dictionary.

    Example:
        >>> return tool_response("Action completed successfully.")
        {"content": [{"type": "text", "text": "Action completed successfully."}]}
    """
    return {"content": [{"type": "text", "text": text}]}


def tool_error(message: str) -> dict[str, Any]:
    """Create error response with is_error flag.

    Args:
        message: The error message to return.

    Returns:
        MCP-formatted error response dictionary with is_error=True.

    Example:
        >>> return tool_error("Character not found.")
        {"content": [{"type": "text", "text": "Error: Character not found."}], "is_error": True}
    """
    return {
        "content": [{"type": "text", "text": f"Error: {message}"}],
        "is_error": True,
    }


def tool_error_raw(message: str) -> dict[str, Any]:
    """Create error response without 'Error:' prefix.

    Use when you want to control the exact error message format.

    Args:
        message: The error message to return (used as-is).

    Returns:
        MCP-formatted error response dictionary with is_error=True.
    """
    return {
        "content": [{"type": "text", "text": message}],
        "is_error": True,
    }


# =============================================================================
# Error Handling Decorator
# =============================================================================


def with_error_handling(func: F) -> F:
    """Decorator to standardize error handling for tool handlers.

    This decorator catches common exceptions and converts them to
    appropriate MCP tool responses. It handles:
    - PydanticValidationError: Input validation failures
    - ToolError: Custom tool-specific errors
    - Exception: Unexpected errors (logged with traceback)

    The wrapped function should have signature:
        async def handler(args: dict[str, Any], ctx: ToolContext) -> dict

    Args:
        func: The async tool handler function to wrap.

    Returns:
        Wrapped function with error handling.

    Example:
        @with_error_handling
        async def my_handler(args: dict[str, Any], ctx: ToolContext) -> dict:
            validated = MyInput(**args)  # Raises PydanticValidationError if invalid
            if not found:
                raise ResourceNotFoundError("Item not found")
            return tool_response("Success!")
    """

    @wraps(func)
    async def wrapper(args: dict[str, Any], ctx: "ToolContext") -> dict[str, Any]:
        try:
            return await func(args, ctx)
        except PydanticValidationError as e:
            # Extract first validation error message
            errors = e.errors()
            if errors:
                first_error = errors[0]
                field = first_error.get("loc", ("input",))[-1]
                msg = first_error.get("msg", "Invalid value")
                error_msg = f"Invalid input for '{field}': {msg}"
            else:
                error_msg = "Invalid input"
            logger.warning(f"Validation error in {func.__name__}: {error_msg}")
            return tool_error(error_msg)
        except ToolError as e:
            logger.warning(f"Tool error in {func.__name__}: {e.message}")
            return tool_error(e.message)
        except Exception:
            logger.exception(f"Unexpected error in {func.__name__}")
            return tool_error("An unexpected error occurred. Please try again.")

    return wrapper  # type: ignore[return-value]


def with_error_handling_simple(func: F) -> F:
    """Simpler error handling decorator for handlers without ToolContext.

    Use this for tool handlers that only take args dict (legacy pattern).

    The wrapped function should have signature:
        async def handler(args: dict[str, Any]) -> dict

    Args:
        func: The async tool handler function to wrap.

    Returns:
        Wrapped function with error handling.
    """

    @wraps(func)
    async def wrapper(args: dict[str, Any]) -> dict[str, Any]:
        try:
            return await func(args)
        except PydanticValidationError as e:
            errors = e.errors()
            if errors:
                first_error = errors[0]
                field = first_error.get("loc", ("input",))[-1]
                msg = first_error.get("msg", "Invalid value")
                error_msg = f"Invalid input for '{field}': {msg}"
            else:
                error_msg = "Invalid input"
            logger.warning(f"Validation error in {func.__name__}: {error_msg}")
            return tool_error(error_msg)
        except ToolError as e:
            logger.warning(f"Tool error in {func.__name__}: {e.message}")
            return tool_error(e.message)
        except Exception:
            logger.exception(f"Unexpected error in {func.__name__}")
            return tool_error("An unexpected error occurred. Please try again.")

    return wrapper  # type: ignore[return-value]


# =============================================================================
# Formatting Utilities
# =============================================================================


def format_list(items: list[str], title: str, empty_message: str = "None available.") -> str:
    """Format a list of items for display.

    Args:
        items: List of item names.
        title: Header title for the list.
        empty_message: Message to show if list is empty.

    Returns:
        Formatted string with title and bulleted list.

    Example:
        >>> format_list(["Alice", "Bob"], "Characters")
        "Characters:\\n- Alice\\n- Bob"
    """
    if not items:
        return empty_message
    return f"{title}:\n" + "\n".join(f"- {item}" for item in items)


def format_character_list(characters: list[str]) -> str:
    """Format a list of characters for display.

    Args:
        characters: List of character names.

    Returns:
        Formatted string listing available characters.
    """
    return format_list(characters, "Available characters", "No characters available.")


def format_location_list(locations: list[str]) -> str:
    """Format a list of locations for display.

    Args:
        locations: List of location names.

    Returns:
        Formatted string listing available locations.
    """
    return format_list(locations, "Available locations", "No locations available.")


def format_memory_list(memories: list[str]) -> str:
    """Format a list of memory subtitles for display.

    Args:
        memories: List of memory subtitle names.

    Returns:
        Formatted string listing available memories.
    """
    return format_list(memories, "Available memories", "No memories available.")
