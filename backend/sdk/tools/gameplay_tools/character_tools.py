"""
Character management tools for TRPG gameplay.

Contains tools for character management:
- persist_character_design: Create character (used by sub-agents via Task tool)
- remove_character: Remove character from the game (archive agent)
- move_character: Move existing character to a different location
- list_characters: List all characters in the world

"""

import logging
from typing import Any

import crud
from claude_agent_sdk import tool
from domain.entities.gameplay_models import CharacterRemoval, RemovalReason
from services.agent_filesystem_service import AgentFilesystemService
from services.location_service import LocationService

from sdk.config.gameplay_inputs import (
    ListCharactersInput,
    MoveCharacterInput,
    PersistCharacterDesignInput,
    RemoveCharacterInput,
)
from sdk.loaders import get_tool_description, is_tool_enabled
from sdk.tools.context import ToolContext

from .common import build_action_context

logger = logging.getLogger("GameplayTools.Character")


def create_character_tools(ctx: ToolContext) -> list:
    """
    Create character management tools.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of character tool functions
    """
    tools = []

    # Get required dependencies from context
    db = ctx.require_db()
    world_id = ctx.require_world_id()
    world_name = ctx.require_world_name()
    room_id = ctx.require_room_id()

    # ==========================================================================
    # remove_character tool - Archive character and remove from location
    # ==========================================================================
    if is_tool_enabled("remove_character", default=True):
        remove_character_description = get_tool_description(
            "remove_character",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Remove a character from the game (death, departure, or manual removal). Archives the agent.",
        )

        @tool(
            "remove_character",
            remove_character_description,
            RemoveCharacterInput.model_json_schema(),
        )
        async def remove_character_tool(args: dict[str, Any]):
            """Remove a character from the game (archive agent and remove from rooms)."""
            # Validate input with Pydantic
            validated = RemoveCharacterInput(**args)
            character_name = validated.character_name
            reason_str = validated.reason
            narrative = validated.narrative

            logger.info(f"remove_character invoked: {character_name} ({reason_str})")

            try:
                # Parse reason
                reason_map = {
                    "death": RemovalReason.DEATH,
                    "disappearance": RemovalReason.DISAPPEARANCE,
                    "magic": RemovalReason.MAGIC,
                }
                reason = reason_map.get(reason_str, RemovalReason.DEATH)

                removal = CharacterRemoval(
                    character_name=character_name,
                    reason=reason,
                    narrative=narrative,
                )

                # Archive the character (move agent folder to archived/)
                agent_slug = character_name.replace(" ", "_")
                success = AgentFilesystemService.archive_agent(world_name, agent_slug)

                if success:
                    response_text = (
                        f"**Character Removed:**\n- Name: {removal.character_name}\n- Reason: {removal.reason.value}"
                    )
                    if narrative:
                        response_text += f"\n- Narrative: {narrative}"
                else:
                    response_text = f"Character '{character_name}' not found or already removed."

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"remove_character error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error removing character: {e}"}],
                    "is_error": True,
                }

        tools.append(remove_character_tool)

    # ==========================================================================
    # move_character tool - Move existing character to a different location
    # ==========================================================================
    if is_tool_enabled("move_character", default=True):
        move_character_description = get_tool_description(
            "move_character",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Move an existing character to a different location.",
        )

        @tool(
            "move_character",
            move_character_description,
            MoveCharacterInput.model_json_schema(),
        )
        async def move_character_tool(args: dict[str, Any]):
            """Move an existing character to a different location."""
            # Validate input with Pydantic
            validated = MoveCharacterInput(**args)
            character_name = validated.character_name
            destination = validated.destination
            narrative = validated.narrative

            logger.info(f"move_character invoked: {character_name} -> {destination}")

            try:
                # Find the character within this world
                agent = await crud.get_agent_by_name(db, character_name, world_name=world_name)
                if not agent:
                    return {
                        "content": [{"type": "text", "text": f"Character '{character_name}' not found."}],
                        "is_error": True,
                    }

                # Find the destination location
                dest_location = await crud.get_location_by_name(db, world_id, destination)
                if not dest_location:
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"Location '{destination}' not found. Use list_locations to see available locations.",
                            }
                        ],
                        "is_error": True,
                    }

                # Get current locations and remove from them
                old_locations = await crud.get_agent_locations_in_world(db, agent.id, world_id)
                for old_loc in old_locations:
                    if old_loc.id != dest_location.id:
                        # Update filesystem state
                        old_room_key = LocationService.location_to_room_key(old_loc.name)
                        LocationService.remove_agent_from_room(world_name, old_room_key, agent.name)
                        # Update DB
                        await crud.remove_character_from_location(db, agent.id, old_loc.id)

                # Add to destination location
                dest_room_key = LocationService.location_to_room_key(dest_location.name)
                LocationService.add_agent_to_room(world_name, dest_room_key, agent.name)
                await crud.add_character_to_location(db, agent.id, dest_location.id)

                # If destination has a room, add agent to the room
                if dest_location.room_id:
                    from crud.room_agents import add_agent_to_room

                    await add_agent_to_room(db, dest_location.room_id, agent.id)

                location_display = dest_location.display_name or dest_location.name
                response_text = f"**Character Moved:**\n- Name: {agent.name}\n- Destination: {location_display}"
                if narrative:
                    response_text += f"\n- Narrative: {narrative}"

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"move_character error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error moving character: {e}"}],
                    "is_error": True,
                }

        tools.append(move_character_tool)

    # ==========================================================================
    # list_characters tool - List all characters in the world or at a location
    # ==========================================================================
    if is_tool_enabled("list_characters", default=True):
        list_characters_description = get_tool_description(
            "list_characters",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="List all characters in the world or at a specific location.",
        )

        @tool(
            "list_characters",
            list_characters_description,
            ListCharactersInput.model_json_schema(),
        )
        async def list_characters_tool(args: dict[str, Any]):
            """List all characters in the world or at a specific location (filesystem-first)."""
            # Validate input with Pydantic
            validated = ListCharactersInput(**args)
            location_filter = validated.location

            logger.info(f"list_characters invoked (location filter: {location_filter or 'all'})")

            try:
                # Get all characters from filesystem
                all_characters = AgentFilesystemService.list_world_agents_with_details(world_name)

                if not all_characters:
                    return {
                        "content": [{"type": "text", "text": f"No characters in {world_name}."}],
                    }

                # Build agent-to-location mapping from _state.json
                state = LocationService.load_state(world_name)
                agent_locations: dict[str, str] = {}  # agent_name -> location_display_name

                for room_key, mapping in state.rooms.items():
                    if room_key.startswith("location:"):
                        loc_name = room_key[9:]  # len("location:") = 9
                        # Load location to get display name
                        loc_config = LocationService.load_location(world_name, loc_name)
                        loc_display = loc_config.display_name if loc_config else loc_name
                        for agent_name in mapping.agents:
                            # Skip system agents (Narrator, Action_Manager, etc.)
                            if agent_name in ("Narrator", "Action_Manager", "Onboarding_Manager"):
                                continue
                            agent_locations[agent_name] = loc_display

                if location_filter:
                    # Filter characters by location
                    # Find the room key for this location
                    room_key = LocationService.find_location_room_key_fuzzy(world_name, location_filter)
                    if not room_key:
                        return {
                            "content": [
                                {
                                    "type": "text",
                                    "text": f"Location '{location_filter}' not found. Check available locations by `mcp__action_manager__list_locations`",
                                }
                            ],
                            "is_error": True,
                        }

                    loc_name = room_key[9:]  # len("location:") = 9
                    loc_config = LocationService.load_location(world_name, loc_name)
                    location_display = loc_config.display_name if loc_config else loc_name

                    # Get agents in this room from state
                    mapping = state.rooms.get(room_key)
                    agents_in_room = set(mapping.agents) if mapping else set()

                    # Filter characters that are in this location
                    filtered_chars = [
                        c for c in all_characters if c["folder_name"] in agents_in_room or c["name"] in agents_in_room
                    ]

                    if not filtered_chars:
                        # No characters at location - fall back to listing all character names
                        logger.info(f"No characters at {location_display}, returning all characters")

                        char_names = [char["name"] for char in all_characters]
                        response_text = (
                            f"**No characters at {location_display}.**\n\n**All characters:** {', '.join(char_names)}"
                        )
                        return {"content": [{"type": "text", "text": response_text}]}

                    # Build character list
                    char_entries = []
                    for char in filtered_chars:
                        entry = f"- **{char['name']}**"
                        if char.get("in_a_nutshell"):
                            nutshell = char["in_a_nutshell"][:80]
                            if len(char["in_a_nutshell"]) > 80:
                                nutshell += "..."
                            entry += f": {nutshell}"
                        char_entries.append(entry)

                    response_text = f"**Characters at {location_display}:**\n\n" + "\n".join(char_entries)
                else:
                    # List all characters, grouped by location
                    by_location: dict[str, list] = {"(No location)": []}

                    for char in all_characters:
                        # Check both folder_name and display name for location mapping
                        loc = agent_locations.get(char["folder_name"]) or agent_locations.get(char["name"])
                        if loc:
                            if loc not in by_location:
                                by_location[loc] = []
                            by_location[loc].append(char)
                        else:
                            by_location["(No location)"].append(char)

                    # Remove empty "(No location)" group
                    if not by_location["(No location)"]:
                        del by_location["(No location)"]

                    # Build response
                    sections = []
                    for loc_name, chars in by_location.items():
                        char_entries = []
                        for char in chars:
                            entry = f"  - **{char['name']}**"
                            if char.get("in_a_nutshell"):
                                nutshell = char["in_a_nutshell"][:60]
                                if len(char["in_a_nutshell"]) > 60:
                                    nutshell += "..."
                                entry += f": {nutshell}"
                            char_entries.append(entry)
                        sections.append(f"**{loc_name}:**\n" + "\n".join(char_entries))

                    response_text = f"**Characters in {world_name}:**\n\n" + "\n\n".join(sections)

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"list_characters error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error listing characters: {e}"}],
                    "is_error": True,
                }

        tools.append(list_characters_tool)

    # ==========================================================================
    # persist_character_design tool - For sub-agents to persist character designs
    # ==========================================================================
    if is_tool_enabled("persist_character_design", default=True):
        persist_character_description = get_tool_description(
            "persist_character_design",
            agent_name="Character Designer",
            group_name=ctx.group_name,
            default="Persist a character design to the game world. Creates the character in filesystem and database.",
        )

        @tool(
            "persist_character_design",
            persist_character_description,
            PersistCharacterDesignInput.model_json_schema(),
        )
        async def persist_character_design_tool(args: dict[str, Any]):
            """Persist a designed character to filesystem and database.

            Used by Character Designer sub-agent after designing a character.
            Creates the character files and adds them to the appropriate location.
            """
            validated = PersistCharacterDesignInput(**args)

            logger.info(f"persist_character_design: {validated.name} ({validated.role})")

            try:
                # Create agent in filesystem
                agent_name = validated.name.replace(" ", "_")
                in_a_nutshell = f"{validated.name} is a {validated.role}. {validated.appearance}"
                characteristics = f"""## Role
{validated.role}

## Appearance
{validated.appearance}

## Personality
{validated.personality}

## Initial Disposition
{validated.initial_disposition}"""
                if validated.secret:
                    characteristics += f"\n\n## Hidden Detail\n{validated.secret}"

                AgentFilesystemService.create_agent(world_name, agent_name, in_a_nutshell, characteristics)

                # Determine target location
                which_location = validated.which_location or "current"

                # Get current location info
                context = build_action_context(world_name, "character creation")
                current_location_name = context.current_location

                # Update filesystem state for location
                if which_location.lower() != "current":
                    target_loc = await crud.get_location_by_name(db, world_id, which_location)
                    if target_loc:
                        room_key = LocationService.location_to_room_key(target_loc.name)
                        if target_loc.room_id:
                            LocationService.ensure_room_mapping_exists(
                                world_name=world_name,
                                room_key=room_key,
                                db_room_id=target_loc.room_id,
                                agents=[],
                            )
                        LocationService.add_agent_to_room(world_name, room_key, agent_name)
                        location_display = target_loc.display_name or target_loc.name
                    else:
                        # Fallback to current location
                        room_key = LocationService.location_to_room_key(current_location_name)
                        LocationService.add_agent_to_room(world_name, room_key, agent_name)
                        location_display = "current location"
                else:
                    room_key = LocationService.location_to_room_key(current_location_name)
                    LocationService.add_agent_to_room(world_name, room_key, agent_name)
                    location_display = "current location"

                # Create agent in DB
                from services.agent_factory import AgentFactory

                new_agent = await AgentFactory.create_from_config(
                    db=db,
                    name=agent_name,
                    config_file=f"worlds/{world_name}/agents/{agent_name}",
                    group=None,
                )

                # Add to room/location in DB
                if which_location.lower() == "current":
                    from crud.room_agents import add_agent_to_room

                    await add_agent_to_room(db, room_id, new_agent.id)
                else:
                    target_loc = await crud.get_location_by_name(db, world_id, which_location)
                    if target_loc:
                        await crud.add_character_to_location(db, new_agent.id, target_loc.id)

                logger.info(f"Created character: {validated.name} at {location_display}")

                response_text = f"""**Character Created:**
- Name: {validated.name}
- Role: {validated.role}
- Location: {location_display}
- Disposition: {validated.initial_disposition}"""

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"persist_character_design error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error creating character: {e}"}],
                    "is_error": True,
                }

        tools.append(persist_character_design_tool)

    return tools
