"""
Domain layer for internal business logic data structures.

This package contains dataclasses used for clean parameter passing
between functions in the business logic layer.

Structure:
- entities/: Core data models (Agent, AgentConfig, WorldModels, etc.)
- value_objects/: Immutable types and enums (ParticipantType, contexts, etc.)
- services/: Pure domain logic (memory, access_control, localization, etc.)
"""

# Re-export from entities
from .entities import (
    Agent,
    AgentConfigData,
    find_trpg_agents,
    get_present_characters,
    is_action_manager,
    is_character_designer,
    is_chat_summarizer,
    is_item_designer,
    is_location_designer,
    is_onboarding_manager,
    is_system_agent,
)
from .entities.gameplay_models import (
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
from .entities.world_models import (
    LocationConfig,
    PlayerState,
    RoomMapping,
    TransientState,
    WorldConfig,
)

# Re-export from services
from .services import (
    AccessControl,
    Localization,
    MemoryEntry,
    PlayerStateSerializer,
)

# Re-export from value_objects
# Note: Input models (SkipInput, MemorizeInput, RecallInput) are in sdk.config.action_inputs
from .value_objects import (
    AgentResponseContext,
    ImageAttachment,
    MemorizeOutput,
    MessageContext,
    OrchestrationContext,
    ParsedCommand,
    ParticipantType,
    RecallOutput,
    SkipOutput,
    SlashCommandType,
    TaskIdentifier,
    ToolResponse,
    parse_slash_command,
)
from .value_objects.enums import (
    ACTION_MANAGER_PATTERNS,
    CHARACTER_DESIGNER_PATTERNS,
    CHAT_SUMMARIZER_PATTERNS,
    ITEM_DESIGNER_PATTERNS,
    LOCATION_DESIGNER_PATTERNS,
    ONBOARDING_MANAGER_PATTERNS,
    SYSTEM_AGENT_GROUPS,
    AgentGroup,
    CharacterDisposition,
    InventoryChangeAction,
    Language,
    MessageRole,
    UserRole,
    WorldPhase,
)

__all__ = [
    # Entities
    "Agent",
    "AgentConfigData",
    "is_action_manager",
    "is_system_agent",
    "get_present_characters",
    "is_onboarding_manager",
    "is_character_designer",
    "is_chat_summarizer",
    "is_item_designer",
    "is_location_designer",
    "find_trpg_agents",
    # World models
    "WorldConfig",
    "PlayerState",
    "LocationConfig",
    "RoomMapping",
    "TransientState",
    # Gameplay models
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
    # Value objects - action models (outputs only - inputs are in sdk.config.action_inputs)
    "SkipOutput",
    "MemorizeOutput",
    "RecallOutput",
    "ToolResponse",
    # Value objects - contexts
    "MessageContext",
    "OrchestrationContext",
    "ImageAttachment",
    "AgentResponseContext",
    # Value objects - enums
    "ParticipantType",
    "AgentGroup",
    "WorldPhase",
    "UserRole",
    "Language",
    "MessageRole",
    "CharacterDisposition",
    "InventoryChangeAction",
    "ACTION_MANAGER_PATTERNS",
    "ONBOARDING_MANAGER_PATTERNS",
    "CHARACTER_DESIGNER_PATTERNS",
    "CHAT_SUMMARIZER_PATTERNS",
    "ITEM_DESIGNER_PATTERNS",
    "LOCATION_DESIGNER_PATTERNS",
    "SYSTEM_AGENT_GROUPS",
    # Value objects - slash commands
    "SlashCommandType",
    "ParsedCommand",
    "parse_slash_command",
    # Value objects - task identifier
    "TaskIdentifier",
    # Services
    "MemoryEntry",
    "AccessControl",
    "Localization",
    "PlayerStateSerializer",
]
