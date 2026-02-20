"""
Shared utilities for gameplay tools.

Contains common helpers used across character, location, and mechanics tools.
"""

from domain.entities.gameplay_models import ActionContext
from services.player_service import PlayerService
from services.world_service import WorldService


def build_action_context(world_name: str, player_action: str) -> ActionContext:
    """
    Build ActionContext from current game state.

    Args:
        world_name: Name of the world for loading state
        player_action: The player's action to process

    Returns:
        ActionContext with current game state populated
    """
    state = PlayerService.load_player_state(world_name)
    config = WorldService.load_world_config(world_name)

    return ActionContext(
        player_action=player_action,
        current_location=state.current_location if state and state.current_location else "unknown",
        current_stats=state.stats if state else {},
        current_inventory=state.inventory if state else [],
        world_genre=config.genre if config else None,
        world_theme=config.theme if config else None,
    )
