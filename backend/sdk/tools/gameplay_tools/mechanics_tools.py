"""
Game mechanics tools for TRPG gameplay.

Contains tools for processing game mechanics:
- persist_stat_changes: Apply stat/inventory changes (used by sub-agents via Task tool)
- inject_memory: Inject memories into specific characters
- narration: Create visible narrative messages
- suggest_options: Provide suggested actions for player

Uses PlayerFacade for FS-first player state management.
"""

import logging
import random
from datetime import datetime
from typing import Any

import crud
import schemas
from claude_agent_sdk import tool
from domain.value_objects.enums import MessageRole
from services.agent_config_service import AgentConfigService
from services.facades import PlayerFacade
from services.item_service import ItemService
from services.location_service import LocationService

from sdk.config.gameplay_inputs import (
    InjectMemoryInput,
    NarrationInput,
    PersistStatChangesInput,
    SuggestOptionsInput,
)
from sdk.config.onboarding_inputs import InventoryItem
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
    # narration tool - Create visible narrative message (replaces Narrator)
    # ==========================================================================
    if is_tool_enabled("narration", default=True):
        narration_description = get_tool_description(
            "narration",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="REQUIRED: Create a visible narrative message describing the outcome. "
            "This is the text the player will see. Make it vivid and engaging.",
        )

        @tool(
            "narration",
            narration_description,
            NarrationInput.model_json_schema(),
        )
        async def narration_tool(args: dict[str, Any]):
            """
            Create a visible narrative message in the conversation.

            This replaces the separate Narrator agent. Action Manager now
            handles both interpretation and narration in a single turn.
            """
            # Validate input with Pydantic
            validated = NarrationInput(**args)
            narrative = validated.narrative

            logger.info(f"📖 narration called | length={len(narrative)}")

            try:
                # Get Action Manager's agent_id and room_id from context
                agent_id = ctx.require_agent_id()
                room_id = ctx.require_room_id()

                # Create message via crud.create_message()
                message = schemas.MessageCreate(
                    content=narrative,
                    role=MessageRole.ASSISTANT,
                    agent_id=agent_id,
                )
                await crud.create_message(db, room_id, message, update_room_activity=True)

                # Signal that narration has been produced (allows input unblocking)
                # Lazy import to avoid circular dependency
                from orchestration.trpg_orchestrator import get_trpg_orchestrator
                get_trpg_orchestrator().set_narration_produced(room_id)

                logger.info(f"✅ Narrative message created | room={room_id} | agent={agent_id}")

                return {
                    "content": [
                        {
                            "type": "text",
                            "text": "✓ Narrative message created and displayed to player.",
                        }
                    ]
                }

            except Exception as e:
                logger.error(f"narration error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error creating narrative: {e}"}],
                    "is_error": True,
                }

        tools.append(narration_tool)

    # ==========================================================================
    # suggest_options tool - Provide suggested actions for player (replaces Narrator's suggest_actions)
    # ==========================================================================
    if is_tool_enabled("suggest_options", default=True):
        suggest_options_description = get_tool_description(
            "suggest_options",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="REQUIRED: Provide two suggested actions for the player. "
            "These appear as clickable buttons in the UI.",
        )

        @tool(
            "suggest_options",
            suggest_options_description,
            SuggestOptionsInput.model_json_schema(),
        )
        async def suggest_options_tool(args: dict[str, Any]):
            """
            Provide two suggested actions for the player.

            These suggestions appear as clickable buttons in the UI.
            Replaces the Narrator's suggest_actions tool.
            """
            # Validate input with Pydantic
            validated = SuggestOptionsInput(**args)
            action_1 = validated.action_1
            action_2 = validated.action_2

            logger.info(f"💡 suggest_options invoked: [{action_1}] / [{action_2}]")

            if not action_1 or not action_2:
                return {
                    "content": [{"type": "text", "text": "Please provide both action suggestions."}],
                    "is_error": True,
                }

            # Persist suggestions to _state.json for frontend retrieval
            try:
                LocationService.save_suggestions(world_name, [action_1, action_2])
                logger.info(f"💾 Suggestions persisted to _state.json for world: {world_name}")
            except Exception as e:
                logger.error(f"Failed to persist suggestions: {e}")

            # Format response for the system
            response_text = f"""**Suggested Actions:**
1. {action_1}
2. {action_2}"""

            return {
                "content": [{"type": "text", "text": response_text}],
            }

        tools.append(suggest_options_tool)

    # ==========================================================================
    # persist_new_item tool - Create item templates in items/ directory
    # ==========================================================================
    if is_tool_enabled("persist_new_item", default=True):
        persist_new_item_description = get_tool_description(
            "persist_new_item",
            agent_name="Action Manager",
            group_name=ctx.group_name,
            default="Create a new item template in the world's items/ directory. "
            "Use this BEFORE calling stat_calc to add items to inventory.",
        )

        @tool(
            "persist_new_item",
            persist_new_item_description,
            InventoryItem.model_json_schema(),
        )
        async def persist_new_item_tool(args: dict[str, Any]):
            """Create a new item template in the world's items/ directory.

            Items must be created here before they can be added to player inventory
            via the stat_calculator sub-agent.
            """
            validated = InventoryItem(**args)

            logger.info(f"📦 persist_new_item: {validated.item_id} ({validated.name})")

            try:
                # Check if item already exists
                existing = ItemService.load_item_template(world_name, validated.item_id)
                if existing:
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": f"**Error:** Item '{validated.item_id}' already exists.\n"
                                f"Use the existing item or choose a different item_id.",
                            }
                        ],
                        "is_error": True,
                    }

                # Save the new item template
                ItemService.save_item_template(
                    world_name,
                    item_id=validated.item_id,
                    name=validated.name,
                    description=validated.description,
                    properties=validated.properties,
                )

                logger.info(f"✅ Created item template: {validated.item_id} in {world_name}/items/")

                response_text = (
                    f"**Item Created:** {validated.name}\n"
                    f"- ID: `{validated.item_id}`\n"
                    f"- Location: `items/{validated.item_id}.yaml`"
                )
                if validated.description:
                    response_text += f"\n- Description: {validated.description}"
                if validated.properties:
                    props_str = ", ".join(f"{k}: {v}" for k, v in validated.properties.items())
                    response_text += f"\n- Properties: {props_str}"

                response_text += "\n\nYou can now use stat_calculator to add this item to player inventory."

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"persist_new_item error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error creating item: {e}"}],
                    "is_error": True,
                }

        tools.append(persist_new_item_tool)

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
    # persist_stat_changes tool - For sub-agents to persist stat/inventory changes
    # ==========================================================================
    if is_tool_enabled("persist_stat_changes", default=True):
        persist_stat_description = get_tool_description(
            "persist_stat_changes",
            agent_name="Stat Calculator",
            group_name=ctx.group_name,
            default="Apply stat and inventory changes to player state. Persists changes to filesystem and database.",
        )

        @tool(
            "persist_stat_changes",
            persist_stat_description,
            PersistStatChangesInput.model_json_schema(),
        )
        async def persist_stat_changes_tool(args: dict[str, Any]):
            """Apply calculated stat and inventory changes to player state.

            Used by Stat Calculator sub-agent after calculating changes.
            Persists changes to filesystem (primary) and syncs to database.
            """
            validated = PersistStatChangesInput(**args)

            logger.info(
                f"📊 persist_stat_changes: {len(validated.stat_changes)} stats, "
                f"{len(validated.inventory_changes)} inventory, "
                f"{validated.time_advance_minutes}min time"
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
                                "Action Manager must create it with persist_new_item first."
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

                # Advance time if requested
                time_result = None
                if validated.time_advance_minutes > 0:
                    time_result = await player_facade.advance_time(validated.time_advance_minutes)
                    if time_result:
                        logger.info(
                            f"⏰ Advanced time: +{validated.time_advance_minutes}min -> "
                            f"{time_result.new_time['hour']:02d}:{time_result.new_time['minute']:02d} "
                            f"Day {time_result.new_time['day']}"
                        )

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
                        "in the world's items/ directory. Action Manager must create them "
                        "with `persist_new_item` first."
                    )
                if time_result:
                    response_text += (
                        f"\n\n**Time Advanced:** +{validated.time_advance_minutes} minutes "
                        f"→ {time_result.new_time['hour']:02d}:{time_result.new_time['minute']:02d} "
                        f"Day {time_result.new_time['day']}"
                    )

                return {"content": [{"type": "text", "text": response_text}]}

            except Exception as e:
                logger.error(f"persist_stat_changes error: {e}", exc_info=True)
                return {
                    "content": [{"type": "text", "text": f"Error applying changes: {e}"}],
                    "is_error": True,
                }

        tools.append(persist_stat_changes_tool)

    return tools
