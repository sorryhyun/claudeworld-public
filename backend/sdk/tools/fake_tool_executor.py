"""
Fake Tool Call Executor for Background Sub-Agent Tool Calls.

When sub-agents are invoked via Task tool with run_in_background: true,
they may output tool calls as plain text (XML or JSON) instead of actual MCP calls.
This happens when the message pump can't keep the SDK control channel open.

This module parses those "fake" tool calls from text and executes
the corresponding handlers directly.

Supported formats:
1. XML format:
    <function_calls>
    <invoke name="mcp__action_manager__persist_character_design">
    <parameter name="name">HANA-07</parameter>
    ...
    </invoke>
    </function_calls>

2. JSON format (raw parameters, tool inferred from fields):
    {"name": "HANA-07", "role": "...", "appearance": "...", ...}
"""

import json
import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from sdk.tools.context import ToolContext

logger = logging.getLogger("FakeToolExecutor")


@dataclass
class ParsedFakeToolCall:
    """Represents a parsed fake tool call from text."""

    tool_name: str
    parameters: dict[str, Any]


def _infer_tool_from_json(params: dict[str, Any]) -> Optional[str]:
    """Infer the tool name from JSON parameters based on field signatures."""
    # Character design: has name, role, appearance, personality
    if all(k in params for k in ["name", "role", "appearance", "personality"]):
        return "mcp__action_manager__persist_character_design"

    # Location design: has name, display_name, description
    if all(k in params for k in ["name", "display_name", "description"]):
        return "mcp__action_manager__persist_location_design"

    # Stat changes: has summary and at least one of stat_changes/inventory_changes
    if "summary" in params and ("stat_changes" in params or "inventory_changes" in params):
        return "mcp__action_manager__persist_stat_changes"

    return None


def parse_fake_tool_calls(text: str) -> list[ParsedFakeToolCall]:
    """
    Parse fake tool calls from text (supports both XML and JSON formats).

    Args:
        text: The text that may contain fake tool calls

    Returns:
        List of ParsedFakeToolCall objects
    """
    calls = []

    # Try XML format first: <function_calls>...</function_calls>
    xml_pattern = r"<function_calls>(.*?)</function_calls>"
    xml_matches = re.findall(xml_pattern, text, re.DOTALL)

    for match in xml_matches:
        try:
            xml_str = f"<root>{match}</root>"
            root = ET.fromstring(xml_str)

            for invoke in root.findall(".//invoke"):
                tool_name = invoke.get("name")
                if not tool_name:
                    continue

                params: dict[str, Any] = {}
                for param in invoke.findall("parameter"):
                    param_name = param.get("name")
                    param_value = param.text or ""
                    if param_name:
                        params[param_name] = param_value

                calls.append(ParsedFakeToolCall(tool_name=tool_name, parameters=params))
                logger.info(f"Parsed XML fake tool call: {tool_name}")

        except ET.ParseError as e:
            logger.warning(f"Failed to parse XML block: {e}")
            continue

    # If no XML found, try JSON format: {...}
    if not calls:
        # Find JSON objects in text (look for {...} patterns)
        json_pattern = r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}"
        json_matches = re.findall(json_pattern, text, re.DOTALL)

        for match in json_matches:
            try:
                params = json.loads(match)
                if not isinstance(params, dict):
                    continue

                # Infer tool name from parameters
                tool_name = _infer_tool_from_json(params)
                if tool_name:
                    calls.append(ParsedFakeToolCall(tool_name=tool_name, parameters=params))
                    logger.info(f"Parsed JSON fake tool call: {tool_name}")

            except json.JSONDecodeError:
                continue

    return calls


async def execute_fake_tool_call(
    call: ParsedFakeToolCall,
    ctx: "ToolContext",
) -> Optional[dict[str, Any]]:
    """
    Execute a parsed fake tool call by calling the handler directly.

    Args:
        call: The parsed fake tool call
        ctx: ToolContext with dependencies (db, world_id, etc.)

    Returns:
        Tool result dict or None if handler not found/failed
    """
    logger.info(f"Executing fake tool call: {call.tool_name}")

    try:
        if call.tool_name == "mcp__action_manager__persist_stat_changes":
            return await _execute_persist_stat_changes(call.parameters, ctx)

        elif call.tool_name == "mcp__action_manager__persist_character_design":
            return await _execute_persist_character_design(call.parameters, ctx)

        elif call.tool_name == "mcp__action_manager__persist_location_design":
            return await _execute_persist_location_design(call.parameters, ctx)

        else:
            logger.warning(f"No handler for fake tool: {call.tool_name}")
            return None

    except Exception as e:
        logger.error(f"Error executing fake tool {call.tool_name}: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


async def _execute_persist_stat_changes(
    params: dict[str, Any],
    ctx: "ToolContext",
) -> dict[str, Any]:
    """Execute persist_stat_changes tool."""
    from services.facades import PlayerFacade
    from services.item_service import ItemService

    from sdk.config.gameplay_inputs import PersistStatChangesInput

    validated = PersistStatChangesInput(**params)
    world_name = ctx.require_world_name()
    world_id = ctx.require_world_id()
    db = ctx.require_db()

    player_facade = PlayerFacade(world_name, db=db, world_id=world_id)

    # Apply stat changes
    if validated.stat_changes:
        changes = {}
        for sc in validated.stat_changes:
            stat_name = sc.get("stat_name")
            delta = sc.get("delta", 0)
            if stat_name:
                changes[stat_name] = delta
        if changes:
            await player_facade.update_stats(changes)
            logger.info(f"Applied {len(changes)} stat changes")

    # Apply inventory changes
    for inv_change in validated.inventory_changes:
        action = inv_change.get("action", "add")
        item_id = inv_change.get("item_id", "")
        name = inv_change.get("name", "")
        quantity = inv_change.get("quantity", 1)
        description = inv_change.get("description")
        properties = inv_change.get("properties", {})

        if action == "add" and item_id and name:
            existing = ItemService.load_item_template(world_name, item_id)
            if existing:
                await player_facade.add_item(
                    item_id=item_id,
                    name=name,
                    quantity=quantity,
                    description=description,
                    properties=properties,
                )
                logger.info(f"Added item: {name}")
        elif action == "remove" and item_id:
            await player_facade.remove_item(item_id, quantity)
            logger.info(f"Removed item: {name or item_id}")

    # Advance time
    if validated.time_advance_minutes > 0:
        await player_facade.advance_time(validated.time_advance_minutes)
        logger.info(f"Advanced time: +{validated.time_advance_minutes}min")

    return {"success": True, "summary": validated.summary}


async def _execute_persist_character_design(
    params: dict[str, Any],
    ctx: "ToolContext",
) -> dict[str, Any]:
    """Execute persist_character_design tool."""
    import crud
    from crud.room_agents import add_agent_to_room
    from services.agent_factory import AgentFactory
    from services.agent_filesystem_service import AgentFilesystemService
    from services.location_service import LocationService

    from sdk.config.gameplay_inputs import PersistCharacterDesignInput
    from sdk.tools.gameplay_tools.common import build_action_context

    validated = PersistCharacterDesignInput(**params)
    world_name = ctx.require_world_name()
    world_id = ctx.require_world_id()
    db = ctx.require_db()
    room_id = ctx.room_id  # May be None if not in a room context

    # Create agent files in filesystem
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
    new_agent = await AgentFactory.create_from_config(
        db=db,
        name=agent_name,
        config_file=f"worlds/{world_name}/agents/{agent_name}",
        group=None,
    )

    # Add to room/location in DB
    if which_location.lower() == "current" and room_id:
        await add_agent_to_room(db, room_id, new_agent.id)
    else:
        target_loc = await crud.get_location_by_name(db, world_id, which_location)
        if target_loc:
            await crud.add_character_to_location(db, new_agent.id, target_loc.id)

    logger.info(f"Created character: {validated.name} at {location_display}")

    return {"success": True, "name": validated.name, "location": location_display}


async def _execute_persist_location_design(
    params: dict[str, Any],
    ctx: "ToolContext",
) -> dict[str, Any]:
    """Execute persist_location_design tool."""
    import crud
    from services.persistence_manager import PersistenceManager

    from sdk.config.gameplay_inputs import PersistLocationDesignInput

    validated = PersistLocationDesignInput(**params)
    world_name = ctx.require_world_name()
    world_id = ctx.require_world_id()
    db = ctx.require_db()

    # Check if location already exists
    db_locations = await crud.get_locations(db, world_id)
    location_name_lower = validated.name.lower()

    for loc in db_locations:
        if loc.name.lower() == location_name_lower or (
            loc.display_name and loc.display_name.lower() == location_name_lower
        ):
            logger.warning(f"Location '{validated.name}' already exists, skipping")
            return {"success": False, "error": f"Location '{validated.name}' already exists"}

    # Build adjacent hints
    adjacent_hints = []
    if validated.adjacent_to:
        adjacent_hints = [validated.adjacent_to]

    # Use PersistenceManager for coordinated FS + DB creation
    pm = PersistenceManager(db, world_id, world_name)
    new_location_id = await pm.create_location(
        name=validated.name,
        display_name=validated.display_name,
        description=validated.description,
        position=(validated.position_x, validated.position_y),
        adjacent_hints=adjacent_hints,
        is_starting=False,
    )

    # Connect to adjacent locations in DB
    if adjacent_hints:
        for adj_name in adjacent_hints:
            adj_loc = next((loc for loc in db_locations if loc.name == adj_name), None)
            if adj_loc:
                await crud.add_adjacent_location(db, new_location_id, adj_loc.id)
                await crud.add_adjacent_location(db, adj_loc.id, new_location_id)

    logger.info(f"Created location: {validated.display_name} (id={new_location_id})")

    return {"success": True, "display_name": validated.display_name, "id": new_location_id}
