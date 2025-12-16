"""
Tape-based turn scheduling system.

This module provides a pre-computed scheduling approach for multi-agent conversations,
replacing dynamic turn decisions with a predictable "tape" of turns.

Example usage:
    from orchestration.tape import TapeGenerator, TapeExecutor, TurnTape

    # Create generator with agents
    generator = TapeGenerator(agents, interrupt_agents)

    # Generate tape for initial round
    tape = generator.generate_initial_round()

    # Execute tape
    executor = TapeExecutor(response_generator, agents_by_id)
    result = await executor.execute(tape, context)
"""

from .executor import TapeExecutor
from .generator import TapeGenerator
from .models import CellType, ExecutionResult, TurnCell, TurnTape
from .trpg_generator import (
    TRPGTapeGenerator,
    create_trpg_generator_from_agent_ids,
    create_trpg_generator_from_room,
)

__all__ = [
    "TapeGenerator",
    "TapeExecutor",
    "TurnTape",
    "TurnCell",
    "CellType",
    "ExecutionResult",
    # TRPG
    "TRPGTapeGenerator",
    "create_trpg_generator_from_room",
    "create_trpg_generator_from_agent_ids",
]
