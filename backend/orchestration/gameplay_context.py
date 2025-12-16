"""
Gameplay context builder for TRPG mode.

This module provides context building for the Action Manager agent.
Action Manager handles both interpretation and narration via tools (1-agent system).

Each agent gets the platform system prompt separately via agent.system_prompt.
The gameplay context is appended to it.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

from i18n.korean import format_with_particles
from sdk.loaders import get_conversation_context_config
from services.agent_filesystem_service import AgentFilesystemService
from services.location_service import LocationService
from services.player_service import PlayerService
from services.world_service import WorldService

logger = logging.getLogger("GameplayContext")


@dataclass
class ActionManagerContext:
    """Context for Action Manager agent."""

    lore: str
    user_name: str  # Protagonist's display name
    location_name: str
    location_display_name: str
    location_description: str
    adjacent_locations: list[str]
    player_stats: dict[str, int]
    player_inventory: list[dict]
    # World history and characters
    world_history: str = ""  # Content from world-level history.md
    present_npcs: list[str] = field(default_factory=list)  # Character agents at this location (excludes system agents)
    # In-game time
    game_time: dict[str, int] = field(default_factory=lambda: {"hour": 8, "minute": 0, "day": 1})


class GameplayContextBuilder:
    """
    Builds context for the Action Manager agent (1-agent TRPG system).

    System prompt structure:
        [platform_system_prompt]
        [lore]
        [current location info]

    User message structure:
        Action Manager: player action

    Usage:
        builder = GameplayContextBuilder(world_name)

        # For Action Manager
        am_context = builder.build_action_manager_context()
        system_prompt_suffix = builder.build_action_manager_system_prompt(am_context)
        user_message = builder.build_action_manager_user_message(player_action, agent_name)
    """

    def __init__(self, world_name: str):
        """
        Initialize the context builder.

        Args:
            world_name: Name of the world to load context from
        """
        self.world_name = world_name
        self._lore: Optional[str] = None
        self._world_config = None
        self._player_state = None
        self._current_location = None

    def _ensure_loaded(self) -> None:
        """Lazily load world data."""
        if self._lore is None:
            self._lore = WorldService.load_lore(self.world_name) or ""
            self._world_config = WorldService.load_world_config(self.world_name)
            self._player_state = PlayerService.load_player_state(self.world_name)

            if self._player_state and self._player_state.current_location:
                self._current_location = LocationService.load_location(
                    self.world_name, self._player_state.current_location
                )

    def build_action_manager_context(
        self,
        present_npcs: Optional[list[str]] = None,
    ) -> ActionManagerContext:
        """
        Build context for Action Manager.

        Args:
            present_npcs: Optional list of NPC names. If not provided,
                         loads from world's agents folder.

        Returns:
            ActionManagerContext with lore and current location info
        """
        self._ensure_loaded()

        location_name = ""
        location_display_name = ""
        location_description = ""
        adjacent_locations = []

        if self._current_location:
            location_name = self._current_location.name
            location_display_name = self._current_location.display_name
            location_description = self._current_location.description
            adjacent_locations = self._current_location.adjacent

        # Load world-level history
        world_history = WorldService.load_history(self.world_name)

        player_stats = {}
        player_inventory = []
        game_time = {"hour": 8, "minute": 0, "day": 1}

        if self._player_state:
            player_stats = self._player_state.stats or {}
            player_inventory = self._player_state.inventory or []
            game_time = self._player_state.game_time or {"hour": 8, "minute": 0, "day": 1}

        # Get user_name from world config, with fallback
        user_name = ""
        if self._world_config and self._world_config.user_name:
            user_name = self._world_config.user_name
        elif self._world_config and self._world_config.language == "ko":
            user_name = "여행자"
        else:
            user_name = "The traveler"

        # Load NPCs from world's agents folder if not provided
        if present_npcs is None:
            # Get agent folder names and convert to display names
            agent_folders = AgentFilesystemService.list_world_agents(self.world_name)
            present_npcs = [name.replace("_", " ") for name in agent_folders]

        return ActionManagerContext(
            lore=self._lore or "",
            user_name=user_name,
            location_name=location_name,
            location_display_name=location_display_name,
            location_description=location_description,
            adjacent_locations=adjacent_locations,
            player_stats=player_stats,
            player_inventory=player_inventory,
            world_history=world_history,
            present_npcs=present_npcs,
            game_time=game_time,
        )

    def build_action_manager_system_prompt(self, context: ActionManagerContext) -> str:
        """
        Build system prompt suffix for Action Manager.

        Appended to the agent's base system prompt.

        Args:
            context: ActionManagerContext

        Returns:
            System prompt suffix with lore and location info
        """
        parts = []

        # Protagonist name and current time
        if context.user_name:
            parts.append(f"# Protagonist: {context.user_name}")
            parts.append("")

        # Current time
        hour = context.game_time.get("hour", 8)
        minute = context.game_time.get("minute", 0)
        day = context.game_time.get("day", 1)
        parts.append(f"# Current Time: {hour:02d}:{minute:02d}, Day {day}")
        parts.append("")

        # World lore
        if context.lore:
            parts.append("# World Lore")
            parts.append("")
            parts.append(context.lore.strip())
            parts.append("")

        # World history (events across all locations)
        if context.world_history:
            parts.append("# World History")
            parts.append("")
            parts.append(context.world_history.strip())
            parts.append("")

        # Current location
        parts.append("# Current Location")
        parts.append("")
        parts.append(f"**{context.location_display_name or 'Unknown'}**")
        if context.location_description:
            parts.append("")
            parts.append(context.location_description.strip())
        if context.adjacent_locations:
            parts.append("")
            parts.append(f"Adjacent locations: {', '.join(context.adjacent_locations)}")
        parts.append("")

        # Characters present at location
        if context.present_npcs:
            parts.append("# Characters Present in the world")
            parts.append("")
            for npc_name in context.present_npcs:
                parts.append(f"- {npc_name}")
            parts.append("")
        # Player state
        if context.player_stats or context.player_inventory:
            parts.append("# Player State")
            parts.append("")
            if context.player_stats:
                for stat_name, stat_value in context.player_stats.items():
                    parts.append(f"- {stat_name}: {stat_value}")
            if context.player_inventory:
                parts.append("")
                parts.append("**Inventory:**")
                for item in context.player_inventory:
                    item_name = item.get("name", "Unknown")
                    item_desc = item.get("description", "")
                    if item_desc:
                        parts.append(f"- {item_name}: {item_desc}")
                    else:
                        parts.append(f"- {item_name}")
            parts.append("")

        return "\n".join(parts)

    def build_action_manager_user_message(self, player_action: str, agent_name: Optional[str] = None) -> str:
        """
        Build user message for Action Manager.

        Args:
            player_action: The player's action text
            agent_name: Optional agent name for response instruction formatting

        Returns:
            User message with response instruction prefix, current location, and player action
        """
        self._ensure_loaded()

        location_name = "Unknown"
        if self._current_location:
            location_name = self._current_location.name

        # Check for arrival context (one-time use after travel)
        arrival_context = LocationService.load_and_clear_arrival_context(self.world_name)

        # Build the base message
        parts = []

        # Add arrival context if present (for continuity after travel)
        if arrival_context:
            parts.append("[Arrival Context - for continuity from previous location]")
            parts.append(f"Player's triggering action: {arrival_context.get('triggering_action', '')}")
            parts.append(f"From location: {arrival_context.get('from_location', '')}")
            parts.append("Arrival narration shown to player:")
            parts.append(f'"{arrival_context.get("previous_narration", "")}"')
            parts.append("Note: Check if essential NPCs should be present at this location.")
            parts.append("[End of arrival context]")
            parts.append("")

        parts.append(f"[Current location: {location_name}]")
        parts.append("")
        parts.append(player_action)

        base_message = "\n".join(parts)

        # Load response instruction from conversation context config
        context_config = get_conversation_context_config()
        config = context_config.get("conversation_context", {})

        # Determine language from world config
        is_korean = self._world_config and self._world_config.language == "ko"
        instruction_key = "response_instruction_game_ko" if is_korean else "response_instruction_game_en"
        instruction = config.get(instruction_key, "")

        # Format and prefix the response instruction
        if instruction and agent_name:
            formatted_instruction = format_with_particles(instruction.strip(), agent_name=agent_name)
            return f"{base_message}\n{formatted_instruction}"

        return base_message


def get_gameplay_context_builder(world_name: str) -> GameplayContextBuilder:
    """
    Factory function to create a GameplayContextBuilder.

    Args:
        world_name: Name of the world

    Returns:
        GameplayContextBuilder instance
    """
    return GameplayContextBuilder(world_name)
