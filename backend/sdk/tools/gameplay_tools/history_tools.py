"""
History recall tools for TRPG gameplay.

Contains tools for recalling past events from consolidated world history:
- recall_history: Retrieve past events by subtitle from consolidated_history.md

This tool allows Action Manager to reference earlier story events for continuity.
"""

import logging
from typing import Any

from claude_agent_sdk import tool
from infrastructure.logging.perf_logger import track_perf

from sdk.config.gameplay_tool_definitions import RecallHistoryInput
from sdk.loaders import get_tool_description, get_tool_response, is_tool_enabled
from sdk.tools.context import ToolContext

logger = logging.getLogger("GameplayTools.History")


def _get_history_compression_service():
    """Lazy import to avoid circular imports."""
    from services.history_compression_service import HistoryCompressionService

    return HistoryCompressionService


def create_history_tools(ctx: ToolContext) -> list:
    """
    Create history recall tools.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of history tool functions
    """
    tools = []

    # Get required dependencies from context
    world_name = ctx.require_world_name()

    # Get the service via lazy import
    HistoryCompressionService = _get_history_compression_service()

    # Get available history subtitles for the tool description
    history_subtitles = HistoryCompressionService.get_history_subtitles(world_name)

    # Only enable if there are history entries to recall
    if not history_subtitles:
        logger.debug(f"No consolidated history entries for world '{world_name}', skipping recall_history tool")
        return tools

    # ==========================================================================
    # recall_history tool - Retrieve past events from consolidated history
    # ==========================================================================
    if is_tool_enabled("recall_history", default=True):
        # Format subtitles list for description
        subtitles_list = ", ".join(f"'{s}'" for s in history_subtitles)

        recall_history_description = get_tool_description(
            "recall_history",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            history_subtitles=subtitles_list,
            default=f"Retrieve a past event from the world's consolidated history by subtitle. "
            f"Available history entries: {subtitles_list}",
        )

        @tool(
            "recall_history",
            recall_history_description,
            RecallHistoryInput.model_json_schema(),
        )
        @track_perf(
            "tool_recall_history",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
        )
        async def recall_history_tool(args: dict[str, Any]):
            """
            Retrieve a past event from consolidated world history by subtitle.

            Returns the content of the history section with the matching subtitle.
            """
            # Validate input with Pydantic
            validated = RecallHistoryInput(**args)
            subtitle = validated.subtitle

            logger.info(f"📜 recall_history called | subtitle='{subtitle}'")

            # Look up the history content
            history_content = HistoryCompressionService.get_history_by_subtitle(world_name, subtitle)

            if history_content:
                response_text = get_tool_response(
                    "recall_history",
                    group_name=ctx.group_name,
                    history_content=history_content,
                )

                logger.info(f"✅ Retrieved history entry | subtitle='{subtitle}' | length={len(history_content)}")

                return {
                    "content": [{"type": "text", "text": response_text}],
                }
            else:
                # If subtitle not found, show available options
                available = ", ".join(f"'{s}'" for s in history_subtitles)
                response_text = f"History entry '{subtitle}' not found. Available entries: {available}"

                logger.warning(f"⚠️ History entry not found | subtitle='{subtitle}'")

                return {
                    "content": [{"type": "text", "text": response_text}],
                    "is_error": True,
                }

        tools.append(recall_history_tool)

    return tools
