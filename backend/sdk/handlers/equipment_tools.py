"""
Equipment management tools for TRPG gameplay.

Contains tools for equipment and item affordance management:
- equip_item: Equip an item from inventory to a slot
- unequip_item: Unequip an item from a slot
- use_item: Use an item's affordance (check requirements, apply costs/effects)
- list_equipment: List currently equipped items and their effects
- set_flag: Set player flags for game state tracking

Uses PlayerFacade for FS-first state management with DB sync.
"""

import logging
from typing import Any

from claude_agent_sdk import tool

from sdk.config.gameplay_tool_definitions import (
    EquipItemInput,
    ListEquipmentInput,
    SetFlagInput,
    UnequipItemInput,
    UseItemInput,
)
from sdk.loaders import get_tool_description, is_tool_enabled
from sdk.tools.context import ToolContext

logger = logging.getLogger("GameplayTools.Equipment")


def create_equipment_tools(ctx: ToolContext) -> list:
    """
    Create equipment management tools.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of equipment tool functions
    """
    tools = []

    # Get required dependencies from context
    player_facade = ctx.require_player_facade()

    # ==========================================================================
    # equip_item tool - Equip an item from inventory to a slot
    # ==========================================================================
    if is_tool_enabled("equip_item", default=True):
        equip_item_description = get_tool_description(
            "equip_item",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Equip an item from inventory to an equipment slot. "
            "The item must be in inventory and equippable to the specified slot.",
        )

        @tool(
            "equip_item",
            equip_item_description,
            EquipItemInput.model_json_schema(),
        )
        async def equip_item_tool(args: dict[str, Any]):
            """Equip an item from inventory to a slot."""
            validated = EquipItemInput(**args)

            logger.info(f"⚔️ equip_item: {validated.item_id} -> {validated.slot or 'auto'}")

            try:
                result = await player_facade.equip_item_to_slot(
                    item_id=validated.item_id,
                    slot=validated.slot,
                )

                if result.success:
                    response = f"✓ {result.message}"
                    if result.unequipped_item_id:
                        response += f"\n  (Previous item '{result.unequipped_item_id}' returned to inventory)"
                    return {"content": [{"type": "text", "text": response}]}
                else:
                    return {"content": [{"type": "text", "text": f"✗ {result.message}"}]}

            except Exception as e:
                logger.error(f"equip_item error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error equipping item: {e}"}],
                    "is_error": True,
                }

        tools.append(equip_item_tool)

    # ==========================================================================
    # unequip_item tool - Unequip an item from a slot
    # ==========================================================================
    if is_tool_enabled("unequip_item", default=True):
        unequip_item_description = get_tool_description(
            "unequip_item",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Unequip an item from an equipment slot, returning it to inventory.",
        )

        @tool(
            "unequip_item",
            unequip_item_description,
            UnequipItemInput.model_json_schema(),
        )
        async def unequip_item_tool(args: dict[str, Any]):
            """Unequip an item from a slot."""
            validated = UnequipItemInput(**args)

            logger.info(f"⚔️ unequip_item: {validated.slot}")

            try:
                result = await player_facade.unequip_from_slot(slot=validated.slot)

                if result.success:
                    return {"content": [{"type": "text", "text": f"✓ {result.message}"}]}
                else:
                    return {"content": [{"type": "text", "text": f"✗ {result.message}"}]}

            except Exception as e:
                logger.error(f"unequip_item error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error unequipping item: {e}"}],
                    "is_error": True,
                }

        tools.append(unequip_item_tool)

    # ==========================================================================
    # use_item tool - Use an item's affordance
    # ==========================================================================
    if is_tool_enabled("use_item", default=True):
        use_item_description = get_tool_description(
            "use_item",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Use an item's affordance. Checks requirements, applies costs and effects, "
            "and updates charges/cooldowns. May consume the item.",
        )

        @tool(
            "use_item",
            use_item_description,
            UseItemInput.model_json_schema(),
        )
        async def use_item_tool(args: dict[str, Any]):
            """Use an item's affordance."""
            validated = UseItemInput(**args)

            logger.info(f"🎯 use_item: {validated.item_id}.{validated.affordance_id}")

            try:
                result = await player_facade.use_item_affordance(
                    item_id=validated.item_id,
                    affordance_id=validated.affordance_id,
                    context=validated.context,
                )

                if result.success:
                    response = f"✓ {result.message}"
                    if result.item_removed:
                        response += "\n  (Item consumed)"
                    return {"content": [{"type": "text", "text": response}]}
                else:
                    return {"content": [{"type": "text", "text": f"✗ {result.message}"}]}

            except Exception as e:
                logger.error(f"use_item error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error using item: {e}"}],
                    "is_error": True,
                }

        tools.append(use_item_tool)

    # ==========================================================================
    # list_equipment tool - List currently equipped items
    # ==========================================================================
    if is_tool_enabled("list_equipment", default=True):
        list_equipment_description = get_tool_description(
            "list_equipment",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="List all currently equipped items and their passive effects.",
        )

        @tool(
            "list_equipment",
            list_equipment_description,
            ListEquipmentInput.model_json_schema(),
        )
        async def list_equipment_tool(_args: dict[str, Any]):
            """List equipped items."""
            logger.info("⚔️ list_equipment")

            try:
                equipment = player_facade.get_equipment()

                if not equipment:
                    return {"content": [{"type": "text", "text": "No equipment slots defined for this world."}]}

                lines = ["**Current Equipment:**"]
                for slot, item_data in equipment.items():
                    if item_data:
                        effects = item_data.get("passive_effects", {})
                        effects_str = ", ".join(f"{k}: {v:+g}" for k, v in effects.items()) if effects else "none"
                        lines.append(f"  [{slot}] {item_data['name']} (effects: {effects_str})")
                    else:
                        lines.append(f"  [{slot}] (empty)")

                return {"content": [{"type": "text", "text": "\n".join(lines)}]}

            except Exception as e:
                logger.error(f"list_equipment error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error listing equipment: {e}"}],
                    "is_error": True,
                }

        tools.append(list_equipment_tool)

    # ==========================================================================
    # set_flag tool - Set player flags for game state tracking
    # ==========================================================================
    if is_tool_enabled("set_flag", default=True):
        set_flag_description = get_tool_description(
            "set_flag",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Set player flags for game state tracking. "
            "Flags are used for item affordance requirements and story progression.",
        )

        @tool(
            "set_flag",
            set_flag_description,
            SetFlagInput.model_json_schema(),
        )
        async def set_flag_tool(args: dict[str, Any]):
            """Set player flags."""
            validated = SetFlagInput(**args)

            logger.info(f"🚩 set_flag: {validated.flag} = {validated.value}")

            try:
                success = await player_facade.set_flags({validated.flag: validated.value})

                if success:
                    return {
                        "content": [{"type": "text", "text": f"✓ Flag '{validated.flag}' set to {validated.value}"}]
                    }
                else:
                    return {"content": [{"type": "text", "text": "✗ Could not set flag (player state not found)"}]}

            except Exception as e:
                logger.error(f"set_flag error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error setting flag: {e}"}],
                    "is_error": True,
                }

        tools.append(set_flag_tool)

    return tools
