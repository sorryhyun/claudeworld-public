"""
Game mechanics tools for TRPG gameplay.

Contains tools for processing game mechanics:
- inject_memory: Inject memories into specific characters
- roll_the_dice: Random outcome for uncertain events
- list_inventory: List player's inventory items
- list_world_item: List all item templates in the world (with keyword filtering)
- change_stat: Apply stat/inventory changes
- advance_time: Advance in-game time

Uses PlayerFacade for FS-first player state management.

Note:
- persist_item is now in item_tools.py
- narration and suggest_options are now in narrative_tools.py
"""

import logging
import random
from datetime import datetime
from typing import Any

import crud
from claude_agent_sdk import tool
from services.agent_config_service import AgentConfigService
from services.facades import PlayerFacade
from services.item_service import ItemService

from sdk.config.gameplay_inputs import (
    AdvanceTimeInput,
    ChangeStatInput,
    InjectMemoryInput,
    ListWorldItemInput,
)
from sdk.loaders import get_tool_description, is_tool_enabled
from sdk.tools.context import ToolContext

logger = logging.getLogger("GameplayTools.Mechanics")


def create_mechanics_tools(ctx: ToolContext) -> list:
    """
    Create game mechanics tools.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of mechanics tool functions
    """
    tools = []

    # Get required dependencies from context
    db = ctx.require_db()
    world_id = ctx.require_world_id()
    world_name = ctx.require_world_name()

    # Create FS-first facade for player state (with DB sync for polling)
    player_facade = PlayerFacade(world_name, db=db, world_id=world_id)

    # ==========================================================================
    # inject_memory tool - Inject memory into a specific character
    # ==========================================================================
    if is_tool_enabled("inject_memory", default=True):
        inject_memory_description = get_tool_description(
            "inject_memory",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Inject a memory into a specific character's recent_events. Use for supernatural effects like hypnosis, mind control, or illusions.",
        )

        @tool(
            "inject_memory",
            inject_memory_description,
            InjectMemoryInput.model_json_schema(),
        )
        async def inject_memory_tool(args: dict[str, Any]):
            """Inject a memory into a specific character's recent_events file."""
            # Validate input with Pydantic
            validated = InjectMemoryInput(**args)
            character_name = validated.character_name
            memory_entry = validated.memory_entry

            logger.info(f"💉 inject_memory invoked for character: {character_name}")

            try:
                # Find the agent by exact name within this world
                agent = await crud.get_agent_by_name(db, character_name, world_name=world_name)

                if not agent:
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"Character '{character_name}' not found. Use list_characters to see available characters.",
                            }
                        ],
                        "is_error": True,
                    }

                if not agent.config_file:
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"Character '{agent.name}' does not have a config file for memory storage.",
                            }
                        ],
                        "is_error": True,
                    }

                # Format memory entry with source if provided
                formatted_memory = memory_entry

                # Write to the agent's recent_events.md file
                timestamp = datetime.utcnow()
                success = AgentConfigService.append_to_recent_events(
                    config_file=agent.config_file,
                    memory_entry=formatted_memory,
                    timestamp=timestamp,
                )

                if success:
                    # Invalidate agent config cache since recent_events changed
                    from infrastructure.cache import agent_config_key, get_cache

                    cache = get_cache()
                    cache.invalidate(agent_config_key(agent.id))

                    response_text = f"**Memory Injected:**\n- Target: {agent.name}\n- Memory: {memory_entry}"
                    response_text += f"\n\n{agent.name} now remembers this as if it actually happened."
                else:
                    response_text = f"Failed to inject memory into {agent.name}."

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"inject_memory error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error injecting memory: {e}"}],
                    "is_error": True,
                }

        tools.append(inject_memory_tool)

    # ==========================================================================
    # roll_the_dice tool - Random outcome for uncertain events
    # ==========================================================================
    if is_tool_enabled("roll_the_dice", default=True):
        roll_the_dice_description = get_tool_description(
            "roll_the_dice",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Roll the dice to determine a random outcome for uncertain events. "
            "Returns: very_lucky (1%), lucky (5%), nothing_happened (88%), bad_luck (5%), worst_day_of_game (1%).",
        )

        @tool(
            "roll_the_dice",
            roll_the_dice_description,
            {"type": "object", "properties": {}, "required": []},  # No input required
        )
        async def roll_the_dice_tool(args: dict[str, Any]):
            """Roll the dice for a random outcome based on weighted probabilities."""
            logger.info("🎲 roll_the_dice invoked")

            # Weighted random selection
            outcomes = [
                ("very_lucky", 1),
                ("lucky", 5),
                ("nothing_happened", 88),
                ("bad_luck", 5),
                ("worst_day_of_game", 1),
            ]

            # Create weighted list
            weighted_outcomes = []
            for outcome, weight in outcomes:
                weighted_outcomes.extend([outcome] * weight)

            # Random selection
            result = random.choice(weighted_outcomes)

            # Format response based on result
            result_descriptions = {
                "very_lucky": "🌟 **VERY LUCKY!** An exceptional stroke of fortune! "
                "The outcome is far better than expected.",
                "lucky": "🍀 **Lucky!** Fortune favors the bold. The outcome is better than expected.",
                "nothing_happened": "⚖️ **Standard outcome.** Things proceed as one might normally expect.",
                "bad_luck": "😓 **Bad luck.** Things don't go quite as planned. The outcome is worse than expected.",
                "worst_day_of_game": "💀 **WORST DAY!** A critical failure! Something has gone terribly wrong.",
            }

            response_text = f"**Dice Roll Result:** `{result}`\n\n{result_descriptions[result]}"

            logger.info(f"🎲 Roll result: {result}")

            return {"content": [{"type": "text", "text": response_text}]}

        tools.append(roll_the_dice_tool)

    # ==========================================================================
    # list_inventory tool - List player's inventory items
    # ==========================================================================
    if is_tool_enabled("list_inventory", default=True):
        list_inventory_description = get_tool_description(
            "list_inventory",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="List all items in the player's inventory. Returns item names, descriptions, and quantities.",
        )

        @tool(
            "list_inventory",
            list_inventory_description,
            {"type": "object", "properties": {}, "required": []},  # No input required
        )
        async def list_inventory_tool(_args: dict[str, Any]):
            """List all items in the player's inventory."""
            logger.info("📦 list_inventory invoked")

            try:
                # Get resolved inventory from player facade
                inventory = player_facade.get_inventory(resolved=True)

                if not inventory:
                    return {
                        "content": [{"type": "text", "text": "**Inventory:** Empty"}],
                    }

                # Format inventory list
                items_text = []
                for item in inventory:
                    name = item.get("name", "Unknown")
                    quantity = item.get("quantity", 1)
                    description = item.get("description", "")

                    if quantity > 1:
                        entry = f"- **{name}** x{quantity}"
                    else:
                        entry = f"- **{name}**"

                    if description:
                        # Truncate long descriptions
                        desc_preview = description[:80]
                        if len(description) > 80:
                            desc_preview += "..."
                        entry += f": {desc_preview}"

                    items_text.append(entry)

                response_text = f"**Inventory ({len(inventory)} items):**\n\n" + "\n".join(items_text)

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"list_inventory error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error listing inventory: {e}"}],
                    "is_error": True,
                }

        tools.append(list_inventory_tool)

    # ==========================================================================
    # list_world_item tool - List all item templates in the world
    # ==========================================================================
    if is_tool_enabled("list_world_item", default=True):
        list_world_item_description = get_tool_description(
            "list_world_item",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="List all item templates available in the world. Supports keyword-based filtering.",
        )

        @tool(
            "list_world_item",
            list_world_item_description,
            ListWorldItemInput.model_json_schema(),
        )
        async def list_world_item_tool(args: dict[str, Any]):
            """List all item templates in the world, with optional keyword filtering."""
            validated = ListWorldItemInput(**args)
            keyword = validated.keyword

            logger.info(f"📚 list_world_item invoked (keyword: '{keyword or 'none'}')")

            try:
                # Get all item templates from the world's items/ directory
                all_items = ItemService.get_all_items_in_world(world_name)

                if not all_items:
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": "**World Items:** No items defined in this world's items/ directory.",
                            }
                        ],
                    }

                # Filter by keyword if provided
                if keyword:
                    filtered_items = []
                    for item in all_items:
                        name = item.get("name", "").lower()
                        description = item.get("description", "").lower()
                        item_id = item.get("id", "").lower()
                        if keyword in name or keyword in description or keyword in item_id:
                            filtered_items.append(item)
                    items_to_show = filtered_items
                    filter_note = f" matching '{keyword}'"
                else:
                    items_to_show = all_items
                    filter_note = ""

                if not items_to_show:
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"**World Items:** No items found{filter_note}.",
                            }
                        ],
                    }

                # Format items list
                items_text = []
                for item in items_to_show:
                    item_id = item.get("id", "unknown")
                    name = item.get("name", "Unknown")
                    description = item.get("description", "")
                    properties = item.get("default_properties", {})

                    entry = f"- **{name}** (`{item_id}`)"
                    if description:
                        # Truncate long descriptions
                        desc_preview = description[:100]
                        if len(description) > 100:
                            desc_preview += "..."
                        entry += f"\n  {desc_preview}"
                    if properties:
                        props_str = ", ".join(f"{k}: {v}" for k, v in properties.items())
                        entry += f"\n  Properties: {props_str}"

                    items_text.append(entry)

                response_text = (
                    f"**World Items ({len(items_to_show)}{filter_note}):**\n\n"
                    + "\n\n".join(items_text)
                )

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"list_world_item error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error listing world items: {e}"}],
                    "is_error": True,
                }

        tools.append(list_world_item_tool)

    # ==========================================================================
    # change_stat tool - For sub-agents to persist stat/inventory changes
    # ==========================================================================
    if is_tool_enabled("change_stat", default=True):
        change_stat_description = get_tool_description(
            "change_stat",
            agent_name="Stat Calculator",
            group_name=ctx.group_name,
            default="Apply stat and inventory changes to player state. Persists changes to filesystem and database.",
        )

        @tool(
            "change_stat",
            change_stat_description,
            ChangeStatInput.model_json_schema(),
        )
        async def change_stat_tool(args: dict[str, Any]):
            """Apply calculated stat and inventory changes to player state.

            Used by Stat Calculator sub-agent after calculating changes.
            Persists changes to filesystem (primary) and syncs to database.
            """
            validated = ChangeStatInput(**args)

            logger.info(
                f"📊 change_stat: {len(validated.stat_changes)} stats, " f"{len(validated.inventory_changes)} inventory"
            )

            try:
                # Apply stat changes via FS-first facade
                if validated.stat_changes:
                    changes = {}
                    for sc in validated.stat_changes:
                        stat_name = sc.get("stat_name")
                        delta = sc.get("delta", 0)
                        if stat_name:
                            changes[stat_name] = delta
                    if changes:
                        await player_facade.update_stats(changes)
                        logger.info(f"📊 Applied {len(changes)} stat changes (FS-first)")

                # Apply inventory changes via facade
                skipped_items = []
                for inv_change in validated.inventory_changes:
                    action = inv_change.get("action", "add")
                    item_id = inv_change.get("item_id", "")
                    name = inv_change.get("name", "")
                    quantity = inv_change.get("quantity", 1)
                    description = inv_change.get("description")
                    properties = inv_change.get("properties", {})

                    if action == "add" and item_id and name:
                        # Check if item template exists in items/ directory
                        existing_template = ItemService.load_item_template(world_name, item_id)
                        if not existing_template:
                            logger.warning(
                                f"⚠️ Item '{item_id}' not found in items/. "
                                "Use Task with item_designer to create it first."
                            )
                            skipped_items.append({"item_id": item_id, "name": name})
                            continue

                        await player_facade.add_item(
                            item_id=item_id,
                            name=name,
                            quantity=quantity,
                            description=description,
                            properties=properties,
                        )
                        logger.info(f"📦 Added item: {name} (FS-first)")
                    elif action == "remove" and item_id:
                        # Removing items doesn't require template to exist
                        await player_facade.remove_item(item_id, quantity)
                        logger.info(f"📦 Removed item: {name or item_id} (FS-first)")

                # Format response
                response_text = f"**Changes Applied:**\n{validated.summary}"
                if validated.stat_changes:
                    response_text += "\n\n**Stat Changes:**"
                    for sc in validated.stat_changes:
                        delta = sc.get("delta", 0)
                        sign = "+" if delta >= 0 else ""
                        response_text += f"\n- {sc.get('stat_name')}: {sign}{delta}"
                if validated.inventory_changes:
                    response_text += "\n\n**Inventory Changes:**"
                    for ic in validated.inventory_changes:
                        item_id = ic.get("item_id", "")
                        # Check if this item was skipped (use .get() for safety)
                        was_skipped = any(s.get("item_id") == item_id for s in skipped_items)
                        if was_skipped:
                            response_text += f"\n- ⚠️ SKIPPED: {ic.get('name')} (item not in items/ directory)"
                        else:
                            response_text += (
                                f"\n- {ic.get('action', 'add').title()}: {ic.get('name')} x{ic.get('quantity', 1)}"
                            )
                if skipped_items:
                    response_text += (
                        "\n\n**⚠️ Warning:** Some items were skipped because they don't exist "
                        "in the world's items/ directory. Use Task with item_designer "
                        "to create them first."
                    )

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"change_stat error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error applying changes: {e}"}],
                    "is_error": True,
                }

        tools.append(change_stat_tool)

    # ==========================================================================
    # advance_time tool - Advance in-game time
    # ==========================================================================
    if is_tool_enabled("advance_time", default=True):
        advance_time_description = get_tool_description(
            "advance_time",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Advance in-game time. Use for travel, rest, or time-consuming activities.",
        )

        @tool(
            "advance_time",
            advance_time_description,
            AdvanceTimeInput.model_json_schema(),
        )
        async def advance_time_tool(args: dict[str, Any]):
            """Advance in-game time.

            Used for travel, rest, waiting, or any time-consuming activity.
            Updates world clock and returns new time state.
            """
            validated = AdvanceTimeInput(**args)

            logger.info(f"⏰ advance_time: +{validated.minutes}min ({validated.reason})")

            try:
                time_result = await player_facade.advance_time(validated.minutes)

                if time_result:
                    new_time = time_result.new_time
                    response_text = (
                        f"**Time Advanced:** +{validated.minutes} minutes\n"
                        f"- Reason: {validated.reason}\n"
                        f"- New time: {new_time['hour']:02d}:{new_time['minute']:02d} "
                        f"(Day {new_time['day']})"
                    )
                    logger.info(
                        f"⏰ Time now: {new_time['hour']:02d}:{new_time['minute']:02d} " f"Day {new_time['day']}"
                    )
                else:
                    response_text = f"**Time Advanced:** +{validated.minutes} minutes\n" f"- Reason: {validated.reason}"

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"advance_time error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error advancing time: {e}"}],
                    "is_error": True,
                }

        tools.append(advance_time_tool)

    return tools
