"""
Gameplay models for TRPG sub-agent structured outputs.

This module defines Pydantic models for structured outputs from sub-agents
invoked by the Action Manager during gameplay:
- StatCalcResult: Output from Stat Calculator
- CharacterDesign: Output from Character Designer
- LocationDesign: Output from Location Designer
- CharacterRemoval: Data for character removal
"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from domain.value_objects.enums import CharacterDisposition, InventoryChangeAction

# =============================================================================
# Stat Calculator Structured Output
# =============================================================================


class StatChange(BaseModel):
    """A single stat change from a game action."""

    stat_name: str = Field(..., description="Name of the stat being changed")
    old_value: int = Field(..., description="Value before the change")
    new_value: int = Field(..., description="Value after the change")
    delta: int = Field(..., description="Amount changed (positive or negative)")
    reason: str = Field(..., description="Brief explanation for the change")


class InventoryChange(BaseModel):
    """An inventory modification from a game action."""

    action: InventoryChangeAction = Field(..., description="Type of change: 'add' or 'remove'")
    item_id: str = Field(..., description="Unique identifier for the item")
    name: str = Field(..., description="Display name of the item")
    quantity: int = Field(1, description="Number of items affected")
    description: Optional[str] = Field(None, description="Item description for new items")
    properties: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Additional item properties")


class StatCalcResult(BaseModel):
    """
    Complete result from Stat Calculator sub-agent.

    Contains all mechanical game state changes resulting from a player action.
    """

    stat_changes: List[StatChange] = Field(default_factory=list, description="List of stat modifications")
    inventory_changes: List[InventoryChange] = Field(
        default_factory=list, description="List of inventory modifications"
    )
    summary: str = Field(..., description="Brief natural language summary of all changes")


# =============================================================================
# Character Designer Structured Output
# =============================================================================


class CharacterDesign(BaseModel):
    """
    Character design from Character Designer sub-agent.

    Complete specification for a new character to be created in the world.
    """

    name: str = Field(..., description="Character's name (e.g., 'Elder Marcus')")
    role: str = Field(..., description="Functional role (e.g., 'shopkeeper', 'guard', 'quest_giver')")
    appearance: str = Field(..., description="Physical description (3-6 sentences, in detail)")
    personality: str = Field(..., description="Key personality traits and behavior patterns")
    which_location: str = Field(
        "current",
        description="Where to place character: 'current' (add to current chatroom immediately) or location name (add to that location's room)",
    )
    location_name: Optional[str] = Field(None, description="DEPRECATED: Use which_location instead")
    secret: Optional[str] = Field(None, description="Hidden detail or motivation (for narrative depth)")
    initial_disposition: Optional[CharacterDisposition] = Field(
        CharacterDisposition.NEUTRAL, description="Initial attitude toward player (friendly/neutral/wary/hostile)"
    )


# =============================================================================
# Location Designer Structured Output
# =============================================================================


class LocationDesign(BaseModel):
    """
    Location design from Location Designer sub-agent.

    Complete specification for a new location to be added to the world.
    """

    name: str = Field(..., description="Location slug identifier (e.g., 'dark_forest')")
    display_name: str = Field(..., description="Human-readable name (e.g., 'The Dark Forest')")
    description: str = Field(..., description="Rich description of the location (2-3 paragraphs)")
    position_x: int = Field(0, description="X coordinate on world map")
    position_y: int = Field(0, description="Y coordinate on world map")
    adjacent_hints: List[str] = Field(default_factory=list, description="Names of locations this connects to")
    atmosphere: Optional[str] = Field(None, description="Overall mood/atmosphere (e.g., 'mysterious', 'welcoming')")
    notable_features: Optional[List[str]] = Field(
        default_factory=list, description="Key features players might interact with"
    )


# =============================================================================
# Character Removal Models
# =============================================================================


class RemovalReason(str, Enum):
    """Reason for removing a character from the game."""

    DEATH = "death"
    DISAPPEARANCE = "실종"
    MAGIC = "magic"


class CharacterRemoval(BaseModel):
    """
    Data for removing a character from the game.

    Used when Action Manager needs to remove a character due to
    death, disappearance (실종), or magic.
    """

    character_name: str = Field(..., description="Name of the character being removed")
    reason: RemovalReason = Field(..., description="Why the character is being removed")
    narrative: Optional[str] = Field(None, description="Brief narrative explanation for the removal")


# =============================================================================
# Action Manager Context (passed to sub-agents)
# =============================================================================


class ActionContext(BaseModel):
    """
    Context passed to sub-agents during gameplay turn.

    Contains all information sub-agents need to make decisions.
    """

    player_action: str = Field(..., description="The action the player is taking")
    current_location: str = Field(..., description="Current location name")
    current_stats: Dict[str, int] = Field(default_factory=dict, description="Current player stats")
    current_inventory: List[Dict[str, Any]] = Field(default_factory=list, description="Current inventory items")
    recent_events: Optional[str] = Field(None, description="Recent narrative events for context")
    world_genre: Optional[str] = Field(None, description="World genre")
    world_theme: Optional[str] = Field(None, description="World theme")


# =============================================================================
# Summarizer Structured Output
# =============================================================================


class LocationSummary(BaseModel):
    """
    Summary of events at a location, created by Summarizer agent.

    Used when player leaves a location to capture what happened for future reference.
    """

    summary: str = Field(
        ...,
        description="2-4 sentence summary of what happened at this location",
        min_length=10,
        max_length=500,
    )
    key_characters: List[str] = Field(
        default_factory=list,
        description="Names of characters the player interacted with",
    )
    key_outcomes: List[str] = Field(
        default_factory=list,
        description="Important outcomes (items gained, secrets learned, etc.)",
    )


# =============================================================================
# Chat Mode Summarizer Structured Output
# =============================================================================


class ChatSummary(BaseModel):
    """
    Summary of a chat mode conversation, created by Summarizer agent.

    Used when player exits chat mode (/end) to summarize what happened
    for gameplay continuation via Action Manager -> Narrator.
    """

    summary: str = Field(
        ...,
        description="2-4 sentence summary of the conversation focusing on key interactions and outcomes",
        min_length=10,
        max_length=500,
    )
    participants: List[str] = Field(
        default_factory=list,
        description="Names of NPCs involved in the conversation",
    )
    topics_discussed: List[str] = Field(
        default_factory=list,
        description="Key topics or subjects discussed during the chat",
    )
    notable_outcomes: List[str] = Field(
        default_factory=list,
        description="Important outcomes (information learned, relationships changed, promises made, etc.)",
    )
