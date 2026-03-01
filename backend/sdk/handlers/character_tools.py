"""
Character management tools for TRPG gameplay.

Contains tools for character management:
- persist_character_design: Create character (used by sub-agents via Task tool)
- remove_character: Remove character from current location (character still exists)
- delete_character: Permanently delete character from the game (archive agent)
- move_character: Move existing character to a different location
- list_characters: List all characters in the world

"""

import logging
from typing import Any

import crud
from claude_agent_sdk import tool
from domain.entities.gameplay_models import CharacterRemoval, RemovalReason
from infrastructure.logging.perf_logger import track_perf
from services.agent_filesystem_service import AgentFilesystemService
from services.location_storage import LocationStorage
from services.room_mapping_service import RoomMappingService

from sdk.handlers.common import build_action_context, tool_error, tool_success
from sdk.handlers.context import ToolContext
from sdk.loaders import get_tool_description, is_tool_enabled
from sdk.tools.gameplay import (
    DeleteCharacterInput,
    ListCharactersInput,
    MoveCharacterInput,
    RemoveCharacterInput,
)
from sdk.tools.subagent import PersistCharacterDesignInput

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
    # remove_character tool - Remove character from current location
    # ==========================================================================
    if is_tool_enabled("remove_character", default=True):
        remove_character_description = get_tool_description(
            "remove_character",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Remove a character from the current location (character still exists in the world).",
        )

        @tool(
            "remove_character",
            remove_character_description,
            RemoveCharacterInput.model_json_schema(),
        )
        @track_perf(
            "tool_remove_character",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
        )
        async def remove_character_tool(args: dict[str, Any]):
            """Remove a character from the current location (character still exists)."""
            # Validate input with Pydantic
            validated = RemoveCharacterInput(**args)
            character_name = validated.character_name

            logger.info(f"remove_character invoked: {character_name} (from current location)")

            try:
                # Find the character in filesystem
                all_characters = AgentFilesystemService.list_world_agents(world_name)

                # Find matching character (case-insensitive, handle underscore/space)
                character_folder = None
                character_display_name = character_name
                name_variants = [
                    character_name,
                    character_name.replace(" ", "_"),
                    character_name.replace("_", " "),
                ]

                for char_folder in all_characters:
                    if char_folder.lower() in [v.lower() for v in name_variants]:
                        character_folder = char_folder
                        character_display_name = char_folder.replace("_", " ")
                        break

                if not character_folder:
                    available = ", ".join(all_characters) if all_characters else "none"
                    return tool_error(f"Character '{character_name}' not found.\n\nAvailable characters: {available}")

                # Get current location from context
                context = build_action_context(world_name, "character removal")
                current_location = context.current_location
                current_room_key = RoomMappingService.location_to_room_key(current_location)

                # Remove character from current location in filesystem state
                state = RoomMappingService.load_state(world_name)
                mapping = state.rooms.get(current_room_key)

                if mapping and character_folder in mapping.agents:
                    RoomMappingService.remove_agent_from_room(world_name, current_room_key, character_folder)
                    logger.info(f"Removed {character_folder} from {current_room_key}")

                    # DB sync: remove from current location
                    try:
                        agent = await crud.get_agent_by_name(db, character_folder, world_name=world_name)
                        current_loc = await crud.get_location_by_name(db, world_id, current_location)
                        if agent and current_loc:
                            await crud.remove_character_from_location(db, agent.id, current_loc.id)
                            logger.info(f"DB sync: removed {character_folder} from location {current_loc.id}")
                    except Exception as db_err:
                        logger.warning(f"DB sync failed (non-critical): {db_err}")

                    response_text = (
                        f"**Character Removed from Location:**\n"
                        f"- Name: {character_display_name}\n"
                        f"- Location: {current_location}\n"
                        f"- Note: Character still exists in the world"
                    )
                else:
                    response_text = (
                        f"Character '{character_display_name}' was not at the current location ({current_location})."
                    )

                return tool_success(response_text)

            except Exception as e:
                logger.error(f"remove_character error: {e}", exc_info=True)
                return tool_error(f"Error removing character from location: {e}")

        tools.append(remove_character_tool)

    # ==========================================================================
    # delete_character tool - Permanently delete character (archive)
    # ==========================================================================
    if is_tool_enabled("delete_character", default=True):
        delete_character_description = get_tool_description(
            "delete_character",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Permanently delete a character from the game (death, disappearance, or magic). Archives the agent.",
        )

        @tool(
            "delete_character",
            delete_character_description,
            DeleteCharacterInput.model_json_schema(),
        )
        @track_perf(
            "tool_delete_character",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
        )
        async def delete_character_tool(args: dict[str, Any]):
            """Permanently delete a character from the game (archive agent)."""
            # Validate input with Pydantic
            validated = DeleteCharacterInput(**args)
            character_name = validated.character_name
            reason_str = validated.reason
            narrative = validated.narrative

            logger.info(f"delete_character invoked: {character_name} ({reason_str})")

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
                        f"**Character Deleted:**\n- Name: {removal.character_name}\n- Reason: {removal.reason.value}"
                    )
                    if narrative:
                        response_text += f"\n- Narrative: {narrative}"
                else:
                    response_text = f"Character '{character_name}' not found or already deleted."

                return tool_success(response_text)

            except Exception as e:
                logger.error(f"delete_character error: {e}", exc_info=True)
                return tool_error(f"Error deleting character: {e}")

        tools.append(delete_character_tool)

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
        @track_perf(
            "tool_move_character",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
        )
        async def move_character_tool(args: dict[str, Any]):
            """Move an existing character to a different location (filesystem-primary)."""
            # Validate input with Pydantic
            validated = MoveCharacterInput(**args)
            character_name = validated.character_name
            destination = validated.destination
            narrative = validated.narrative

            logger.info(f"move_character invoked: {character_name} -> {destination}")

            try:
                # ============================================================
                # FILESYSTEM-PRIMARY: Check character exists in filesystem
                # ============================================================
                all_characters = AgentFilesystemService.list_world_agents(world_name)

                # Find matching character (case-insensitive, handle underscore/space)
                character_folder = None
                character_display_name = character_name
                name_variants = [
                    character_name,
                    character_name.replace(" ", "_"),
                    character_name.replace("_", " "),
                ]

                for char_folder in all_characters:
                    if char_folder.lower() in [v.lower() for v in name_variants]:
                        character_folder = char_folder
                        character_display_name = char_folder.replace("_", " ")
                        break

                if not character_folder:
                    # List available characters for helpful error
                    available = ", ".join(all_characters) if all_characters else "none"
                    return tool_error(f"Character '{character_name}' not found in filesystem.\n\nAvailable characters: {available}")

                # ============================================================
                # FILESYSTEM-PRIMARY: Find destination location
                # ============================================================
                dest_room_key = RoomMappingService.find_location_room_key_fuzzy(world_name, destination)
                if not dest_room_key:
                    # List available locations for helpful error (show folder names)
                    fs_locations = LocationStorage.load_all_locations(world_name)
                    available = ", ".join(fs_locations.keys()) if fs_locations else "none"
                    return tool_error(f"Location '{destination}' not found.\n\nAvailable locations: {available}")

                dest_location_name = RoomMappingService.room_key_to_location(dest_room_key) or dest_room_key
                location_display = dest_location_name

                # ============================================================
                # FILESYSTEM-PRIMARY: Find and remove from current locations
                # ============================================================
                state = RoomMappingService.load_state(world_name)
                for room_key, mapping in state.rooms.items():
                    if room_key.startswith("location:") and room_key != dest_room_key:
                        if character_folder in mapping.agents:
                            RoomMappingService.remove_agent_from_room(world_name, room_key, character_folder)
                            logger.info(f"Removed {character_folder} from {room_key}")

                # ============================================================
                # FILESYSTEM-PRIMARY: Add to destination location
                # ============================================================
                RoomMappingService.add_agent_to_room(world_name, dest_room_key, character_folder)
                logger.info(f"Added {character_folder} to {dest_room_key}")

                # ============================================================
                # DB SYNC (create agent if missing, then update location)
                # ============================================================
                try:
                    from services.agent_factory import AgentFactory

                    agent = await crud.get_agent_by_name(db, character_folder, world_name=world_name)

                    # If agent doesn't exist in DB, create it from filesystem config
                    if not agent:
                        config_file = f"worlds/{world_name}/agents/{character_folder}"
                        logger.info(f"Creating missing agent '{character_folder}' in DB from {config_file}")
                        agent = await AgentFactory.create_from_config(
                            db=db,
                            name=character_folder,
                            config_file=config_file,
                            group=None,
                            world_name=world_name,
                        )
                        logger.info(f"Created agent '{character_folder}' in DB (id={agent.id})")

                    dest_location = await crud.get_location_by_name(db, world_id, dest_location_name)
                    if agent and dest_location:
                        # Remove from old locations in DB
                        old_locations = await crud.get_agent_locations_in_world(db, agent.id, world_id)
                        for old_loc in old_locations:
                            if old_loc.id != dest_location.id:
                                await crud.remove_character_from_location(db, agent.id, old_loc.id)
                        # Add to new location in DB
                        await crud.add_character_to_location(db, agent.id, dest_location.id)
                        # Add to room if exists
                        if dest_location.room_id:
                            from crud.room_agents import add_agent_to_room

                            await add_agent_to_room(db, dest_location.room_id, agent.id)
                        logger.info(f"DB sync complete: {character_folder} -> location {dest_location.id}")
                except Exception as db_err:
                    logger.warning(f"DB sync failed (non-critical): {db_err}")

                response_text = (
                    f"**Character Moved:**\n- Name: {character_display_name}\n- Destination: {location_display}"
                )
                if narrative:
                    response_text += f"\n- Narrative: {narrative}"

                return tool_success(response_text)

            except Exception as e:
                logger.error(f"move_character error: {e}", exc_info=True)
                return tool_error(f"Error moving character: {e}")

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
        @track_perf(
            "tool_list_characters",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
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
                    return tool_success(f"No characters in {world_name}.")

                # Build agent-to-location mapping from _state.json
                state = RoomMappingService.load_state(world_name)
                agent_locations: dict[str, str] = {}  # agent_name -> location_folder_name

                for room_key, mapping in state.rooms.items():
                    if room_key.startswith("location:"):
                        loc_name = RoomMappingService.room_key_to_location(room_key) or room_key
                        for agent_name in mapping.agents:
                            # Skip system agents (Narrator, Action_Manager, etc.)
                            if agent_name in ("Narrator", "Action_Manager", "Onboarding_Manager"):
                                continue
                            agent_locations[agent_name] = loc_name

                if location_filter:
                    # Filter characters by location
                    # Find the room key for this location
                    room_key = RoomMappingService.find_location_room_key_fuzzy(world_name, location_filter)
                    if not room_key:
                        return tool_error(f"Location '{location_filter}' not found. Check available locations by `mcp__action_manager__list_locations`")

                    loc_name = RoomMappingService.room_key_to_location(room_key) or room_key
                    location_display = loc_name

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
                        return tool_success(response_text)

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

                return tool_success(response_text)

            except Exception as e:
                logger.error(f"list_characters error: {e}", exc_info=True)
                return tool_error(f"Error listing characters: {e}")

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
        @track_perf(
            "tool_persist_character",
            room_id=lambda: ctx.room_id,
            agent_name=lambda: ctx.agent_name,
            include_result=True,
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
                # in_a_nutshell should be brief - appearance details go in characteristics only
                in_a_nutshell = f"{validated.name} is a {validated.role}."
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
                        room_key = RoomMappingService.location_to_room_key(target_loc.name)
                        if target_loc.room_id:
                            RoomMappingService.ensure_room_mapping_exists(
                                world_name=world_name,
                                room_key=room_key,
                                db_room_id=target_loc.room_id,
                                agents=[],
                            )
                        RoomMappingService.add_agent_to_room(world_name, room_key, agent_name)
                        location_display = target_loc.display_name or target_loc.name
                    else:
                        # Fallback to current location
                        room_key = RoomMappingService.location_to_room_key(current_location_name)
                        RoomMappingService.add_agent_to_room(world_name, room_key, agent_name)
                        location_display = "current location"
                else:
                    room_key = RoomMappingService.location_to_room_key(current_location_name)
                    RoomMappingService.add_agent_to_room(world_name, room_key, agent_name)
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
                # Note: During onboarding, "current" means the onboarding room, not a location room.
                # Characters should NOT be added to the onboarding room - they'll be placed at
                # the initial location by _add_world_agents_to_initial_location() when complete is called.
                if which_location.lower() == "current":
                    # Check if this is the onboarding room (not a location room)
                    world = await crud.get_world(db, world_id)
                    is_onboarding_room = world and world.onboarding_room_id == room_id

                    if not is_onboarding_room:
                        # Only add to room if it's a location room (active gameplay)
                        from crud.room_agents import add_agent_to_room

                        await add_agent_to_room(db, room_id, new_agent.id)
                    else:
                        logger.info(
                            f"Skipping room addition during onboarding - {agent_name} will be placed at initial location"
                        )
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

                return tool_success(response_text)

            except Exception as e:
                logger.error(f"persist_character_design error: {e}", exc_info=True)
                return tool_error(f"Error creating character: {e}")

        tools.append(persist_character_design_tool)

    return tools
