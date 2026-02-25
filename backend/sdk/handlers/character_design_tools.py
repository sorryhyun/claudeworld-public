"""
Character design tools for comprehensive character creation.

Provides tools for creating detailed characters with backstory and consolidated memory.
Used by detailed_character_designer agent during onboarding.
"""

import logging
from typing import Any

from services.agent_filesystem_service import AgentFilesystemService
from services.world_service import WorldService

from sdk.handlers.context import ToolContext
from sdk.loaders import is_tool_enabled
from sdk.tools.character_design import (
    CreateComprehensiveCharacterInput,
    ImplantConsolidatedMemoryInput,
)

logger = logging.getLogger("CharacterDesignTools")


def create_character_design_tools(ctx: ToolContext) -> list:
    """Create character design tools for comprehensive character creation.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of character design tool functions
    """
    import crud
    from services.agent_factory import AgentFactory
    from services.room_mapping_service import RoomMappingService

    from sdk.handlers.common import build_action_context

    tools = []

    # Extract context variables
    world_name = ctx.world_name
    world_id = ctx.world_id
    room_id = ctx.room_id
    db = ctx.db

    # Import tool definitions
    if is_tool_enabled("create_comprehensive_character"):

        async def create_comprehensive_character_tool(args: dict[str, Any]):
            """Create a comprehensive character with detailed backstory.

            Used by detailed_character_designer during onboarding to create
            rich, memorable characters with depth and complexity.
            """
            validated = CreateComprehensiveCharacterInput(**args)

            logger.info(
                f"create_comprehensive_character: {validated.name} ({validated.role}) in {world_name}"
            )

            try:
                # Create agent in filesystem
                agent_name = validated.name.replace(" ", "_")

                # Build comprehensive agent files
                # in_a_nutshell: Brief identity (name + role)
                in_a_nutshell = f"{validated.name} is a {validated.role}."

                # characteristics: Full personality, appearance, backstory
                characteristics = f"""## Role
{validated.role}

## Appearance
{validated.appearance}

## Personality
{validated.personality}

## Backstory
{validated.backstory}

## Initial Disposition
{validated.initial_disposition}"""

                if validated.secret:
                    characteristics += f"\n\n## Hidden Detail\n{validated.secret}"

                # Create agent folder and files
                AgentFilesystemService.create_agent(
                    world_name, agent_name, in_a_nutshell, characteristics
                )

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
                        location_display = target_loc.name
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
                new_agent = await AgentFactory.create_from_config(
                    db=db,
                    name=agent_name,
                    config_file=f"worlds/{world_name}/agents/{agent_name}",
                    group=None,
                )

                # Add to room/location in DB
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

                logger.info(f"Created comprehensive character: {validated.name} at {location_display}")

                # Build response
                memory_note = ""
                if validated.initial_memories:
                    memory_note = f"\n\n**Note:** Call `implant_consolidated_memory` next to add {len(validated.initial_memories)} initial memories."

                response_text = f"""**Comprehensive Character Created:**

**Basic Info:**
- Name: {validated.name}
- Role: {validated.role}
- Location: {location_display}
- Disposition: {validated.initial_disposition}

**Profile:**
- Appearance: {len(validated.appearance)} chars
- Personality: {len(validated.personality)} chars
- Backstory: {len(validated.backstory)} chars
- Secret: {"Yes" if validated.secret else "None"}

**Files Created:**
- `in_a_nutshell.md` - Brief identity
- `characteristics.md` - Full profile with backstory{memory_note}"""

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"create_comprehensive_character error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error creating comprehensive character: {e}"}],
                    "is_error": True,
                }

        tools.append(create_comprehensive_character_tool)

    if is_tool_enabled("implant_consolidated_memory"):

        async def implant_consolidated_memory_tool(args: dict[str, Any]):
            """Implant consolidated memories into a character's memory file.

            Populates consolidated_memory.md with formatted memories.
            """
            validated = ImplantConsolidatedMemoryInput(**args)

            logger.info(
                f"implant_consolidated_memory: {validated.character_name} - {len(validated.memories)} memories ({validated.mode})"
            )

            try:
                # Convert character name to filesystem-safe name
                agent_name = validated.character_name.replace(" ", "_")

                # Get agent path
                world_path = WorldService.get_world_path(world_name)
                agent_path = world_path / "agents" / agent_name

                if not agent_path.exists():
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"Error: Character '{validated.character_name}' not found in world. "
                                f"Create the character first using create_comprehensive_character.",
                            }
                        ],
                        "is_error": True,
                    }

                # Prepare consolidated_memory.md path
                memory_file = agent_path / "consolidated_memory.md"

                # Build memory content in correct format
                memory_content_parts = []

                # If append mode and file exists, read existing content
                if validated.mode == "append" and memory_file.exists():
                    existing_content = memory_file.read_text(encoding="utf-8").strip()
                    if existing_content:
                        memory_content_parts.append(existing_content)

                # Add new memories
                for memory in validated.memories:
                    memory_section = f"## [{memory.subtitle}]\n{memory.content}"
                    memory_content_parts.append(memory_section)

                # Join all parts with double newline
                final_content = "\n\n".join(memory_content_parts)

                # Write to file
                memory_file.write_text(final_content, encoding="utf-8")

                logger.info(
                    f"Implanted {len(validated.memories)} memories for {validated.character_name} ({validated.mode} mode)"
                )

                # Build response
                operation_text = "added" if validated.mode == "append" else "set"
                total_memories = len(validated.memories)
                if validated.mode == "append" and memory_file.exists():
                    # Count total ## headers in file
                    total_memories = final_content.count("## [")

                response_text = f"""**Consolidated Memories Implanted:**

**Character:** {validated.character_name}
**Operation:** {validated.mode}
**Memories {operation_text}:** {len(validated.memories)}
**Total memories in file:** {total_memories}

**Memory Subtitles:**
"""
                for i, memory in enumerate(validated.memories, 1):
                    response_text += f"{i}. [{memory.subtitle}]\n"

                response_text += """
**File:** `consolidated_memory.md`
**Format:** Memories stored with `## [subtitle]` headers

The character can now recall these memories using the `recall` tool."""

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"implant_consolidated_memory error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error implanting memories: {e}"}],
                    "is_error": True,
                }

        tools.append(implant_consolidated_memory_tool)

    return tools
