"""
Location management tools for TRPG gameplay.

Contains tools for location navigation and management:
- persist_location_design: Create location (used by sub-agents via Task tool)
- travel: Move player to an existing location
- list_locations: List all available locations

"""

import asyncio
import logging
from typing import Any, Optional

import crud
import schemas
from claude_agent_sdk import tool
from domain.value_objects.enums import MessageRole
from infrastructure.logging.perf_logger import track_perf
from services.location_service import LocationService
from services.persistence_manager import PersistenceManager
from services.player_service import PlayerService
from services.world_service import WorldService

from sdk.handlers.common import build_action_context
from sdk.handlers.context import ToolContext
from sdk.loaders import get_tool_description, is_tool_enabled
from sdk.tools.gameplay import (
    ListLocationsInput,
    TravelInput,
)
from sdk.tools.subagent import PersistLocationDesignInput

logger = logging.getLogger("GameplayTools.Location")


def create_location_tools(ctx: ToolContext) -> list:
    """
    Create location management tools.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of location tool functions
    """
    tools = []

    # Get required dependencies from context
    db = ctx.require_db()
    world_id = ctx.require_world_id()
    world_name = ctx.require_world_name()

    # ==========================================================================
    # travel tool - Move player to existing location only
    # ==========================================================================
    if is_tool_enabled("travel", default=True):
        travel_description = get_tool_description(
            "travel",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Move the player to an existing location. Use Task tool with location_designer first if the destination doesn't exist. Use bring_characters to bring characters along.",
        )

        @tool(
            "travel",
            travel_description,
            TravelInput.model_json_schema(),
        )
        @track_perf(
            "tool_travel",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
        )
        async def travel_tool(args: dict[str, Any]):
            """Move the player to an existing location with narration, action suggestions, and chat summary."""
            # Validate input with Pydantic
            validated = TravelInput(**args)
            destination = validated.destination
            bring_characters = validated.bring_characters
            narration = validated.narration
            action_1 = validated.action_1
            action_2 = validated.action_2
            chat_summary = validated.chat_summary
            user_action = validated.user_action

            if not destination:
                return {
                    "content": [{"type": "text", "text": "No destination specified."}],
                    "is_error": True,
                }

            logger.info(f"travel invoked: '{destination}' (bringing={bring_characters})")

            # Get current room_id for sub-agent status display
            # Import here to avoid circular import
            from orchestration import get_trpg_orchestrator

            trpg_orchestrator = get_trpg_orchestrator()
            current_room_id: Optional[int] = None

            try:
                # Get current location for summarization
                context = build_action_context(world_name, f"travel to {destination}")
                from_location_name = context.current_location

                # Get current location's room_id for status display
                if from_location_name and from_location_name != "unknown":
                    from_loc = await crud.get_location_by_name(db, world_id, from_location_name)
                    if from_loc and from_loc.room_id:
                        current_room_id = from_loc.room_id  # type: ignore[assignment]  # SQLAlchemy Column coerces to int at runtime
                        # Set sub-agent status to show "Traveling to..." in frontend
                        trpg_orchestrator.set_sub_agent_active(
                            current_room_id,
                            "Travel",
                            f"Traveling to {destination}...",
                        )

                # Save chat summary to world history (using provided summary, no sub-agent needed)
                if from_location_name and from_location_name != "unknown":
                    try:
                        # Get location display name for history entry
                        from_location_config = LocationService.load_location(world_name, from_location_name)
                        from_display_name = (
                            from_location_config.display_name if from_location_config else from_location_name
                        )

                        # Get current turn count from DB (DB has the incremented value, FS may not be synced)
                        db_player_state = await crud.get_player_state(db, world_id)
                        turn = db_player_state.turn_count if db_player_state else 0

                        # Save the provided chat summary to history
                        WorldService.add_history_entry(world_name, turn, from_display_name, chat_summary)
                        logger.info(f"Saved chat summary to history: {from_display_name} (turn {turn})")
                    except Exception as e:
                        logger.warning(f"Failed to save chat summary to history: {e}")

                    # Trigger memory round for NPCs at the departing location
                    try:
                        if from_loc and from_loc.id:
                            npc_count = await trpg_orchestrator.trigger_npc_memory_round(from_loc.id)
                            if npc_count > 0:
                                logger.info(f"Memory round complete: {npc_count} NPCs processed")
                    except Exception as e:
                        logger.warning(f"Failed to trigger memory round: {e}")

                # Get all existing locations
                db_locations = await crud.get_locations(db, world_id)

                # Try to find matching location (case-insensitive)
                destination_lower = destination.lower()
                matching_location = None

                for loc in db_locations:
                    # Match by name or display_name (case-insensitive)
                    if (
                        loc.name.lower() == destination_lower
                        or (loc.display_name and loc.display_name.lower() == destination_lower)
                        or destination_lower in loc.name.lower()
                        or (loc.display_name and destination_lower in loc.display_name.lower())
                    ):
                        matching_location = loc
                        break

                # Track destination location ID for character movement
                destination_location_id = None
                display_name = ""
                pos_x, pos_y = 0, 0

                # Get from_location_id for character movement
                from_location = next(
                    (loc for loc in db_locations if loc.name == from_location_name),
                    None,
                )
                from_location_id = from_location.id if from_location else None

                # If no match found, return error - use add_location to create new locations
                if matching_location is None:
                    # Get all location display names for helpful error message
                    location_names = [loc.display_name or loc.name for loc in db_locations]
                    available = ", ".join(location_names) if location_names else "none"
                    logger.warning(f"Location '{destination}' not found. Available: {available}")
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"Location '{destination}' does not exist. Use Task tool with location_designer to create it first.\n\nAvailable locations: {available}",
                            }
                        ],
                        "is_error": True,
                    }
                else:
                    # Move to existing location - create fresh room for new visit
                    destination_location_id = matching_location.id

                    # Create new room for this visit (clean context)
                    new_room = await crud.create_new_room_for_location(db, matching_location)
                    logger.info(f"Created new room {new_room.id} for location {matching_location.name}")

                    # Update room mapping in _state.json
                    room_key = LocationService.location_to_room_key(matching_location.name)
                    LocationService.set_room_mapping(
                        world_name=world_name,
                        room_key=room_key,
                        db_room_id=new_room.id,
                        agents=[],  # Gameplay agents added via DB
                    )

                    # Pre-connect characters at destination (max 5) for faster NPC reactions
                    if ctx.agent_manager and destination_location_id:

                        async def pre_connect_destination_chars():
                            try:
                                dest_chars = await crud.get_characters_at_location(
                                    db, destination_location_id, exclude_system_agents=True
                                )
                                # Limit to 5 characters to avoid resource exhaustion
                                for char in dest_chars[:5]:
                                    await ctx.agent_manager.pre_connect(
                                        db=db,
                                        room_id=new_room.id,
                                        agent_id=char.id,
                                        agent_name=char.name,
                                        world_name=world_name,
                                        world_id=world_id,
                                        config_file=char.config_file,
                                        group_name=char.group,
                                    )
                            except Exception as e:
                                logger.debug(f"Pre-connect chars failed (non-critical): {e}")

                        # Fire-and-forget background task
                        asyncio.create_task(pre_connect_destination_chars())

                    await crud.set_current_location(db, world_id, matching_location.id)

                    # Update filesystem player state
                    fs_state = PlayerService.load_player_state(world_name)
                    if fs_state:
                        fs_state.current_location = matching_location.name
                        PlayerService.save_player_state(world_name, fs_state)

                    display_name = matching_location.display_name or matching_location.name
                    pos_x, pos_y = matching_location.position_x, matching_location.position_y

                    logger.info(f"Traveled to existing location: {display_name}")

                # ============================================================
                # Move accompanying characters
                # ============================================================
                moved_characters = []
                for char_name in bring_characters:
                    try:
                        agent = await crud.get_agent_by_name(db, char_name)
                        if agent and destination_location_id:
                            await crud.move_character_to_location(
                                db, agent.id, from_location_id, destination_location_id
                            )
                            moved_characters.append(char_name)
                            logger.info(f"Moved character {char_name} to {display_name}")
                        else:
                            logger.warning(f"Character '{char_name}' not found, skipping")
                    except Exception as e:
                        logger.warning(f"Failed to move character '{char_name}': {e}")

                # ============================================================
                # Create narrative message in the NEW room
                # ============================================================
                try:
                    agent_id = ctx.require_agent_id()
                    # Use the new room for the narration message
                    new_room_id = new_room.id if new_room else ctx.require_room_id()

                    message = schemas.MessageCreate(
                        content=narration,
                        role=MessageRole.ASSISTANT,
                        agent_id=agent_id,
                    )
                    await crud.create_message(db, new_room_id, message, update_room_activity=True)
                    logger.info(f"Travel narration created | room={new_room_id} | agent={agent_id}")
                except Exception as e:
                    logger.error(f"Failed to create travel narration: {e}")

                # ============================================================
                # Save action suggestions to _state.json
                # ============================================================
                try:
                    LocationService.save_suggestions(world_name, [action_1, action_2])
                    logger.info(f"Travel suggestions saved: [{action_1}] / [{action_2}]")
                except Exception as e:
                    logger.error(f"Failed to save travel suggestions: {e}")

                # ============================================================
                # Save arrival context for continuity (one-time use)
                # ============================================================
                try:
                    LocationService.save_arrival_context(
                        world_name=world_name,
                        previous_narration=narration,
                        triggering_action=user_action,
                        from_location=from_location_name or "unknown",
                    )
                    logger.info("Arrival context saved for continuity")
                except Exception as e:
                    logger.error(f"Failed to save arrival context: {e}")

                # Build response
                response_text = f"""**Traveled to:** {display_name}
- Position: ({pos_x}, {pos_y})"""

                if moved_characters:
                    response_text += f"\n- Companions: {', '.join(moved_characters)}"

                response_text += "\n\n Narrative message created and displayed to player."
                response_text += f"\n Suggested actions: [{action_1}] / [{action_2}]"
                response_text += "\n Chat summary saved to world history."
                response_text += "\n Arrival context saved for next action continuity."

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"travel error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error during travel: {e}"}],
                    "is_error": True,
                }
            finally:
                # Clear sub-agent status when travel completes (success or error)
                if current_room_id:
                    trpg_orchestrator.set_sub_agent_inactive(current_room_id)

        tools.append(travel_tool)

    # ==========================================================================
    # list_locations tool - List all available locations in the world
    # ==========================================================================
    if is_tool_enabled("list_locations", default=True):
        list_locations_description = get_tool_description(
            "list_locations",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="List all available locations in the current world.",
        )

        @tool("list_locations", list_locations_description, ListLocationsInput.model_json_schema())
        @track_perf(
            "tool_list_locations",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
        )
        async def list_locations_tool(_args: dict[str, Any]):
            """List all available locations in the world."""
            logger.info("list_locations invoked")

            try:
                # Load locations from filesystem (source of truth)
                fs_locations = LocationService.load_all_locations(world_name)

                if not fs_locations:
                    return {
                        "content": [{"type": "text", "text": "No locations found in this world."}],
                    }

                # Get current location for highlighting
                state = PlayerService.load_player_state(world_name)
                current_location = state.current_location if state else None

                # Build location list from filesystem locations
                location_entries = []
                for loc_name, loc_config in fs_locations.items():
                    display_name = loc_config.display_name or loc_name
                    entry = f"- **{display_name}**"

                    if loc_name == current_location:
                        entry += " (current)"

                    # Add position info
                    pos = loc_config.position if isinstance(loc_config.position, tuple) else (0, 0)
                    entry += f" at ({pos[0]}, {pos[1]})"

                    # Add description if available
                    if loc_config.description:
                        # Truncate description to first 100 chars
                        desc_preview = loc_config.description[:100]
                        if len(loc_config.description) > 100:
                            desc_preview += "..."
                        entry += f"\n  {desc_preview}"

                    location_entries.append(entry)

                response_text = f"**Locations in {world_name}:**\n\n" + "\n\n".join(location_entries)

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"list_locations error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error listing locations: {e}"}],
                    "is_error": True,
                }

        tools.append(list_locations_tool)

    # ==========================================================================
    # persist_location_design tool - For sub-agents to persist location designs
    # ==========================================================================
    if is_tool_enabled("persist_location_design", default=True):
        persist_location_description = get_tool_description(
            "persist_location_design",
            agent_name="Location Designer",
            group_name=ctx.group_name,
            default="Persist a location design to the game world. Creates the location in filesystem and database.",
        )

        @tool(
            "persist_location_design",
            persist_location_description,
            PersistLocationDesignInput.model_json_schema(),
        )
        async def persist_location_design_tool(args: dict[str, Any]):
            """Persist a designed location to filesystem and database.

            Used by Location Designer sub-agent after designing a location.
            Creates the location files and connects to adjacent locations.
            Returns an error if the location already exists.
            """
            validated = PersistLocationDesignInput(**args)

            logger.info(f"persist_location_design: {validated.display_name}")

            try:
                # Check if location already exists
                db_locations = await crud.get_locations(db, world_id)
                location_name_lower = validated.name.lower()

                existing = None
                for loc in db_locations:
                    if loc.name.lower() == location_name_lower or (
                        loc.display_name and loc.display_name.lower() == location_name_lower
                    ):
                        existing = loc
                        break

                if existing:
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"Location '{validated.name}' already exists. Cannot overwrite.",
                            }
                        ],
                        "is_error": True,
                    }

                # Build adjacent hints from adjacent_to (already a list or None)
                adjacent_hints = validated.adjacent_to or []

                # Use PersistenceManager for coordinated FS + DB creation
                pm = PersistenceManager(db, world_id, world_name)
                new_location_id = await pm.create_location(
                    name=validated.name,
                    display_name=validated.display_name,
                    description=validated.description,
                    position=(validated.position_x, validated.position_y),
                    adjacent_hints=adjacent_hints,
                    is_starting=validated.is_starting,
                )

                # Connect to adjacent locations in DB
                if adjacent_hints:
                    for adj_name in adjacent_hints:
                        adj_loc = next((loc for loc in db_locations if loc.name == adj_name), None)
                        if adj_loc:
                            await crud.add_adjacent_location(db, new_location_id, adj_loc.id)
                            await crud.add_adjacent_location(db, adj_loc.id, new_location_id)

                # Note: is_starting is informational only during onboarding.
                # The actual starting_location is set by OM's complete tool.
                if validated.is_starting:
                    logger.info(f"Location '{validated.name}' marked as starting location candidate")

                logger.info(f"Created location: {validated.display_name} (id={new_location_id})")

                response_text = f"""**Location Created:**
- Name: {validated.display_name}
- Position: ({validated.position_x}, {validated.position_y})
- Is Starting: {validated.is_starting}
- Description: {validated.description[:200]}..."""

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"persist_location_design error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error creating location: {e}"}],
                    "is_error": True,
                }

        tools.append(persist_location_design_tool)

    return tools
