"""
Domain enums for type-safe constants.
"""

from enum import Enum


class ParticipantType(str, Enum):
    """Type of participant in a chat message."""

    USER = "user"
    CHARACTER = "character"
    SYSTEM = "system"
    AGENT = "agent"  # For backwards compatibility with evaluation scripts

    def __str__(self) -> str:
        return self.value


class AgentGroup(str, Enum):
    """Agent group classifications."""

    GAMEPLAY = "gameplay"
    ONBOARDING = "onboarding"

    def __str__(self) -> str:
        return self.value


class WorldPhase(str, Enum):
    """World game phases."""

    ONBOARDING = "onboarding"  # Interview and world seed generation
    ACTIVE = "active"  # Active gameplay
    ENDED = "ended"  # Game concluded

    def __str__(self) -> str:
        return self.value


class UserRole(str, Enum):
    """User authentication roles."""

    ADMIN = "admin"  # Full access to all features
    GUEST = "guest"  # Read-only access, can chat but not modify

    def __str__(self) -> str:
        return self.value


class Language(str, Enum):
    """Supported UI/message languages."""

    ENGLISH = "en"  # English
    KOREAN = "ko"  # Korean
    JAPANESE = "jp"  # Japanese

    def __str__(self) -> str:
        return self.value


class MessageRole(str, Enum):
    """Message role in chat conversations."""

    USER = "user"  # Human user message
    ASSISTANT = "assistant"  # AI assistant/agent response

    def __str__(self) -> str:
        return self.value


class CharacterDisposition(str, Enum):
    """Character attitude toward player."""

    FRIENDLY = "friendly"  # Helpful and welcoming
    NEUTRAL = "neutral"  # Indifferent or reserved
    WARY = "wary"  # Cautious or suspicious
    HOSTILE = "hostile"  # Antagonistic or aggressive

    def __str__(self) -> str:
        return self.value


class InventoryChangeAction(str, Enum):
    """Inventory operation type."""

    ADD = "add"  # Add item to inventory
    REMOVE = "remove"  # Remove item from inventory

    def __str__(self) -> str:
        return self.value


# Agent name patterns for specialized agent types (case-insensitive matching)
ACTION_MANAGER_PATTERNS = frozenset(["action_manager", "actionmanager", "action manager"])
ONBOARDING_MANAGER_PATTERNS = frozenset(["onboarding_manager", "onboardingmanager", "onboarding manager"])

# Sub-agent patterns (invoked via tools during gameplay, not used in tape generation)
CHARACTER_DESIGNER_PATTERNS = frozenset(["character_designer", "characterdesigner", "character designer"])
ITEM_DESIGNER_PATTERNS = frozenset(["item_designer", "itemdesigner", "item designer"])
LOCATION_DESIGNER_PATTERNS = frozenset(["location_designer", "locationdesigner", "location designer"])
CHAT_SUMMARIZER_PATTERNS = frozenset(["chat_summarizer", "chatsummarizer", "chat summarizer"])

# System agent groups that should be excluded from "present characters" list
SYSTEM_AGENT_GROUPS = frozenset([AgentGroup.GAMEPLAY, AgentGroup.ONBOARDING])
