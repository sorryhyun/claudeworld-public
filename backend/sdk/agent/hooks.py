"""
Hook factory functions for Claude Agent SDK.

This module provides functions to create various hooks used during agent
response generation, including prompt tracking, tool capture, and subagent handling.
"""

from __future__ import annotations

import logging
import time
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

if TYPE_CHECKING:
    from domain.value_objects.contexts import AgentResponseContext

logger = logging.getLogger(__name__)
_perf = get_perf_logger()

# Track subagent invocation times by agent_id for duration calculation
_subagent_start_times: dict[
    str, tuple[float, str, int, str]
] = {}  # agent_id -> (start_time, parent_agent, room_id, subagent_type)

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
        """Hook to track when prompt is submitted to Claude API.

        Note: user_prompt_chars is the character length of the user message string,
        NOT the actual API token count. Real token usage comes from api_usage phase.
        """
        _perf.log_sync(
            "prompt_submitted",
            0,  # No duration calculation, just timestamp
            agent_name,
            room_id,
            user_prompt_chars=len(input_data.get("prompt", "")),
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
    Create a SubagentStop hook to track when subagents complete.

    This hook logs subagent completion for performance monitoring and calculates
    the duration from start (tracked by PreToolUse hook) to stop.

    Args:
        context: Agent response context for logging

    Returns:
        Async hook function
    """

    async def handle_subagent_stop(
        input_data: dict,
        tool_use_id: str | None,
        _ctx: dict,
    ) -> SyncHookJSONOutput:
        """Hook to log when subagent completes."""
        stop_time = time.perf_counter()
        logger.info(f"🔔 SubagentStop hook fired. Input keys: {list(input_data.keys())}")

        # Try to get agent_id
        agent_id = input_data.get("agent_id")
        logger.info(f"🔔 SubagentStop: agent_id={agent_id}")

        # Calculate subagent duration if we have start time
        subagent_type = "unknown"
        parent_agent = context.agent_name
        room_id = context.room_id
        duration_ms = 0.0
        matched_key = None

        # Try to find start time in order of reliability:
        # 1. tool_use_id (most reliable - same ID from pre/post hooks)
        # 2. agent_id (from SubagentStop input)
        # 3. composite key (room:subagent_type fallback)

        keys_to_try = [k for k in [tool_use_id, agent_id] if k]
        for key in keys_to_try:
            if key in _subagent_start_times:
                start_time, parent_agent, room_id, subagent_type = _subagent_start_times.pop(key)
                duration_ms = (stop_time - start_time) * 1000
                matched_key = key
                logger.debug(f"Matched subagent by key: {key}, duration: {duration_ms:.2f}ms")
                break

        if matched_key is None:
            # Try composite key matching by room_id
            for k, (start, parent, rid, stype) in list(_subagent_start_times.items()):
                # Clean up old entries (older than 5 minutes)
                if (stop_time - start) > 300:
                    del _subagent_start_times[k]
                    continue
                # Match by composite key pattern or same room
                if rid == context.room_id:
                    duration_ms = (stop_time - start) * 1000
                    subagent_type = stype
                    parent_agent = parent
                    matched_key = k
                    del _subagent_start_times[k]
                    # Also clean up related composite key if exists
                    composite = f"{rid}:{stype}"
                    _subagent_start_times.pop(composite, None)
                    logger.debug(f"Matched subagent by room fallback: {k}, duration: {duration_ms:.2f}ms")
                    break

        if matched_key is None:
            logger.warning(
                f"Could not match subagent stop to start. Keys available: {list(_subagent_start_times.keys())}"
            )

        # Log subagent completion
        await _perf.log_async(
            "subagent_completed",
            duration_ms,
            subagent_type,
            room_id,
            parent=parent_agent,
            success=True,
        )

        return {"continue_": True}

    return handle_subagent_stop


def create_pre_task_subagent_hook(
    context: AgentResponseContext,
) -> HookFunc:
    """
    Create a PreToolUse hook to track when any Task tool (subagent) is invoked.

    This logs the subagent invocation for performance monitoring and stores
    the start time for duration calculation when the subagent completes.

    Args:
        context: Agent response context for logging

    Returns:
        Async hook function
    """

    async def track_subagent_invocation(
        input_data: PreToolUseHookInput,
        tool_use_id: str | None,
        _ctx: dict,
    ) -> SyncHookJSONOutput:
        """Track when any subagent Task is invoked."""
        tool_name = input_data.get("tool_name", "")
        if tool_name != "Task":
            return {"continue_": True}

        tool_input = input_data.get("tool_input", {})
        subagent_type = tool_input.get("subagent_type", "")
        run_in_background = tool_input.get("run_in_background", False)

        if not subagent_type:
            return {"continue_": True}

        # Store start time for duration calculation
        # Key priority: tool_use_id first (most reliable), then composite key
        # The composite key helps match when tool_use_id isn't available in SubagentStop
        start_time = time.perf_counter()
        start_data = (start_time, context.agent_name, context.room_id, subagent_type)

        # Store by tool_use_id (primary)
        if tool_use_id:
            _subagent_start_times[tool_use_id] = start_data
            logger.debug(f"Stored subagent start time with tool_use_id: {tool_use_id}")

        # Also store by composite key for fallback matching
        composite_key = f"{context.room_id}:{subagent_type}"
        _subagent_start_times[composite_key] = start_data
        logger.debug(f"Stored subagent start time with composite key: {composite_key}")

        # Log subagent invocation
        _perf.log_sync(
            "subagent_invoked",
            0.0,  # No duration yet
            context.agent_name,
            context.room_id,
            subagent=subagent_type,
            background=run_in_background,
            tool_use_id=tool_use_id or "none",
        )

        return {"continue_": True}

    return track_subagent_invocation


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

        # Check required context values (db not needed - we create fresh session)
        if not context.world_id or not context.world_name:
            logger.warning("PreToolUse: Missing context for draft location creation")
            return {"continue_": True}

        prompt = tool_input.get("prompt", "")
        location_info = parse_location_from_task_prompt(prompt)

        if not location_info:
            logger.warning("PreToolUse: Could not parse location info from prompt")
            return {"continue_": True}

        logger.info(f"🏗️ PreToolUse: Creating draft location '{location_info.get('display_name')}'")

        try:
            # Use a fresh DB session to avoid concurrent operation errors
            # The parent agent's session (context.db) may be in use by other operations
            from infrastructure.database.connection import async_session_maker
            from services.persistence_manager import PersistenceManager

            async with async_session_maker() as fresh_db:
                pm = PersistenceManager(fresh_db, context.world_id, context.world_name)
                await pm.create_draft_location(
                    name=location_info["name"],
                    display_name=location_info["display_name"],
                    description=location_info.get("description", "A newly discovered area."),
                    position=location_info.get("position", (0, 0)),
                    adjacent_hints=location_info.get("adjacent_to"),
                )
                await fresh_db.commit()
            logger.info(f"✅ Draft location created: {location_info['display_name']}")
        except Exception as e:
            logger.warning(f"Failed to create draft location: {e}")

        return {"continue_": True}

    return handle_pre_task_location


def create_post_task_location_hook() -> HookFunc:
    """
    Create a PostToolUse hook to add context message when location_designer completes.

    This informs the user that the location is now accessible.

    Returns:
        Async hook function
    """

    async def handle_post_task_location(
        input_data: PostToolUseHookInput,
        _tool_use_id: str | None,
        _ctx: dict,
    ) -> SyncHookJSONOutput:
        """Add context message when location_designer Task is launched."""
        tool_name = input_data.get("tool_name", "")
        if tool_name != "Task":
            return {"continue_": True}

        tool_input = input_data.get("tool_input", {})
        subagent_type = tool_input.get("subagent_type", "")
        if subagent_type != "location_designer":
            return {"continue_": True}

        logger.info("🏗️ PostToolUse: location_designer task launched, adding context message")

        return {
            "continue_": True,
            "hookSpecificOutput": {
                "hookEventName": input_data.get("hook_event_name", "PostToolUse"),
                "additionalContext": (
                    "The location has been created and is now accessible. "
                    "Players can travel to this location immediately."
                ),
            },
        }

    return handle_post_task_location


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

    # Add PostToolUse hooks
    if "PostToolUse" not in hooks:
        hooks["PostToolUse"] = []

    # Capture anthropic tool calls if requested
    if anthropic_calls_capture is not None:
        hooks["PostToolUse"].append(
            HookMatcher(
                matcher="mcp__guidelines__anthropic",
                hooks=[create_anthropic_capture_hook(anthropic_calls_capture)],
            )
        )

    # Add context message when location_designer Task is launched
    hooks["PostToolUse"].append(
        HookMatcher(
            matcher="Task",
            hooks=[create_post_task_location_hook()],
        )
    )

    # Add SubagentStop hook
    if "SubagentStop" not in hooks:
        hooks["SubagentStop"] = []
    hooks["SubagentStop"].append(
        HookMatcher(
            matcher=None,
            hooks=[create_subagent_stop_hook(context)],
        )
    )

    # Add PreToolUse hooks for Task tool
    if "PreToolUse" not in hooks:
        hooks["PreToolUse"] = []

    # Track subagent invocation for performance logging (all subagent types)
    hooks["PreToolUse"].append(
        HookMatcher(
            matcher="Task",
            hooks=[create_pre_task_subagent_hook(context)],
        )
    )

    # Create draft location when location_designer is invoked
    hooks["PreToolUse"].append(
        HookMatcher(
            matcher="Task",
            hooks=[create_pre_task_location_hook(context)],
        )
    )

    return hooks if hooks else None
