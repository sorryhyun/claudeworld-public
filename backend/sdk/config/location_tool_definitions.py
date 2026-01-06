"""
Location tool definitions.

Defines tools for travel, location management, and character movement.
Used by Action Manager for all location-related operations.
"""

import json

from pydantic import BaseModel, Field, field_validator

from .tool_definitions import ToolDefinition, ToolDict

# =============================================================================
# Travel Tool Inputs
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
        (e.g., '["유나-7"]' which Claude sometimes generates).
        """
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
# Tool Definitions
# =============================================================================


LOCATION_TOOLS: ToolDict = {
    "travel": ToolDefinition(
        name="mcp__action_manager__travel",
        description="""\
Move the player to an existing location. This is the most comprehensive tool -
it combines travel, narration, action suggestions, AND chat summary into a single call.

When you use this tool:
1. The chat summary is saved to world history (what happened at the current location)
2. The player is moved to the destination
3. Your narration is displayed to the player (like the 'narration' tool)
4. Your action suggestions appear as clickable buttons (like 'suggest_options')

Use Task tool with location_designer to create new locations before traveling there, and use advance_time tool before using this tool to reflect 'time taken for travel' if needed.""",
        input_model=TravelInput,
        response="{travel_result}",
        enabled=True,
    ),
    "move_character": ToolDefinition(
        name="mcp__action_manager__move_character",
        description="""\
Move an existing character to a different location.
Use this when an NPC needs to relocate (e.g., following the player, fleeing, returning home, or being summoned elsewhere).
The character must already exist in the game.""",
        input_model=MoveCharacterInput,
        response="{move_result}",
        enabled=True,
    ),
    "list_locations": ToolDefinition(
        name="mcp__action_manager__list_locations",
        description="""\
List all available locations in the current world.
Returns location names, display names, and brief descriptions.
Use this to see where characters can travel or be moved to.""",
        input_model=ListLocationsInput,
        response="{locations_list}",
        enabled=True,
    ),
    "list_characters": ToolDefinition(
        name="mcp__action_manager__list_characters",
        description="""\
List all characters in the current world or at a specific location.
Returns exact character names for use with other tools.
Use this before move_character or remove_character to get exact names.""",
        input_model=ListCharactersInput,
        response="{characters_list}",
        enabled=True,
    ),
}
