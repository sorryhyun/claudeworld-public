"""
Gameplay tool definitions.

Defines core tools for TRPG gameplay (Action Manager).
Tools for items and locations are imported from their respective modules.
"""

import json

from pydantic import BaseModel, Field, field_validator

from .item import (
    ITEM_TOOLS,
    EquipItemInput,
    ListEquipmentInput,
    ListInventoryInput,
    ListWorldItemInput,
    UnequipItemInput,
    UseItemInput,
)
from .location import (
    LOCATION_TOOLS,
    ListCharactersInput,
    ListLocationsInput,
    MoveCharacterInput,
    TravelInput,
)
from .tool_definitions import ToolDefinition, ToolDict

# Re-export for backward compatibility
__all__ = [
    # Core gameplay
    "ACTION_MANAGER_TOOLS",
    "CORE_GAMEPLAY_TOOLS",
    "ToolDefinition",
    "ToolDict",
    # Character tools
    "RemoveCharacterInput",
    "DeleteCharacterInput",
    "InjectMemoryInput",
    # Narration tools
    "NarrationInput",
    "SuggestOptionsInput",
    "ChangeStatInput",
    "AdvanceTimeInput",
    "RollTheDiceInput",
    "SetFlagInput",
    "RecallHistoryInput",
    # Item tools (re-exported)
    "ITEM_TOOLS",
    "ListInventoryInput",
    "ListWorldItemInput",
    "EquipItemInput",
    "UnequipItemInput",
    "UseItemInput",
    "ListEquipmentInput",
    # Location tools (re-exported)
    "LOCATION_TOOLS",
    "TravelInput",
    "MoveCharacterInput",
    "ListLocationsInput",
    "ListCharactersInput",
]

# =============================================================================
# Character Tool Inputs
# =============================================================================


class RemoveCharacterInput(BaseModel):
    """Input for remove_character tool.

    Used for excluding a character from the current location (character still exists).
    """

    character_name: str = Field(
        ...,
        min_length=1,
        description="Name of character to remove from current location",
    )

    @field_validator("character_name", mode="before")
    @classmethod
    def validate_name(cls, v: str | None) -> str:
        """Ensure character name is provided and stripped."""
        if v is None:
            raise ValueError("Character name is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Character name cannot be empty")
        return v


class DeleteCharacterInput(BaseModel):
    """Input for delete_character tool.

    Used for permanently removing characters from the game (death, disappearance, or magic).
    """

    character_name: str = Field(
        ...,
        min_length=1,
        description="Name of character to delete",
    )
    reason: str = Field(
        default="death",
        description="Reason for deletion: 'death', '실종', or 'magic'",
    )
    narrative: str = Field(
        default="",
        description="Optional narrative description of the deletion",
    )

    @field_validator("character_name", mode="before")
    @classmethod
    def validate_name(cls, v: str | None) -> str:
        """Ensure character name is provided and stripped."""
        if v is None:
            raise ValueError("Character name is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Character name cannot be empty")
        return v

    @field_validator("reason", mode="before")
    @classmethod
    def normalize_reason(cls, v: str | None) -> str:
        """Normalize reason to lowercase."""
        if v is None:
            return "death"
        return str(v).strip().lower() or "death"


# =============================================================================
# Mechanics Tool Inputs
# =============================================================================


class InjectMemoryInput(BaseModel):
    """Input for inject_memory tool.

    Used for injecting memories into specific characters' recent_events.
    Useful for supernatural effects like hypnosis, mind control, or illusions.
    """

    character_name: str = Field(
        ...,
        min_length=1,
        description="Name of the character to inject memory into",
    )
    memory_entry: str = Field(
        ...,
        min_length=1,
        description="The memory to inject (one-liner)",
    )

    @field_validator("character_name", mode="before")
    @classmethod
    def validate_name(cls, v: str | None) -> str:
        """Ensure character name is provided and stripped."""
        if v is None:
            raise ValueError("Character name is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Character name cannot be empty")
        return v

    @field_validator("memory_entry", mode="before")
    @classmethod
    def validate_memory(cls, v: str | None) -> str:
        """Ensure memory entry is provided and stripped."""
        if v is None:
            raise ValueError("Memory entry is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Memory entry cannot be empty")
        return v


# =============================================================================
# Narration Tool Inputs
# =============================================================================


class NarrationInput(BaseModel):
    """Input for narration tool.

    Used by Action Manager to create visible narrative messages.
    Replaces the separate Narrator agent - Action Manager now handles
    both interpretation and narration.
    """

    narrative: str = Field(
        ...,
        min_length=1,
        description="The narrative text to display to the player. "
        "Should be vivid, engaging, and show the outcome of the action.",
    )

    @field_validator("narrative", mode="before")
    @classmethod
    def validate_narrative(cls, v: str | None) -> str:
        """Ensure narrative is provided and stripped."""
        if v is None:
            raise ValueError("Narrative is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Narrative cannot be empty")
        return v


class SuggestOptionsInput(BaseModel):
    """Input for suggest_options tool.

    Used by Action Manager to provide suggested actions as clickable buttons in the UI.
    Replaces the Narrator's suggest_actions tool.
    """

    action_1: str = Field(
        ...,
        min_length=1,
        description="First suggested action",
    )
    action_2: str = Field(
        ...,
        min_length=1,
        description="Second suggested action",
    )

    @field_validator("action_1", "action_2", mode="before")
    @classmethod
    def validate_action(cls, v: str | None) -> str:
        """Ensure actions are provided and stripped."""
        if v is None:
            raise ValueError("Action is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Action cannot be empty")
        return v


class ChangeStatInput(BaseModel):
    """Input for change_stat tool.

    Used by Stat Calculator sub-agent to apply calculated stat and
    inventory changes to player state.
    """

    summary: str = Field(..., min_length=1, description="Summary of changes")
    stat_changes: list[dict] = Field(
        default_factory=list,
        description="List of {stat_name, delta} objects",
    )
    inventory_changes: list[dict] = Field(
        default_factory=list,
        description="List of {action, item_id, name, quantity, description?, properties?} objects",
    )
    time_advance_minutes: int = Field(
        default=0,
        description="Minutes to advance (0 = no time change)",
    )

    @field_validator("summary", mode="before")
    @classmethod
    def validate_summary(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Summary is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Summary cannot be empty")
        return v

    @field_validator("stat_changes", mode="before")
    @classmethod
    def parse_stat_changes(cls, v: list | str | None) -> list[dict]:
        """Parse stat_changes, handling JSON string representations.

        Claude sometimes passes lists as JSON strings like '[]' or
        '[{"stat_name": "HP", "delta": -10}]'.
        """
        if v is None:
            return []
        if isinstance(v, str):
            v = v.strip()
            if not v or v == "[]":
                return []
            try:
                parsed = json.loads(v)
                if isinstance(parsed, list):
                    return parsed
                return []
            except json.JSONDecodeError:
                return []
        if isinstance(v, list):
            return v
        return []

    @field_validator("inventory_changes", mode="before")
    @classmethod
    def parse_inventory_changes(cls, v: list | str | None) -> list[dict]:
        """Parse inventory_changes, handling JSON string representations.

        Claude sometimes passes lists as JSON strings like '[]' or
        '[{"action": "add", "item_id": "sword", "name": "Sword"}]'.
        """
        if v is None:
            return []
        if isinstance(v, str):
            v = v.strip()
            if not v or v == "[]":
                return []
            try:
                parsed = json.loads(v)
                if isinstance(parsed, list):
                    return parsed
                return []
            except json.JSONDecodeError:
                return []
        if isinstance(v, list):
            return v
        return []


class AdvanceTimeInput(BaseModel):
    """Input for advance_time tool.

    Used for advancing in-game time during travel, rest, or time-consuming activities.
    """

    minutes: int = Field(
        ...,
        ge=1,
        description="Minutes to advance (minimum 1)",
    )
    reason: str = Field(
        ...,
        min_length=1,
        description="Brief explanation of why time passes",
    )

    @field_validator("reason", mode="before")
    @classmethod
    def validate_reason(cls, v: str | None) -> str:
        """Ensure reason is provided and stripped."""
        if v is None:
            raise ValueError("Reason is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Reason cannot be empty")
        return v


class RollTheDiceInput(BaseModel):
    """Input for roll_the_dice tool.

    Empty input model - no parameters required.
    """

    pass


class SetFlagInput(BaseModel):
    """Input for set_flag tool.

    Used for setting player flags for game state tracking.
    """

    flag: str = Field(
        ...,
        min_length=1,
        description="Name of the flag to set",
    )
    value: bool = Field(
        default=True,
        description="Value to set the flag to (default: True)",
    )

    @field_validator("flag", mode="before")
    @classmethod
    def validate_flag(cls, v: str | None) -> str:
        """Ensure flag is provided and stripped."""
        if v is None:
            raise ValueError("flag is required")
        v = str(v).strip()
        if not v:
            raise ValueError("flag cannot be empty")
        return v


class RecallHistoryInput(BaseModel):
    """Input for recall_history tool.

    Used for retrieving past events from consolidated world history.
    """

    subtitle: str = Field(
        ...,
        min_length=1,
        description="The subtitle of the history entry to recall",
    )

    @field_validator("subtitle", mode="before")
    @classmethod
    def validate_subtitle(cls, v: str | None) -> str:
        """Ensure subtitle is provided and stripped."""
        if v is None:
            raise ValueError("Subtitle is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Subtitle cannot be empty")
        return v


# =============================================================================
# Core Gameplay Tool Definitions
# =============================================================================


CORE_GAMEPLAY_TOOLS: ToolDict = {
    "remove_character": ToolDefinition(
        name="mcp__action_manager__remove_character",
        description="""\
Remove an NPC from the current location.
Use this when a character leaves, departs, or should no longer be at this location.
The character still exists in the world and can be encountered elsewhere.""",
        input_model=RemoveCharacterInput,
        response="{removal_result}",
        enabled=True,
    ),
    "delete_character": ToolDefinition(
        name="mcp__action_manager__delete_character",
        description="""\
Permanently delete an NPC from the game.
Use this when an NPC dies, 실종, or is removed by magic.
The character will be archived and no longer exist in the world.
Reasons: 'death', '실종', 'magic'""",
        input_model=DeleteCharacterInput,
        response="{deletion_result}",
        enabled=True,
    ),
    "inject_memory": ToolDefinition(
        name="mcp__action_manager__inject_memory",
        description="""\
Inject a memory into a specific character's recent_events.
Use this when external events should implant memories into NPCs, such as hypnosis, mind control, illusions, or similar supernatural effects.
The character will remember this as if it actually happened or regard as commonsense.""",
        input_model=InjectMemoryInput,
        response="{inject_memory_result}",
        enabled=True,
    ),
    "roll_the_dice": ToolDefinition(
        name="mcp__action_manager__roll_the_dice",
        description="""\
Roll the dice to determine a random outcome for uncertain events.
Use this when an action's success depends on chance or luck.

**Probability Distribution:**
- very_lucky (1%): Exceptional success, bonus rewards
- lucky (5%): Better than expected outcome
- nothing_happened (88%): Standard outcome, no bonus
- bad_luck (5%): Worse than expected outcome
- worst_day_of_game (1%): Critical failure, negative consequences

**Usage:**
Call this tool when the player attempts something risky or uncertain.
Use the result to inform how you narrate the outcome and what stat changes to apply via change_stat.

No parameters required - just call to get a random result.""",
        input_model=RollTheDiceInput,
        response="{roll_result}",
        enabled=True,
    ),
    "narration": ToolDefinition(
        name="mcp__action_manager__narration",
        description="""\
REQUIRED: Create a visible narrative message describing the outcome of the player's action.

This is the text the player will see in the chat. It should be:
- Vivid and engaging with sensory details
- Appropriate to the world's genre and tone
- Focused on the outcome of their action
- Natural continuation of the story

**Writing Guidelines:**
- Use present tense for immediacy
- Engage multiple senses (sight, sound, smell)
- Show NPC emotions through actions and dialogue
- Keep paragraphs focused and punchy
- End on a moment of tension or choice

**DO NOT:**
- Write the player's actions or feelings
- Use purple prose or overwrite
- Resolve situations too quickly

Call this AFTER resolving mechanics (stat changes via change_stat, travel, etc.) to describe what happened.""",
        input_model=NarrationInput,
        response="Narrative message created and displayed to player.",
        enabled=True,
    ),
    "suggest_options": ToolDefinition(
        name="mcp__action_manager__suggest_options",
        description="""\
REQUIRED: Provide two suggested actions for the player at the end of your turn.
These suggestions appear as clickable buttons in the UI.

Good suggestions:
- Are contextually relevant to the current situation
- Offer meaningful choices (not just "go left" / "go right")
- Can include dialogue options, actions, or exploration
- Should feel natural given what just happened""",
        input_model=SuggestOptionsInput,
        response="""\
**Suggested Actions:**
1. {action_1}
2. {action_2}""",
        enabled=True,
    ),
    "change_stat": ToolDefinition(
        name="mcp__action_manager__change_stat",
        description="""\
Apply stat and inventory changes to player state.
Used directly by Action Manager after determining mechanical effects.
Persists changes to filesystem and syncs to database.

**IMPORTANT: Item Handling**
- Items can ONLY be added if they already exist in the world's items/ directory.
- Use Task with item_designer to create new items BEFORE adding to inventory.
- If an item doesn't exist, it will be SKIPPED and reported in the response.
- Removing items always works (no template required).

**Note:** For time advancement, use `advance_time` tool separately.""",
        input_model=ChangeStatInput,
        response="{persist_result}",
        enabled=True,
    ),
    "advance_time": ToolDefinition(
        name="mcp__action_manager__advance_time",
        description="""\
Advance in-game time. Use this when actions take significant time:
- Travel between locations
- Resting, sleeping, waiting
- Long activities (crafting, studying, training)
- Passage of time during scenes

**Effects:**
- Updates world clock (hour, minute, day)
- May trigger time-based events (day/night cycle, NPC schedules)
- Returns new time state for narration""",
        input_model=AdvanceTimeInput,
        response="{time_result}",
        enabled=True,
    ),
    "set_flag": ToolDefinition(
        name="mcp__action_manager__set_flag",
        description="""\
Set a player flag for game state tracking.

Flags are boolean values used for:
- Item affordance requirements (e.g., 'in_conversation' flag)
- Story progression tracking (e.g., 'boss_defeated')
- Route unlocking (e.g., 'route_unlocked')
- World state (e.g., 'night_time', 'rainy')

Many item affordances require certain flags to be true/false.""",
        input_model=SetFlagInput,
        response="{flag_result}",
        enabled=True,
    ),
    "recall_history": ToolDefinition(
        name="mcp__action_manager__recall_history",
        description="""\
Retrieve a past event from the world's consolidated history by subtitle.
Use this to recall specific events that happened earlier in the game.

Available history entries: {history_subtitles}

**When to use:**
- When the player references past events
- When you need context about what happened before
- When continuity with earlier story beats matters""",
        input_model=RecallHistoryInput,
        response="{history_content}",
        enabled=True,
    ),
}


# =============================================================================
# Combined Action Manager Tools (exported for use by yaml_loaders.py)
# =============================================================================


ACTION_MANAGER_TOOLS: ToolDict = {
    **CORE_GAMEPLAY_TOOLS,
    **ITEM_TOOLS,
    **LOCATION_TOOLS,
}
