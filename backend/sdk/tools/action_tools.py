"""
Action tools for agent behavior control.

This module defines MCP tools that agents can use to control their behavior:
- skip: Indicate they don't want to respond to a message
- memorize: Record new memories
- recall: Retrieve detailed long-term memories by subtitle

Uses Pydantic models for type-safe validation of inputs and outputs.
"""

from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool
from domain.value_objects.action_models import (
    MemorizeOutput,
    RecallOutput,
    SkipOutput,
)

from sdk.config.action_inputs import MemorizeInput, RecallInput, SkipInput
from sdk.loaders import get_tool_description, get_tool_response, is_tool_enabled
from sdk.tools.context import ToolContext


def create_action_tools(ctx: ToolContext) -> list:
    """
    Create action tools (skip, memorize, recall) with descriptions loaded from YAML.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of action tool functions configured with agent name
    """
    tools = []

    # Skip tool - agents call this to indicate they DON'T want to respond
    if is_tool_enabled("skip"):
        skip_description = get_tool_description("skip", agent_name=ctx.agent_name, group_name=ctx.group_name)

        @tool("skip", skip_description, SkipInput.model_json_schema())
        async def skip_tool(_args: dict[str, Any]):
            """Tool that agents can call to indicate they want to skip/ignore the message."""
            # Validate input with Pydantic (skip takes no args, so just create empty instance)
            validated_input = SkipInput()

            # Get response and create validated output
            response_text = get_tool_response("skip", group_name=ctx.group_name)
            output = SkipOutput(response=response_text)

            # Return in MCP tool format
            return output.to_tool_response()

        tools.append(skip_tool)

    # Memorize tool - agents call this to record memories
    if is_tool_enabled("memorize"):
        memorize_description = get_tool_description("memorize", agent_name=ctx.agent_name, group_name=ctx.group_name)

        @tool("memorize", memorize_description, MemorizeInput.model_json_schema())
        async def memorize_tool(args: dict[str, Any]):
            """Tool that agents can call to record memories. Writes directly to recent_events.md file."""
            from datetime import datetime

            from services import AgentConfigService

            # Validate input with Pydantic
            validated_input = MemorizeInput(**args)

            # Write directly to file if config_file is available
            if ctx.config_file:
                timestamp = datetime.utcnow()
                success = AgentConfigService.append_to_recent_events(
                    config_file=str(ctx.config_file), memory_entry=validated_input.memory_entry, timestamp=timestamp
                )

                if success:
                    # Invalidate agent config cache since recent_events changed
                    if ctx.agent_id is not None:
                        from infrastructure.cache import agent_config_key, get_cache

                        cache = get_cache()
                        cache.invalidate(agent_config_key(ctx.agent_id))

                    response_text = get_tool_response(
                        "memorize", group_name=ctx.group_name, memory_entry=validated_input.memory_entry
                    )
                else:
                    response_text = f"Failed to record memory: {validated_input.memory_entry}"
            else:
                # Fallback if no config_file (shouldn't happen in practice)
                response_text = f"Memory noted (no config file): {validated_input.memory_entry}"

            output = MemorizeOutput(response=response_text, memory_entry=validated_input.memory_entry)

            # Return in MCP tool format
            return output.to_tool_response()

        tools.append(memorize_tool)

    # Recall tool - agents call this to retrieve long-term memories by subtitle
    long_term_memory_index = ctx.long_term_memory_index or {}
    if is_tool_enabled("recall") and long_term_memory_index:
        # Build list of available subtitles for description
        memory_subtitles = ", ".join(f"'{s}'" for s in long_term_memory_index.keys())
        recall_description = get_tool_description(
            "recall", agent_name=ctx.agent_name, memory_subtitles=memory_subtitles, group_name=ctx.group_name
        )

        @tool("recall", recall_description, RecallInput.model_json_schema())
        async def recall_tool(args: dict[str, Any]):
            """Tool that agents can call to retrieve detailed memories by subtitle."""
            # Validate input with Pydantic
            validated_input = RecallInput(**args)

            # Look up the memory content
            memory_content = long_term_memory_index.get(validated_input.subtitle)

            if memory_content:
                response_text = get_tool_response("recall", group_name=ctx.group_name, memory_content=memory_content)
                output = RecallOutput(
                    response=response_text,
                    success=True,
                    subtitle=validated_input.subtitle,
                    memory_content=memory_content,
                )
            else:
                # If subtitle not found, show available options
                available = ", ".join(f"'{s}'" for s in long_term_memory_index.keys())
                response_text = (
                    f"Memory subtitle '{validated_input.subtitle}' not found. Available subtitles: {available}"
                )
                output = RecallOutput(
                    response=response_text, success=False, subtitle=validated_input.subtitle, memory_content=None
                )

            # Return in MCP tool format
            return output.to_tool_response()

        tools.append(recall_tool)

    return tools


def create_action_mcp_server(ctx: ToolContext):
    """
    Create an MCP server with action tools (skip, memorize, recall).

    These tools control agent behavior and are separate from character-specific configuration.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        MCP server instance with action tools
    """
    action_tools = create_action_tools(ctx)

    return create_sdk_mcp_server(name="action", version="1.0.0", tools=action_tools)
