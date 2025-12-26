"""
Onboarding tools for TRPG world initialization.

This module defines MCP tools that Onboarding_Manager uses during the onboarding phase:
- draft_world: Lightweight world draft (genre, theme, lore summary) to unblock sub-agents
- persist_world: Comprehensive persistence (full lore + stats + player state)
- complete: Transition world from 'onboarding' to 'active' phase

The onboarding flow:
1. Onboarding_Manager interviews player and gathers preferences
2. Onboarding_Manager calls draft_world with genre, theme, lore summary
3. Sub-agents run in background with draft context (location_designer, character_designer, item_designer)
4. Onboarding_Manager calls persist_world with full lore + stat system (overwrites draft)
5. Onboarding_Manager calls complete to finalize phase transition

Sub-agent tool mappings (persist tools by MCP server):
- Onboarding MCP server:
  - draft_world: Used by Onboarding_Manager directly
  - persist_world: Used by Onboarding_Manager directly
- Subagents MCP server (shared by Action Manager and Onboarding Manager):
  - item_designer: Uses mcp__subagents__persist_item
  - character_designer: Uses mcp__subagents__persist_character_design
  - location_designer: Uses mcp__subagents__persist_location_design
- Action Manager direct tools:
  - change_stat: Used directly by Action Manager

Uses WorldService for filesystem-primary storage.
"""

import logging
import uuid
from datetime import datetime
from typing import Any

from claude_agent_sdk import tool
from services.world_service import WorldService
from sqlalchemy.ext.asyncio import AsyncSession

from sdk.config.onboarding_inputs import CompleteOnboardingInput, DraftWorldInput, PersistWorldInput
from sdk.loaders import get_tool_description, get_tool_response, is_tool_enabled
from sdk.tools.context import ToolContext

logger = logging.getLogger("OnboardingTools")


# =============================================================================
# Tool Name Constants
# =============================================================================

# Tool names for each sub-agent type (persist tools)
# Sub-agents use the shared "subagents" MCP server tools (not action_manager)
# This server is available to both Action Manager and Onboarding Manager
SUBAGENT_TOOL_NAMES = {
    "item_designer": "mcp__subagents__persist_item",
    "character_designer": "mcp__subagents__persist_character_design",
    "location_designer": "mcp__subagents__persist_location_design",
}


async def _add_world_agents_to_initial_location(
    db: AsyncSession,
    world_id: int,
    world_name: str,
    initial_location_name: str,
) -> int:
    """
    Add all world-specific agents to the initial location's room.

    This is called after world seed generation to place NPCs created during
    onboarding into the starting location.

    Args:
        db: Database session
        world_id: World ID
        world_name: World name for filesystem lookup
        initial_location_name: Name of the initial location

    Returns:
        Number of agents added to the location
    """
    import crud
    from services.agent_filesystem_service import AgentFilesystemService

    # Get list of agent names from world's agents folder
    world_agent_names = AgentFilesystemService.list_world_agents(world_name)
    if not world_agent_names:
        logger.info("No world agents to add to initial location")
        return 0

    # Get the initial location from DB
    initial_location = await crud.get_location_by_name(db, world_id, initial_location_name)
    if not initial_location:
        logger.warning(f"Initial location '{initial_location_name}' not found in database")
        return 0

    added_count = 0
    for agent_name in world_agent_names:
        try:
            # Get agent from database
            agent = await crud.get_agent_by_name(db, agent_name)
            if agent:
                # Add to initial location
                await crud.add_character_to_location(db, agent.id, initial_location.id)
                logger.info(f"✨ Added '{agent_name}' to initial location '{initial_location_name}'")
                added_count += 1
            else:
                logger.warning(f"Agent '{agent_name}' not found in database")
        except Exception as e:
            logger.warning(f"Failed to add agent '{agent_name}' to location: {e}")

    logger.info(f"Added {added_count} agents to initial location")
    return added_count


def generate_default_world_name() -> str:
    """
    Generate a default world name if one is not provided.

    Uses timestamp and short UUID to create a unique name.

    Returns:
        Generated world name (e.g., 'world_20251206_a1b2c3')
    """
    timestamp = datetime.now().strftime("%Y%m%d")
    short_uuid = uuid.uuid4().hex[:6]
    return f"world_{timestamp}_{short_uuid}"


def create_onboarding_tools(ctx: ToolContext) -> list:
    """
    Create onboarding tools (draft_world, persist_world, complete) with filesystem persistence.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of onboarding tool functions configured with agent name
    """
    tools = []

    # ==========================================================================
    # draft_world tool - Lightweight world draft to unblock sub-agents
    # Called FIRST, before sub-agents start
    # ==========================================================================
    tools.append(_create_draft_world_tool(ctx))

    # ==========================================================================
    # persist_world tool - Comprehensive persistence (full lore + stats)
    # Called AFTER sub-agents have started with draft context
    # ==========================================================================
    tools.append(_create_persist_world_tool(ctx))

    # ==========================================================================
    # Complete tool - Lightweight phase transition
    # Called LAST after draft_world, persist_world, and sub-agents
    # ==========================================================================
    if is_tool_enabled("complete"):
        complete_description = get_tool_description("complete", agent_name=ctx.agent_name, group_name=ctx.group_name)

        @tool("complete", complete_description, CompleteOnboardingInput.model_json_schema())
        async def complete_tool(args: dict[str, Any]):
            """
            Finalize world transition from 'onboarding' to 'active' phase.

            This tool:
            1. Sets the player name in world config
            2. Sets pending_phase to 'active' for phase transition
            3. Captures initial state (stats, inventory, location) for reset functionality

            Call this AFTER:
            - draft_world (genre, theme, lore summary)
            - Sub-agents (location_designer, character_designer, item_designer)
            - persist_world (full lore, stats)
            """
            from services.player_service import PlayerService
            from services.world_reset_service import WorldResetService

            validated = CompleteOnboardingInput(**args)
            player_name = validated.player_name

            logger.info(f"World completion requested by {ctx.agent_name}")
            logger.info(f"Player: {player_name}")

            effective_world_name = ctx.world_name
            if not effective_world_name:
                effective_world_name = generate_default_world_name()
                logger.info(f"Generated default world name: {effective_world_name}")

            try:
                # Ensure world directory exists
                config = WorldService.ensure_world_exists(effective_world_name)

                # Set player name and transition phase
                config.user_name = player_name
                config.pending_phase = "active"
                WorldService.save_world_config(effective_world_name, config)

                logger.info(f"✅ World '{effective_world_name}' pending phase set to 'active'")

                # Get player state for initial state capture and location
                player_state = PlayerService.load_player_state(effective_world_name)
                initial_location_name = player_state.current_location if player_state else None

                # Capture initial state for reset functionality
                # This includes inventory created by item_designer during onboarding
                if player_state:
                    initial_state = WorldResetService.create_initial_state_snapshot(
                        starting_location=player_state.current_location or "",
                        initial_stats=player_state.stats,
                        initial_inventory=player_state.inventory,
                    )
                    WorldResetService.save_initial_state(effective_world_name, initial_state)
                    logger.info(
                        f"Captured initial state: {len(player_state.stats)} stats, "
                        f"{len(player_state.inventory)} items"
                    )

                # Add any world agents (NPCs created during onboarding) to the initial location
                if ctx.db is not None and ctx.world_id is not None and initial_location_name:
                    try:
                        await _add_world_agents_to_initial_location(
                            db=ctx.db,
                            world_id=ctx.world_id,
                            world_name=effective_world_name,
                            initial_location_name=initial_location_name,
                        )
                    except Exception as agent_err:
                        logger.warning(f"Failed to add agents to initial location: {agent_err}")

            except Exception as e:
                logger.error(f"Failed to complete onboarding: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error completing onboarding: {e}"}],
                    "is_error": True,
                }

            # Get response template from config
            response_text = get_tool_response(
                "complete",
                group_name=ctx.group_name,
                player_name=player_name,
            )

            return {"content": [{"type": "text", "text": response_text}]}

        tools.append(complete_tool)

    # ==========================================================================
    # NOTE: add_character tool has been removed from onboarding.
    # Character creation during onboarding should use Task tool to invoke
    # character_designer sub-agent, which calls persist_character_design directly.
    # ==========================================================================

    return tools


# =============================================================================
# Draft World Tool (Lightweight - unblocks sub-agents)
# =============================================================================


def _create_draft_world_tool(ctx: ToolContext):
    """
    Create the draft_world tool for Onboarding_Manager.

    This tool creates a lightweight world draft with genre, theme, and a
    one-paragraph lore summary. Sub-agents can start immediately with this
    context while OM refines the full lore.

    Args:
        ctx: Tool context with world info

    Returns:
        Tool function for drafting world
    """

    @tool(
        "draft_world",
        "Create a lightweight world draft with genre, theme, and lore summary. "
        "Call this FIRST to unblock sub-agents. They will use this context to "
        "create thematically consistent content while you refine the full lore.",
        DraftWorldInput.model_json_schema(),
    )
    async def draft_world(args: dict[str, Any]):
        """Create lightweight world draft to unblock sub-agents."""
        try:
            validated = DraftWorldInput.model_validate(args)
            world_name = ctx.require_world_name()

            # Ensure world directory exists
            config = WorldService.ensure_world_exists(world_name)

            # Save genre and theme to world config
            config.genre = validated.genre
            config.theme = validated.theme
            WorldService.save_world_config(world_name, config)

            # Save lore summary as initial lore.md
            lore_content = f"# World Lore\n\n{validated.lore_summary}"
            WorldService.save_lore(world_name, lore_content)

            logger.info(f"✅ World draft created for '{world_name}'")
            logger.info(f"Genre: {validated.genre}, Theme: {validated.theme}")

            return {
                "content": [
                    {
                        "type": "text",
                        "text": f"World draft created. Genre: {validated.genre}, Theme: {validated.theme}. "
                        f"Sub-agents can now start with this context.",
                    }
                ],
            }

        except Exception as e:
            logger.error(f"Failed to create world draft: {e}", exc_info=True)
            return {
                "content": [{"type": "text", "text": f"Error creating world draft: {e}"}],
                "is_error": True,
            }

    return draft_world


# =============================================================================
# Persist World Tool (Comprehensive - consolidates everything)
# =============================================================================


def _create_persist_world_tool(ctx: ToolContext):
    """
    Create the persist_world tool for Onboarding_Manager.

    This tool consolidates full lore with stat system and player state.
    Called AFTER sub-agents have started with draft context.
    Overwrites the draft lore with the full version.

    Args:
        ctx: Tool context with world info

    Returns:
        Tool function for persisting world
    """

    @tool(
        "persist_world",
        "Persist comprehensive world data: full lore (overwrites draft) + stat system + player state. "
        "Call this AFTER sub-agents have started with draft_world context.",
        PersistWorldInput.model_json_schema(),
    )
    async def persist_world(args: dict[str, Any]):
        """Persist comprehensive world data (full lore + stats)."""
        from services.player_service import PlayerService

        try:
            validated = PersistWorldInput.model_validate(args)
            world_name = ctx.require_world_name()

            # Ensure world directory exists
            WorldService.ensure_world_exists(world_name)

            # Save stat definitions
            stat_definitions = {
                "stats": [stat.model_dump() for stat in validated.stat_system.stats],
                "derived": validated.stat_system.derived or [],
            }
            PlayerService.save_stat_definitions(world_name, stat_definitions)
            logger.info(f"Saved {len(validated.stat_system.stats)} stat definitions")

            # Initialize player state
            state = PlayerService.load_player_state(world_name)
            if state:
                # Set default stats
                default_stats = {stat.name: stat.default for stat in validated.stat_system.stats}
                # Apply any overrides
                if validated.initial_stats:
                    default_stats.update(validated.initial_stats)
                state.stats = default_stats
                PlayerService.save_player_state(world_name, state)
                logger.info(f"Initialized player state with {len(state.stats)} stats")

            # Write full lore (overwrites draft, preserving world notes if they exist)
            existing_lore = WorldService.load_lore(world_name)
            world_notes_marker = "\n\n---\n## World Notes"
            if world_notes_marker in existing_lore:
                # Preserve the World Notes section
                notes_index = existing_lore.find(world_notes_marker)
                world_notes_section = existing_lore[notes_index:]
                new_lore = f"# World Lore\n\n{validated.lore}{world_notes_section}"
            else:
                new_lore = f"# World Lore\n\n{validated.lore}"

            # Add world notes if provided
            if validated.world_notes:
                world_notes = validated.world_notes.replace("\\n", "\n")
                new_lore = f"{new_lore}\n\n---\n## World Notes\n{world_notes}"

            WorldService.save_lore(world_name, new_lore)
            logger.info(f"✅ World persisted for '{world_name}'")

            return {
                "content": [
                    {
                        "type": "text",
                        "text": f"World persisted successfully. Stats: {len(validated.stat_system.stats)}, "
                        f"Lore: {len(validated.lore)} characters",
                    }
                ],
            }

        except Exception as e:
            logger.error(f"Failed to persist world: {e}", exc_info=True)
            return {
                "content": [{"type": "text", "text": f"Error persisting world: {e}"}],
                "is_error": True,
            }

    return persist_world
