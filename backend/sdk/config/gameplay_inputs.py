"""
Input models for gameplay tools.

This module defines Pydantic models for validating gameplay tool inputs.
These models provide type-safe validation and consistent error messages.

Note: These models are for internal validation only. YAML configurations
remain the source of truth for tool schemas shown to Claude.
"""

from pydantic import BaseModel, Field, field_validator

# =============================================================================
# Character Tool Inputs
# =============================================================================


class RemoveCharacterInput(BaseModel):
    """Input for remove_character tool.

    Used for removing characters from the game (death, disappearance, or magic).
    """

    character_name: str = Field(
        ...,
        min_length=1,
        description="Name of character to remove",
    )
    reason: str = Field(
        default="death",
        description="Reason for removal: 'death', '실종', or 'magic'",
    )
    narrative: str = Field(
        default="",
        description="Optional narrative description of the removal",
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
# Location Tool Inputs
# =============================================================================


class TravelInput(BaseModel):
    """Input for travel tool.

    Used for moving the player to an existing location.
    Use Task tool with location_designer to create new locations first.
    Travel now directly creates narration, action suggestions, and chat summary.
    """

    destination: str = Field(
        ...,
        min_length=1,
        description="Location to travel to (must already exist)",
    )
    bring_characters: list[str] = Field(
        default_factory=list,
        description="List of character names to bring along",
    )
    narration: str = Field(
        ...,
        min_length=1,
        description="REQUIRED: The narrative text describing the travel and arrival. "
        "This will be displayed to the player. Make it vivid and engaging, "
        "describing the journey and what the player sees upon arrival.",
    )
    action_1: str = Field(
        ...,
        min_length=1,
        description="REQUIRED: First suggested action for the player at the new location.",
    )
    action_2: str = Field(
        ...,
        min_length=1,
        description="REQUIRED: Second suggested action for the player at the new location.",
    )
    chat_summary: str = Field(
        ...,
        min_length=1,
        description="REQUIRED: A 2-4 sentence summary of what happened at the current location "
        "before leaving. This will be saved to the world's history. Focus on key events, "
        "decisions, and outcomes.",
    )
    user_action: str = Field(
        ...,
        min_length=1,
        description="REQUIRED: The player's original action that triggered this travel "
        "(e.g., 'Go to the tavern'). This provides continuity for the next scene.",
    )

    @field_validator("destination", mode="before")
    @classmethod
    def validate_destination(cls, v: str | None) -> str:
        """Ensure destination is provided and stripped."""
        if v is None:
            raise ValueError("Destination is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Destination cannot be empty")
        return v

    @field_validator("bring_characters", mode="before")
    @classmethod
    def normalize_characters(cls, v: list | str | None) -> list[str]:
        """Ensure bring_characters is a list and strip names.

        Handles both actual lists and JSON string representations of lists
        (e.g., '[\"유나-7\"]' which Claude sometimes generates).
        """
        import json

        if v is None:
            return []
        # Handle JSON string representation of list
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                try:
                    v = json.loads(v)
                except json.JSONDecodeError:
                    return []
            else:
                # Single name as string
                return [v] if v else []
        if not isinstance(v, list):
            return []
        return [str(name).strip() for name in v if name]

    @field_validator("narration", mode="before")
    @classmethod
    def validate_narration(cls, v: str | None) -> str:
        """Ensure narration is provided and stripped."""
        if v is None:
            raise ValueError("Narration is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Narration cannot be empty")
        return v

    @field_validator("action_1", "action_2", mode="before")
    @classmethod
    def validate_actions(cls, v: str | None) -> str:
        """Ensure actions are provided and stripped."""
        if v is None:
            raise ValueError("Action is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Action cannot be empty")
        return v

    @field_validator("chat_summary", mode="before")
    @classmethod
    def validate_chat_summary(cls, v: str | None) -> str:
        """Ensure chat summary is provided and stripped."""
        if v is None:
            raise ValueError("Chat summary is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Chat summary cannot be empty")
        return v

    @field_validator("user_action", mode="before")
    @classmethod
    def validate_user_action(cls, v: str | None) -> str:
        """Ensure user action is provided and stripped."""
        if v is None:
            raise ValueError("User action is required")
        v = str(v).strip()
        if not v:
            raise ValueError("User action cannot be empty")
        return v


class MoveCharacterInput(BaseModel):
    """Input for move_character tool.

    Used for moving an existing character to a different location.
    """

    character_name: str = Field(
        ...,
        min_length=1,
        description="Name of the character to move",
    )
    destination: str = Field(
        ...,
        min_length=1,
        description="Location to move the character to",
    )
    narrative: str = Field(
        default="",
        description="Optional narrative description of the movement",
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

    @field_validator("destination", mode="before")
    @classmethod
    def validate_destination(cls, v: str | None) -> str:
        """Ensure destination is provided and stripped."""
        if v is None:
            raise ValueError("Destination is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Destination cannot be empty")
        return v

    @field_validator("narrative", mode="before")
    @classmethod
    def strip_narrative(cls, v: str | None) -> str:
        """Strip whitespace and handle None values."""
        if v is None:
            return ""
        return str(v).strip()


class ListLocationsInput(BaseModel):
    """Input for list_locations tool.

    Used for listing all available locations in the world.
    This tool takes no required inputs.
    """

    pass


class ListCharactersInput(BaseModel):
    """Input for list_characters tool.

    Used for listing all characters in the world or at a specific location.
    """

    location: str = Field(
        default="",
        description="Optional location name to filter characters (empty = all characters in world)",
    )

    @field_validator("location", mode="before")
    @classmethod
    def strip_location(cls, v: str | None) -> str:
        """Strip whitespace and handle None values."""
        if v is None:
            return ""
        return str(v).strip()


# =============================================================================
# Finalization Tool Inputs
# =============================================================================


# =============================================================================
# Narration Tool Inputs (Action Manager creates visible messages)
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
        import json

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
        import json

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


class ListWorldItemInput(BaseModel):
    """Input for list_world_item tool.

    Used for listing all item templates in the world or filtering by keyword.
    """

    keyword: str = Field(
        default="",
        description="Optional keyword to filter items by name or description. "
        "Leave empty to list all items.",
    )

    @field_validator("keyword", mode="before")
    @classmethod
    def strip_keyword(cls, v: str | None) -> str:
        """Strip whitespace and handle None values."""
        if v is None:
            return ""
        return str(v).strip().lower()
