"""
Onboarding and sub-agent tools for TRPG world initialization.

This module defines MCP tools that agents use during the onboarding phase:
- complete: Transition world from 'onboarding' to 'active' with genre, theme, lore
- persist_world_seed: Persist world seed data (stats, location, player state)

The complete tool:
1. Persists world configuration (genre, theme, lore)
2. Transitions the world phase to 'active'
3. Invokes World Seed Generator (via Task tool) to create stat system and initial location

Sub-agent tool mappings (persist tools by MCP server):
- Onboarding MCP server (for onboarding-phase subagents):
  - world_seed_generator: Uses mcp__onboarding__persist_world_seed
- Action Manager MCP server (for gameplay-phase subagents):
  - stat_calculator: Uses mcp__action_manager__persist_stat_changes
  - character_designer: Uses mcp__action_manager__persist_character_design
  - location_designer: Uses mcp__action_manager__persist_location_design

Uses WorldService for filesystem-primary storage.
Character creation during onboarding uses Task tool to invoke character_designer sub-agent.
"""

import logging
import uuid
from datetime import datetime
from typing import Any

from claude_agent_sdk import tool
from services.world_service import WorldService
from sqlalchemy.ext.asyncio import AsyncSession

from sdk.config.onboarding_inputs import CompleteOnboardingInput, PersistWorldSeedInput
from sdk.loaders import get_tool_description, get_tool_response, is_tool_enabled
from sdk.tools.context import ToolContext

logger = logging.getLogger("OnboardingTools")


# =============================================================================
# Tool Name Constants
# =============================================================================

# Tool names for each sub-agent type (persist tools)
# Gameplay sub-agents use action_manager MCP server tools
# Onboarding sub-agents use onboarding MCP server tools
SUBAGENT_TOOL_NAMES = {
    "stat_calculator": "mcp__action_manager__persist_stat_changes",
    "character_designer": "mcp__action_manager__persist_character_design",
    "location_designer": "mcp__action_manager__persist_location_design",
    "world_seed_generator": "mcp__onboarding__persist_world_seed",
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
    Create onboarding tools (complete, persist_world_seed) with filesystem persistence.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of onboarding tool functions configured with agent name
    """
    tools = []

    # ==========================================================================
    # persist_world_seed tool - For World Seed Generator sub-agent
    # This must be in onboarding MCP server so WSG can access it when invoked
    # ==========================================================================
    tools.append(_create_world_seed_persistence_tool(ctx))

    # Complete tool - Transition world to active phase
    # This tool is called AFTER World Seed Generator has created the world via Task tool
    if is_tool_enabled("complete"):
        complete_description = get_tool_description("complete", agent_name=ctx.agent_name, group_name=ctx.group_name)

        @tool("complete", complete_description, CompleteOnboardingInput.model_json_schema())
        async def complete_tool(args: dict[str, Any]):
            """
            Finalize world transition from 'onboarding' to 'active' phase.

            This should be called AFTER using the Task tool to invoke world_seed_generator.
            It saves the world config (genre, theme, lore) and sets the phase to 'active'.
            """
            # Validate input with Pydantic
            validated = CompleteOnboardingInput(**args)
            genre = validated.genre
            theme = validated.theme
            lore = validated.lore
            player_name = validated.player_name

            logger.info(f"World completion requested by {ctx.agent_name}")
            logger.info(f"Genre: {genre}, Theme: {theme}, Player: {player_name}")

            # Use provided world_name or generate a default
            effective_world_name = ctx.world_name
            if not effective_world_name:
                effective_world_name = generate_default_world_name()
                logger.info(f"Generated default world name: {effective_world_name}")

            try:
                # Ensure world directory exists (creates if needed)
                config = WorldService.ensure_world_exists(effective_world_name)

                # Update world config with onboarding data
                config.genre = genre
                config.theme = theme
                config.user_name = player_name
                # Set pending_phase instead of phase - this defers the phase change
                # until after the Onboarding Manager finishes its turn
                config.pending_phase = "active"
                WorldService.save_world_config(effective_world_name, config)

                # Write lore (preserving world notes if they exist from WSG)
                existing_lore = WorldService.load_lore(effective_world_name)
                world_notes_marker = "\n\n---\n## World Notes"
                if world_notes_marker in existing_lore:
                    # Preserve the World Notes section written by World Seed Generator
                    notes_index = existing_lore.find(world_notes_marker)
                    world_notes_section = existing_lore[notes_index:]
                    new_lore = f"# World Lore\n\n{lore}{world_notes_section}"
                else:
                    new_lore = f"# World Lore\n\n{lore}"
                WorldService.save_lore(effective_world_name, new_lore)

                logger.info(f"✅ World '{effective_world_name}' configuration saved, pending phase set to 'active'")

                # Get initial location from player state (set by WSG)
                from services.player_service import PlayerService

                player_state = PlayerService.load_player_state(effective_world_name)
                initial_location_name = player_state.current_location if player_state else None

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
                genre=genre,
                theme=theme,
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
# World Seed Generator Persistence Tool
# =============================================================================


def _create_world_seed_persistence_tool(ctx: ToolContext):
    """
    Create the persist_world_seed tool for World Seed Generator sub-agent.

    This tool persists the generated world seed to the filesystem. The sub-agent
    should call this to save the stat system, location, and player state.

    Args:
        ctx: Tool context (unused but kept for consistency with other persist tools)

    Returns:
        Tool function for persisting world seed
    """

    @tool(
        "persist_world_seed",
        "Persist the generated world seed to the filesystem. "
        "Saves the stat system, initial location, player state, and world notes. "
        "Requires world_name to know where to persist the data.",
        PersistWorldSeedInput.model_json_schema(),
    )
    async def persist_world_seed(args: dict[str, Any]):
        """Persist world seed to filesystem."""
        from services.location_service import LocationService
        from services.player_service import PlayerService
        from services.world_reset_service import WorldResetService

        try:
            validated = PersistWorldSeedInput.model_validate(args)
            # Use context's world_name (from database) instead of agent-provided one
            # Agent may generate a thematic name like "robo_repair_shop" instead of actual world name
            world_name = ctx.require_world_name()

            # Save stat definitions
            stat_definitions = {
                "stats": [stat.model_dump() for stat in validated.stat_system.stats],
                "derived": validated.stat_system.derived or [],
            }
            PlayerService.save_stat_definitions(world_name, stat_definitions)
            logger.info(f"Saved {len(validated.stat_system.stats)} stat definitions")

            # Create initial location
            loc = validated.initial_location
            LocationService.create_location(
                world_name,
                loc.name,
                loc.display_name,
                loc.description,
                (loc.position_x, loc.position_y),
                adjacent=loc.adjacent_hints,
            )
            logger.info(f"Created initial location: {loc.display_name}")

            # Initialize player state
            state = PlayerService.load_player_state(world_name)
            if state:
                # Set default stats
                default_stats = {stat.name: stat.default for stat in validated.stat_system.stats}
                # Apply any overrides
                if validated.initial_stats:
                    default_stats.update(validated.initial_stats)
                state.stats = default_stats

                # Set starting location
                state.current_location = loc.name

                # Set inventory
                if validated.initial_inventory:
                    state.inventory = [item.model_dump() for item in validated.initial_inventory]

                PlayerService.save_player_state(world_name, state)
                logger.info(f"Initialized player state with {len(state.stats)} stats")

                # Capture initial state for reset functionality
                initial_inventory = []
                if validated.initial_inventory:
                    initial_inventory = [item.model_dump() for item in validated.initial_inventory]
                initial_state = WorldResetService.create_initial_state_snapshot(
                    starting_location=loc.name,
                    initial_stats=state.stats,
                    initial_inventory=initial_inventory,
                )
                WorldResetService.save_initial_state(world_name, initial_state)
                logger.info("Captured initial state for world reset")

            # Save world notes if provided
            if validated.world_notes:
                existing_lore = WorldService.load_lore(world_name)
                world_notes = validated.world_notes.replace("\\n", "\n")
                updated_lore = f"{existing_lore}\n\n---\n## World Notes\n{world_notes}"
                WorldService.save_lore(world_name, updated_lore)
                logger.info("Saved world notes")

            return {
                "content": [
                    {
                        "type": "text",
                        "text": f"World seed persisted successfully. Location: {loc.display_name}, Stats: {len(validated.stat_system.stats)}",
                    }
                ],
            }

        except Exception as e:
            logger.error(f"Failed to persist world seed: {e}", exc_info=True)
            return {
                "content": [{"type": "text", "text": f"Error persisting world seed: {e}"}],
                "is_error": True,
            }

    return persist_world_seed
