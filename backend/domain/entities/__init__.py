"""
Domain entities - core data models for business logic.
"""

from .agent import (
    Agent,
    find_trpg_agents,
    get_present_characters,
    is_action_manager,
    is_character_designer,
    is_chat_summarizer,
    is_location_designer,
    is_onboarding_manager,
    is_stat_calculator,
    is_system_agent,
    is_world_seed_generator,
)
from .agent_config import AgentConfigData
from .gameplay_models import (
    ActionContext,
    CharacterDesign,
    CharacterRemoval,
    ChatSummary,
    InventoryChange,
    LocationDesign,
    LocationSummary,
    RemovalReason,
    StatCalcResult,
    StatChange,
)

# Note: Onboarding models (StatDefinition, StatSystem, InventoryItem, WorldSeed, etc.)
# have been moved to sdk.config.onboarding_inputs
# Import directly from there to avoid circular imports
from .world_models import (
    LocationConfig,
    PlayerState,
    RoomMapping,
    TransientState,
    WorldConfig,
)
from .world_models import (
    StatDefinition as WorldStatDefinition,
)

__all__ = [
    # agent.py
    "Agent",
    "is_world_seed_generator",
    "is_action_manager",
    "is_system_agent",
    "get_present_characters",
    "is_onboarding_manager",
    "is_character_designer",
    "is_chat_summarizer",
    "is_stat_calculator",
    "is_location_designer",
    "find_trpg_agents",
    # agent_config.py
    "AgentConfigData",
    # gameplay_models.py
    "StatChange",
    "InventoryChange",
    "StatCalcResult",
    "CharacterDesign",
    "LocationDesign",
    "RemovalReason",
    "CharacterRemoval",
    "ActionContext",
    "LocationSummary",
    "ChatSummary",
    # Note: Onboarding models moved to sdk.config.onboarding_inputs
    # world_models.py
    "WorldConfig",
    "PlayerState",
    "LocationConfig",
    "WorldStatDefinition",
    "RoomMapping",
    "TransientState",
]
