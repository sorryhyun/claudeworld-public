"""
Agent domain model.

This module defines the Agent domain model used throughout the application.
It's separate from the SQLAlchemy model (models.Agent) to maintain clean architecture.
"""

from dataclasses import dataclass
from typing import Optional

from domain.value_objects.enums import (
    ACTION_MANAGER_PATTERNS,
    CHARACTER_DESIGNER_PATTERNS,
    CHAT_SUMMARIZER_PATTERNS,
    LOCATION_DESIGNER_PATTERNS,
    ONBOARDING_MANAGER_PATTERNS,
    STAT_CALCULATOR_PATTERNS,
    SYSTEM_AGENT_GROUPS,
    WORLD_SEED_GENERATOR_PATTERNS,
)


@dataclass
class Agent:
    """
    Domain model for an agent.

    This is the core representation of an agent used in business logic,
    decoupled from the database schema.

    Attributes:
        id: Unique identifier
        name: Agent's display name
        group: Optional group name (e.g., "group_gameplay")
        system_prompt: The agent's system prompt
    """

    id: int
    name: str
    group: Optional[str]
    system_prompt: str

    @classmethod
    def from_db_model(cls, db_agent) -> "Agent":
        """
        Create a domain Agent from a database model.

        Args:
            db_agent: SQLAlchemy Agent model instance

        Returns:
            Domain Agent instance
        """
        return cls(
            id=db_agent.id,
            name=db_agent.name,
            group=db_agent.group,
            system_prompt=db_agent.system_prompt,
        )


# Agent type detection utilities
def is_world_seed_generator(agent_name: str) -> bool:
    """Check if agent is World Seed Generator (for structured output)."""
    agent_name_lower = agent_name.lower().replace(" ", "_")
    return any(pattern in agent_name_lower for pattern in WORLD_SEED_GENERATOR_PATTERNS)


def is_action_manager(agent_name: str) -> bool:
    """Check if agent is Action Manager (for gameplay context)."""
    agent_name_lower = agent_name.lower().replace(" ", "_")
    return any(pattern in agent_name_lower for pattern in ACTION_MANAGER_PATTERNS)


def is_system_agent(agent: Agent) -> bool:
    """
    Check if agent is a system agent (should be excluded from present characters).

    Args:
        agent: Agent object with name and group attributes

    Returns:
        True if agent is a system agent, False otherwise
    """
    # Check by group
    if agent.group and agent.group in SYSTEM_AGENT_GROUPS:
        return True
    # Also check by name patterns (fallback)
    return is_action_manager(agent.name)


def get_present_characters(room) -> list[str]:
    """
    Get names of character agents present in the room (excluding system agents).

    Args:
        room: Room object with agents list

    Returns:
        List of character agent names
    """
    if not room or not room.agents:
        return []
    return [a.name for a in room.agents if not is_system_agent(a)]


# TRPG-specific agent detection
def is_onboarding_manager(agent_name: str) -> bool:
    """Check if agent is Onboarding Manager (for TRPG onboarding)."""
    agent_name_lower = agent_name.lower().replace(" ", "_")
    return any(pattern in agent_name_lower for pattern in ONBOARDING_MANAGER_PATTERNS)


def is_character_designer(agent_name: str) -> bool:
    """Check if agent is Character Designer (TRPG sub-agent)."""
    agent_name_lower = agent_name.lower().replace(" ", "_")
    return any(pattern in agent_name_lower for pattern in CHARACTER_DESIGNER_PATTERNS)


def is_stat_calculator(agent_name: str) -> bool:
    """Check if agent is Stat Calculator (TRPG sub-agent)."""
    agent_name_lower = agent_name.lower().replace(" ", "_")
    return any(pattern in agent_name_lower for pattern in STAT_CALCULATOR_PATTERNS)


def is_location_designer(agent_name: str) -> bool:
    """Check if agent is Location Designer (TRPG sub-agent)."""
    agent_name_lower = agent_name.lower().replace(" ", "_")
    return any(pattern in agent_name_lower for pattern in LOCATION_DESIGNER_PATTERNS)


def is_chat_summarizer(agent_name: str) -> bool:
    """Check if agent is Chat Summarizer (invoked on chat mode exit)."""
    agent_name_lower = agent_name.lower().replace(" ", "_")
    return any(pattern in agent_name_lower for pattern in CHAT_SUMMARIZER_PATTERNS)


def find_trpg_agents(agents: list) -> dict:
    """
    Find TRPG agents from a list of agents by role.

    Identifies agents by name patterns for all TRPG roles:
    - Onboarding Manager, World Seed Generator
    - Action Manager (handles narration via narration tool)
    - Character Designer, Stat Calculator, Location Designer (sub-agents)

    Args:
        agents: List of Agent objects

    Returns:
        Dict mapping role names to agent IDs
        Example: {"onboarding_manager": 1, "action_manager": 2, ...}
    """
    agent_map = {}

    for agent in agents:
        agent_name = agent.name

        # Check each TRPG role
        if is_onboarding_manager(agent_name):
            agent_map["onboarding_manager"] = agent.id
        elif is_world_seed_generator(agent_name):
            agent_map["world_seed_generator"] = agent.id
        elif is_action_manager(agent_name):
            agent_map["action_manager"] = agent.id
        elif is_character_designer(agent_name):
            agent_map["character_designer"] = agent.id
        elif is_stat_calculator(agent_name):
            agent_map["stat_calculator"] = agent.id
        elif is_location_designer(agent_name):
            agent_map["location_designer"] = agent.id
        elif is_chat_summarizer(agent_name):
            agent_map["chat_summarizer"] = agent.id

    return agent_map
