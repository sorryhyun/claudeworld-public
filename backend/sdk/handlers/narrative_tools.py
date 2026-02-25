"""
Narrative output tools for TRPG gameplay.

Contains tools for presenting narrative content to the player:
- narration: Create visible narrative messages
- suggest_options: Provide suggested actions as clickable buttons

These tools handle the "presentation layer" - displaying content to the player
rather than modifying game state.
"""

import logging
from typing import Any

import crud
import schemas
from claude_agent_sdk import tool
from domain.value_objects.enums import MessageRole
from infrastructure.logging.perf_logger import track_perf
from services.player_service import PlayerService
from services.room_mapping_service import RoomMappingService

from sdk.handlers.context import ToolContext
from sdk.loaders import get_tool_description, is_tool_enabled
from sdk.tools.gameplay import (
    NarrationInput,
    SuggestOptionsInput,
)

logger = logging.getLogger("GameplayTools.Narrative")


def create_narrative_tools(ctx: ToolContext) -> list:
    """
    Create narrative output tools.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of narrative tool functions
    """
    tools = []

    # Get required dependencies from context
    db = ctx.require_db()
    world_name = ctx.require_world_name()

    # ==========================================================================
    # narration tool - Create visible narrative message (replaces Narrator)
    # ==========================================================================
    if is_tool_enabled("narration", default=True):
        narration_description = get_tool_description(
            "narration",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="REQUIRED: Create a visible narrative message describing the outcome. "
            "This is the text the player will see. Make it vivid and engaging.",
        )

        @tool(
            "narration",
            narration_description,
            NarrationInput.model_json_schema(),
        )
        @track_perf(
            "tool_narration",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
        )
        async def narration_tool(args: dict[str, Any]):
            """
            Create a visible narrative message in the conversation.

            This replaces the separate Narrator agent. Action Manager now
            handles both interpretation and narration in a single turn.
            """
            # Validate input with Pydantic
            validated = NarrationInput(**args)
            narrative = validated.narrative

            logger.info(f"📖 narration called | length={len(narrative)}")

            try:
                # Get Action Manager's agent_id and room_id from context
                agent_id = ctx.require_agent_id()
                room_id = ctx.require_room_id()

                # Load game_time_snapshot from player state for message timestamp
                game_time_snapshot = None
                player_state = PlayerService.load_player_state(world_name)
                if player_state and player_state.game_time:
                    game_time_snapshot = player_state.game_time

                # Build thinking field with NPC reactions (for collapsible display)
                thinking_content = None
                if ctx.npc_reactions:
                    parts = ["[NPC_REACTIONS]"]
                    for reaction in ctx.npc_reactions:
                        parts.append(f"=== {reaction['agent_name']} ===")
                        parts.append(reaction["content"])
                        parts.append("")
                    parts.append("[/NPC_REACTIONS]")
                    thinking_content = "\n".join(parts)
                    logger.info(f"📝 Including {len(ctx.npc_reactions)} NPC reactions in thinking field")

                # Create message via crud.create_message()
                message = schemas.MessageCreate(
                    content=narrative,
                    role=MessageRole.ASSISTANT,
                    agent_id=agent_id,
                    game_time_snapshot=game_time_snapshot,
                    thinking=thinking_content,  # Store NPC reactions in thinking field
                )
                await crud.create_message(db, room_id, message, update_room_activity=True)

                # Signal that narration has been produced (allows input unblocking)
                # Lazy import to avoid circular dependency
                from orchestration.trpg_orchestrator import get_trpg_orchestrator

                get_trpg_orchestrator().set_narration_produced(room_id)

                logger.info(f"✅ Narrative message created | room={room_id} | agent={agent_id}")

                return {
                    "content": [
                        {
                            "type": "text",
                            "text": "✓ Narrative message created and displayed to player.",
                        }
                    ]
                }

            except Exception as e:
                logger.error(f"narration error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error creating narrative: {e}"}],
                    "is_error": True,
                }

        tools.append(narration_tool)

    # ==========================================================================
    # suggest_options tool - Provide suggested actions for player
    # ==========================================================================
    if is_tool_enabled("suggest_options", default=True):
        suggest_options_description = get_tool_description(
            "suggest_options",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="REQUIRED: Provide two suggested actions for the player. "
            "These appear as clickable buttons in the UI.",
        )

        @tool(
            "suggest_options",
            suggest_options_description,
            SuggestOptionsInput.model_json_schema(),
        )
        @track_perf(
            "tool_suggest_options",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
        )
        async def suggest_options_tool(args: dict[str, Any]):
            """
            Provide two suggested actions for the player.

            These suggestions appear as clickable buttons in the UI.
            Replaces the Narrator's suggest_actions tool.
            """
            # Validate input with Pydantic
            validated = SuggestOptionsInput(**args)
            action_1 = validated.action_1
            action_2 = validated.action_2

            logger.info(f"💡 suggest_options invoked: [{action_1}] / [{action_2}]")

            if not action_1 or not action_2:
                return {
                    "content": [{"type": "text", "text": "Please provide both action suggestions."}],
                    "is_error": True,
                }

            # Persist suggestions to _state.json for frontend retrieval
            try:
                RoomMappingService.save_suggestions(world_name, [action_1, action_2])
                logger.info(f"💾 Suggestions persisted to _state.json for world: {world_name}")
            except Exception as e:
                logger.error(f"Failed to persist suggestions: {e}")

            # Format response for the system
            response_text = f"""**Suggested Actions:**
1. {action_1}
2. {action_2}"""

            return {
                "content": [{"type": "text", "text": response_text}],
            }

        tools.append(suggest_options_tool)

    return tools
