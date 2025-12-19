"""
Hook factory functions for Claude Agent SDK.

This module provides functions to create various hooks used during agent
response generation, including prompt tracking, tool capture, and subagent handling.
"""

from __future__ import annotations

import json
import logging
import os
from typing import TYPE_CHECKING, Any, Callable, Coroutine

from claude_agent_sdk.types import (
    HookMatcher,
    PostToolUseHookInput,
    PreToolUseHookInput,
    SyncHookJSONOutput,
    UserPromptSubmitHookInput,
)
from infrastructure.logging.perf_logger import get_perf_logger

from sdk.parsing.location_parser import parse_location_from_task_prompt
from sdk.tools.fake_tool_executor import execute_fake_tool_call, parse_fake_tool_calls

if TYPE_CHECKING:
    from domain.value_objects.contexts import AgentResponseContext

logger = logging.getLogger(__name__)
_perf = get_perf_logger()

# Type alias for hook functions
HookFunc = Callable[..., Coroutine[Any, Any, SyncHookJSONOutput]]


def create_prompt_submit_hook(
    agent_name: str,
    room_id: int,
) -> HookFunc:
    """
    Create a UserPromptSubmit hook to track when prompts are submitted.

    Args:
        agent_name: Name of the agent for logging
        room_id: Room ID for logging

    Returns:
        Async hook function
    """

    async def track_prompt_submit(
        input_data: UserPromptSubmitHookInput,
        _tool_use_id: str | None,
        _ctx: dict,
    ) -> SyncHookJSONOutput:
        """Hook to track when prompt is submitted to Claude API."""
        _perf.log_sync(
            "prompt_submitted",
            0,  # No duration calculation, just timestamp
            agent_name,
            room_id,
            prompt_len=len(input_data.get("prompt", "")),
        )
        return {"continue_": True}

    return track_prompt_submit


def create_anthropic_capture_hook(
    anthropic_calls_capture: list[str],
) -> HookFunc:
    """
    Create a PostToolUse hook to capture anthropic tool calls.

    Args:
        anthropic_calls_capture: List to append captured situations to

    Returns:
        Async hook function
    """

    async def capture_anthropic_tool(
        input_data: PostToolUseHookInput,
        _tool_use_id: str | None,
        _ctx: dict,
    ) -> SyncHookJSONOutput:
        """Hook to capture anthropic tool calls."""
        tool_name = input_data.get("tool_name", "")
        if tool_name.endswith("__anthropic"):
            tool_input = input_data.get("tool_input", {})
            situation = tool_input.get("situation", "")
            if situation:
                anthropic_calls_capture.append(situation)
                logger.info(f"🔒 Hook captured anthropic tool call: {situation[:100]}...")
        return {"continue_": True}

    return capture_anthropic_tool


def create_subagent_stop_hook(
    context: AgentResponseContext,
) -> HookFunc:
    """
    Create a SubagentStop hook to handle fake tool calls when subagents complete.

    This is crucial for run_in_background: true where parent may not wait for results.
    The hook reads subagent output and executes any fake tool calls found.

    Args:
        context: Agent response context for tool execution

    Returns:
        Async hook function
    """

    async def handle_subagent_stop(
        input_data: dict,
        _tool_use_id: str | None,
        _ctx: dict,
    ) -> SyncHookJSONOutput:
        """Hook to handle fake tool calls when subagent completes."""
        logger.info(f"🔔 SubagentStop hook fired. Input keys: {list(input_data.keys())}")

        # Try to get agent_id and read the output file
        agent_id = input_data.get("agent_id")
        transcript_path = input_data.get("agent_transcript_path")

        logger.info(f"🔔 SubagentStop: agent_id={agent_id}, transcript_path={transcript_path}")

        # Try to read the output file if we have agent_id
        output_text = ""
        if agent_id:
            # The SDK writes output to /tmp/claude/{cwd}/tasks/{agent_id}.output
            possible_paths = [
                f"/tmp/claude/-tmp-claude-empty/tasks/{agent_id}.output",
                f"/tmp/claude/tasks/{agent_id}.output",
            ]
            for path in possible_paths:
                if os.path.exists(path):
                    try:
                        with open(path, encoding="utf-8") as f:
                            output_text = f.read()
                        logger.info(f"🔔 Read subagent output from {path} ({len(output_text)} chars)")
                        break
                    except Exception as e:
                        logger.warning(f"Failed to read {path}: {e}")

        # If we have transcript path, try reading from there
        if not output_text and transcript_path:
            try:
                with open(transcript_path, encoding="utf-8") as f:
                    for line in f:
                        try:
                            entry = json.loads(line)
                            # Look for assistant messages with text content
                            if entry.get("type") == "assistant":
                                msg = entry.get("message", {})
                                for content in msg.get("content", []):
                                    if content.get("type") == "text":
                                        output_text += content.get("text", "")
                        except json.JSONDecodeError:
                            continue
                logger.info(f"🔔 Extracted output from transcript ({len(output_text)} chars)")
            except Exception as e:
                logger.warning(f"Failed to read transcript: {e}")

        # Check for fake tool calls
        if not output_text:
            logger.info("🔔 SubagentStop: No output text found")
            return {"continue_": True}

        # Log first 500 chars of output for debugging
        logger.info(f"🔔 SubagentStop output preview: {output_text[:500]}...")

        # Check for fake tool calls (XML or JSON format)
        has_xml = "<function_calls>" in output_text
        has_json = "{" in output_text and "}" in output_text

        if not has_xml and not has_json:
            logger.info("🔔 SubagentStop: No potential tool calls found in output")
            return {"continue_": True}

        logger.info(f"🔔 SubagentStop: Found potential tool calls (XML={has_xml}, JSON={has_json}), parsing...")

        # Parse and execute fake tool calls
        fake_calls = parse_fake_tool_calls(output_text)
        if not fake_calls:
            logger.warning("Found <function_calls> marker but failed to parse any calls")
            return {"continue_": True}

        # Build ToolContext for execution
        from sdk.tools.context import ToolContext

        tool_ctx = ToolContext(
            agent_name=context.agent_name,
            agent_id=context.agent_id,
            room_id=context.room_id,
            world_name=context.world_name,
            world_id=context.world_id,
            db=context.db,
            group_name=context.group_name,
        )

        # Execute each fake tool call
        for call in fake_calls:
            result = await execute_fake_tool_call(call, tool_ctx)
            if result:
                logger.info(f"🔔 Fake tool executed: {call.tool_name} -> success={result.get('success')}")

        return {"continue_": True}

    return handle_subagent_stop


def create_pre_task_location_hook(
    context: AgentResponseContext,
) -> HookFunc:
    """
    Create a PreToolUse hook to create draft locations when location_designer is invoked.

    This allows travel to proceed immediately while design runs in background.

    Args:
        context: Agent response context for location creation

    Returns:
        Async hook function
    """

    async def handle_pre_task_location(
        input_data: PreToolUseHookInput,
        _tool_use_id: str | None,
        _ctx: dict,
    ) -> SyncHookJSONOutput:
        """Create draft location when location_designer Task is invoked."""
        tool_name = input_data.get("tool_name", "")
        if tool_name != "Task":
            return {"continue_": True}

        tool_input = input_data.get("tool_input", {})
        subagent_type = tool_input.get("subagent_type", "")
        if subagent_type != "location_designer":
            return {"continue_": True}

        # Access context via closure
        if not context.db or not context.world_id or not context.world_name:
            logger.warning("PreToolUse: Missing context for draft location creation")
            return {"continue_": True}

        prompt = tool_input.get("prompt", "")
        location_info = parse_location_from_task_prompt(prompt)

        if not location_info:
            logger.warning("PreToolUse: Could not parse location info from prompt")
            return {"continue_": True}

        logger.info(f"🏗️ PreToolUse: Creating draft location '{location_info.get('display_name')}'")

        try:
            from services.persistence_manager import PersistenceManager

            pm = PersistenceManager(context.db, context.world_id, context.world_name)
            await pm.create_draft_location(
                name=location_info["name"],
                display_name=location_info["display_name"],
                description=location_info.get("description", "A newly discovered area."),
                position=location_info.get("position", (0, 0)),
                adjacent_hints=location_info.get("adjacent_to"),
            )
            logger.info(f"✅ Draft location created: {location_info['display_name']}")
        except Exception as e:
            logger.warning(f"Failed to create draft location: {e}")

        return {"continue_": True}

    return handle_pre_task_location


def build_hooks(
    context: AgentResponseContext,
    anthropic_calls_capture: list[str] | None = None,
) -> dict | None:
    """
    Build all hooks for agent response generation.

    Args:
        context: Agent response context
        anthropic_calls_capture: Optional list to capture anthropic tool call situations

    Returns:
        Dict of hooks to pass to ClaudeAgentOptions, or None if no hooks
    """
    hooks: dict = {}

    # Add UserPromptSubmit hook to track when prompt is submitted
    hooks["UserPromptSubmit"] = [
        HookMatcher(
            matcher=None,
            hooks=[create_prompt_submit_hook(context.agent_name, context.room_id)],
        )
    ]

    # Add PostToolUse hook to capture anthropic tool calls
    if anthropic_calls_capture is not None:
        hooks["PostToolUse"] = [
            HookMatcher(
                matcher="mcp__guidelines__anthropic",
                hooks=[create_anthropic_capture_hook(anthropic_calls_capture)],
            )
        ]

    # Add SubagentStop hook
    if "SubagentStop" not in hooks:
        hooks["SubagentStop"] = []
    hooks["SubagentStop"].append(
        HookMatcher(
            matcher=None,
            hooks=[create_subagent_stop_hook(context)],
        )
    )

    # Add PreToolUse hook for Task tool (location_designer)
    if "PreToolUse" not in hooks:
        hooks["PreToolUse"] = []
    hooks["PreToolUse"].append(
        HookMatcher(
            matcher="Task",
            hooks=[create_pre_task_location_hook(context)],
        )
    )

    return hooks if hooks else None
