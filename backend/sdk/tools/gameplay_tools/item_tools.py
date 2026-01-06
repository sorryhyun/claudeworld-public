"""
Item management tools for TRPG gameplay.

Contains tools for item creation and management:
- persist_item: Create item templates (used by sub-agents via Task tool)

Uses ItemService for filesystem-first item template management.
When add_to_inventory is True, items are also added to player inventory
via PlayerFacade (which syncs to DB for frontend display).

Supports batch creation of multiple items in a single call.
"""

import logging
from typing import Any

from claude_agent_sdk import tool
from services.facades import PlayerFacade
from services.item_service import ItemService

from sdk.config.subagent_tool_definitions import PersistItemInput
from sdk.loaders import get_tool_description, is_tool_enabled
from sdk.tools.context import ToolContext

logger = logging.getLogger("GameplayTools.Item")


def create_item_tools(ctx: ToolContext) -> list:
    """
    Create item management tools.

    Args:
        ctx: Unified tool context containing agent info and dependencies

    Returns:
        List of item tool functions
    """
    tools = []

    # Get required dependencies from context
    world_name = ctx.require_world_name()

    # Get optional db/world_id for DB sync (may be None for sub-agents)
    db = ctx.db
    world_id = ctx.world_id

    # Create PlayerFacade for FS-first with DB sync (if available)
    player_facade = PlayerFacade(world_name, db=db, world_id=world_id) if db and world_id else None

    # ==========================================================================
    # persist_item tool - Create item templates in items/ directory
    # ==========================================================================
    if is_tool_enabled("persist_item", default=True):
        persist_item_description = get_tool_description(
            "persist_item",
            agent_name="Item Designer",
            group_name=ctx.group_name,
            default="Persist one or more item designs to the game world. "
            "Creates item templates in filesystem (items/[item_id].yaml).",
        )

        @tool(
            "persist_item",
            persist_item_description,
            PersistItemInput.model_json_schema(),
        )
        async def persist_item_tool(args: dict[str, Any]):
            """Persist item designs to the game world.

            Supports creating multiple items in a single call.
            Items are created here by Item Designer sub-agent before they can be
            added to player inventory via change_stat.
            """
            validated = PersistItemInput(**args)

            logger.info(f"📦 persist_item: {len(validated.items)} item(s)")

            created_items = []
            skipped_items = []
            inventory_added = []

            try:
                # Process each item
                for item in validated.items:
                    # Check if item already exists
                    existing = ItemService.load_item_template(world_name, item.item_id)
                    if existing:
                        skipped_items.append(item.item_id)
                        logger.warning(f"⚠️ Item '{item.item_id}' already exists, skipping")
                        continue

                    # Save the new item template with all new optional fields
                    ItemService.save_item_template(
                        world_name,
                        item_id=item.item_id,
                        name=item.name,
                        description=item.description,
                        properties=item.properties,
                        # NEW fields for world-agnostic item system
                        category=item.category,
                        tags=item.tags,
                        rarity=item.rarity,
                        icon=item.icon,
                        stacking=item.stacking.model_dump() if item.stacking else None,
                        equippable=item.equippable.model_dump() if item.equippable else None,
                        usable=item.usable.model_dump() if item.usable else None,
                    )
                    created_items.append(item)
                    logger.info(f"✅ Created item template: {item.item_id}")

                # Add to inventory if requested (used during onboarding for starting items)
                if validated.add_to_inventory and created_items:
                    if player_facade:
                        # Use PlayerFacade for FS-first with DB sync
                        for item in created_items:
                            await player_facade.add_item(
                                item_id=item.item_id,
                                name=item.name,
                                quantity=item.quantity,
                                description=item.description,
                                properties=item.properties,
                            )
                            inventory_added.append(f"{item.quantity}x {item.name}")
                            logger.info(f"✅ Added {item.quantity}x {item.item_id} to inventory (with DB sync)")
                    else:
                        # Fallback: FS-only (no DB sync available)
                        from services.player_service import PlayerService

                        player_state = PlayerService.load_player_state(world_name)
                        if player_state:
                            for item in created_items:
                                inventory_entry = {
                                    "item_id": item.item_id,
                                    "quantity": item.quantity,
                                }
                                player_state.inventory.append(inventory_entry)
                                inventory_added.append(f"{item.quantity}x {item.name}")
                                logger.info(f"✅ Added {item.quantity}x {item.item_id} to inventory (FS-only)")
                            PlayerService.save_player_state(world_name, player_state)
                        else:
                            logger.warning("Could not load player state to add items to inventory")

                # Build response
                response_parts = []

                if created_items:
                    response_parts.append(f"**Created {len(created_items)} item(s):**")
                    for item in created_items:
                        item_line = f"- `{item.item_id}`: {item.name}"
                        if item.properties:
                            props = ", ".join(f"{k}={v}" for k, v in item.properties.items())
                            item_line += f" ({props})"
                        response_parts.append(item_line)

                if skipped_items:
                    response_parts.append(
                        f"\n**Skipped {len(skipped_items)} (already exist):** {', '.join(skipped_items)}"
                    )

                if inventory_added:
                    response_parts.append(f"\n**Added to inventory:** {', '.join(inventory_added)}")
                elif validated.add_to_inventory and not created_items:
                    response_parts.append("\n⚠️ No items added to inventory (all items already existed)")
                elif not validated.add_to_inventory and created_items:
                    response_parts.append("\nAction Manager can add these items to inventory via change_stat.")

                return {"content": [{"type": "text", "text": "\n".join(response_parts)}]}

            except Exception as e:
                logger.error(f"persist_item error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error creating items: {e}"}],
                    "is_error": True,
                }

        tools.append(persist_item_tool)

    return tools
