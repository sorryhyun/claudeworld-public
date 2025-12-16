"""
TRPG-specific tape generator for turn-based gameplay.

Unlike chat mode, TRPG mode has strict turn ordering (1-agent system):
1. Action Manager interprets the player's action, invokes sub-agents as needed,
   creates narrative via `narration` tool, and suggests options via `suggest_options` tool
   - Uses Task tool with stat_calculator to calculate stat/inventory changes
   - Uses Task tool with character_designer to create NPCs
   - Uses Task tool with location_designer to create locations
   - Uses remove_character for NPC removal
   - Uses narration tool to create visible message
   - Uses suggest_options tool to provide action suggestions

"""

import logging
from typing import List, Optional

from domain.entities.agent import find_trpg_agents

from .models import CellType, TurnCell, TurnTape

logger = logging.getLogger("TRPGTapeGenerator")


class TRPGTapeGenerator:
    """
    Generates turn tapes for TRPG gameplay.

    All cells are sequential (no concurrency) and follow a fixed order
    based on agent roles, not priority values.

    The 1-agent system has Action Manager handling both interpretation and narration
    via tools (narration, suggest_options).
    """

    def __init__(
        self,
        onboarding_manager_id: int,
        world_seed_generator_id: int,
        action_manager_id: int,
    ):
        """
        Initialize with system agent IDs.

        Args:
            onboarding_manager_id: Agent for onboarding interviews
            world_seed_generator_id: Agent for world creation
            action_manager_id: Agent for interpreting actions and narration
        """
        self.onboarding_manager_id = onboarding_manager_id
        self.world_seed_generator_id = world_seed_generator_id
        self.action_manager_id = action_manager_id

        logger.info(
            f"TRPGTapeGenerator initialized with 1-agent system: "
            f"OM={onboarding_manager_id}, WSG={world_seed_generator_id}, "
            f"AM={action_manager_id}"
        )

    def generate_onboarding_round(self, include_world_seed: bool = False) -> TurnTape:
        """
        Generate tape for onboarding phase.

        During onboarding, the Onboarding Manager conducts the interview.
        When onboarding is complete, World Seed Generator creates the world.

        Args:
            include_world_seed: If True, adds World Seed Generator after
                              Onboarding Manager (used for final onboarding turn)

        Returns:
            TurnTape with onboarding sequence
        """
        tape = TurnTape()

        # Onboarding Manager always responds during onboarding
        tape.cells.append(
            TurnCell(
                cell_type=CellType.SEQUENTIAL,
                agent_ids=[self.onboarding_manager_id],
            )
        )

        if include_world_seed:
            # World Seed Generator creates the world
            tape.cells.append(
                TurnCell(
                    cell_type=CellType.SEQUENTIAL,
                    agent_ids=[self.world_seed_generator_id],
                )
            )

            # Action Manager creates the initial scene using narration tool
            # Note: Initial NPCs can be created via Task tool with character_designer
            tape.cells.append(
                TurnCell(
                    cell_type=CellType.SEQUENTIAL,
                    agent_ids=[self.action_manager_id],
                    hidden=True,  # AM stays hidden, narration tool creates visible message
                )
            )

        logger.info(f"Generated onboarding tape (include_world_seed={include_world_seed}): {tape}")
        return tape

    def generate_action_round(self) -> TurnTape:
        """
        Generate tape for a player action during active gameplay.

        1-agent sequence:
        1. Action Manager - Interprets the action, invokes sub-agents as needed
           via Task tool (stat_calculator, character_designer, location_designer),
           creates narrative via narration tool, and suggests options.
           Hidden from frontend - visible message created via narration tool.

        Returns:
            TurnTape with action sequence
        """
        tape = TurnTape()

        # Action Manager handles everything: interpretation, narration, suggestions
        # Hidden from frontend - narration tool creates the visible message
        tape.cells.append(
            TurnCell(
                cell_type=CellType.SEQUENTIAL,
                agent_ids=[self.action_manager_id],
                hidden=True,  # AM stays hidden, narration tool creates visible message
            )
        )

        logger.info(f"Generated action tape (1-agent, AM hidden): {tape}")
        return tape

    def generate_travel_round(self) -> TurnTape:
        """
        Generate tape for a travel/location change action.

        1-agent sequence for movement:
        1. Action Manager - Handles travel, creates narrative, suggests options
           Hidden from frontend - visible message created via narration tool.

        Returns:
            TurnTape with travel sequence
        """
        tape = TurnTape()

        # Action Manager handles everything: travel logic, narration, suggestions
        # Hidden from frontend - narration tool creates the visible message
        tape.cells.append(
            TurnCell(
                cell_type=CellType.SEQUENTIAL,
                agent_ids=[self.action_manager_id],
                hidden=True,  # AM stays hidden, narration tool creates visible message
            )
        )

        logger.info(f"Generated travel tape (1-agent, AM hidden): {tape}")
        return tape

    def generate_simple_round(self, agent_ids: List[int]) -> TurnTape:
        """
        Generate a simple tape with the specified agents in order.

        Args:
            agent_ids: List of agent IDs to execute in order

        Returns:
            TurnTape with sequential cells for each agent
        """
        tape = TurnTape()

        for agent_id in agent_ids:
            tape.cells.append(
                TurnCell(
                    cell_type=CellType.SEQUENTIAL,
                    agent_ids=[agent_id],
                )
            )

        logger.info(f"Generated simple tape with agents: {agent_ids}")
        return tape


# find_trpg_agents is now imported from domain.agent


def create_trpg_generator_from_room(
    agents: list,
) -> Optional[TRPGTapeGenerator]:
    """
    Create a TRPGTapeGenerator from a list of agents in a room.

    Args:
        agents: List of Agent objects in the room

    Returns:
        TRPGTapeGenerator if all required agents found, else None
    """
    agent_map = find_trpg_agents(agents)

    # Check if all required agents are present (1-agent system)
    # Note: narrator is no longer required - Action Manager handles narration
    # character_designer, stat_calculator, location_designer are sub-agents invoked via tools
    required = [
        "onboarding_manager",
        "world_seed_generator",
        "action_manager",
    ]

    missing = [r for r in required if r not in agent_map]
    if missing:
        logger.warning(f"Missing required TRPG agents: {missing}")
        return None

    return TRPGTapeGenerator(
        onboarding_manager_id=agent_map["onboarding_manager"],
        world_seed_generator_id=agent_map["world_seed_generator"],
        action_manager_id=agent_map["action_manager"],
    )


def has_onboarding_agents(agents: list) -> bool:
    """Check if the agent list contains onboarding agents."""
    agent_map = find_trpg_agents(agents)
    return "onboarding_manager" in agent_map


def has_gameplay_agents(agents: list) -> bool:
    """Check if the agent list contains gameplay agents (1-agent system)."""
    agent_map = find_trpg_agents(agents)
    # Only action_manager is required in the tape (it handles narration via tools)
    # Sub-agents (character_designer, stat_calculator, location_designer) are invoked via tools
    return "action_manager" in agent_map


def create_onboarding_tape(agents: list) -> Optional[TurnTape]:
    """
    Create an onboarding tape for rooms with onboarding agents.

    Returns:
        TurnTape with onboarding sequence, or None if no onboarding agents
    """
    agent_map = find_trpg_agents(agents)

    if "onboarding_manager" not in agent_map:
        return None

    tape = TurnTape()
    tape.cells.append(
        TurnCell(
            cell_type=CellType.SEQUENTIAL,
            agent_ids=[agent_map["onboarding_manager"]],
        )
    )

    logger.info(f"Created onboarding tape for agent {agent_map['onboarding_manager']}")
    return tape


def create_gameplay_tape(agents: list) -> Optional[TurnTape]:
    """
    Create a gameplay tape for rooms with gameplay agents (1-agent system).

    Action Manager is hidden from frontend - visible messages are created via
    the narration tool during execution.

    Returns:
        TurnTape with gameplay sequence, or None if missing gameplay agents
    """
    agent_map = find_trpg_agents(agents)

    # Only action_manager is required in the tape
    # It handles narration via the narration tool
    if "action_manager" not in agent_map:
        logger.warning("Missing gameplay agent: action_manager")
        return None

    tape = TurnTape()

    # Action Manager - hidden, creates visible messages via narration tool
    tape.cells.append(
        TurnCell(
            cell_type=CellType.SEQUENTIAL,
            agent_ids=[agent_map["action_manager"]],
            hidden=True,  # AM stays hidden, narration tool creates visible message
        )
    )

    logger.info("Created gameplay tape with 1-agent system (AM hidden)")
    return tape


def create_trpg_generator_from_agent_ids(
    onboarding_manager_id: int,
    world_seed_generator_id: int,
    action_manager_id: int,
) -> TRPGTapeGenerator:
    """
    Create a TRPGTapeGenerator from explicit agent IDs.

    Args:
        onboarding_manager_id: Agent ID for onboarding manager
        world_seed_generator_id: Agent ID for world seed generator
        action_manager_id: Agent ID for action manager and narration

    Returns:
        TRPGTapeGenerator instance
    """
    return TRPGTapeGenerator(
        onboarding_manager_id=onboarding_manager_id,
        world_seed_generator_id=world_seed_generator_id,
        action_manager_id=action_manager_id,
    )
