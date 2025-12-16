"""
Tape executor for processing turn schedules.

This module executes turn tapes cell by cell with a single
pause/limit check location, simplifying the orchestration logic.

For TRPG mode, supports hidden agents (Action Manager) whose output
is passed directly to the next agent (Narrator) instead of being
saved to the database.
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Dict, Optional

import crud
from domain.value_objects.contexts import OrchestrationContext
from domain.value_objects.enums import MessageRole
from infrastructure.logging.perf_logger import get_perf_logger
from sqlalchemy.orm import selectinload

from .models import CellType, ExecutionResult, TurnCell, TurnTape

logger = logging.getLogger(__name__)


@dataclass
class CellExecutionResult:
    """Result of executing a single cell."""

    responses: int = 0
    skips: int = 0
    output_text: Optional[str] = None  # Captured output for passes_output cells


class TapeExecutor:
    """
    Executes turn tapes cell by cell.

    Features:
    - Single pause check location (before each cell)
    - Single limit check location (before each cell)
    - User interrupt handling (stops execution, tape cut externally)
    - Skip counting for all-skipped detection
    - Hidden agent support (messages created via tools instead of auto-save)
    """

    def __init__(
        self,
        response_generator,
        agents_by_id: Dict[int, any],
        max_total_messages: int = 30,
    ):
        """
        Initialize executor.

        Args:
            response_generator: ResponseGenerator instance
            agents_by_id: Dict mapping agent IDs to agent objects
            max_total_messages: Safety limit to prevent infinite loops
        """
        self.response_generator = response_generator
        self.agents_by_id = agents_by_id
        self.max_total_messages = max_total_messages

    async def execute(
        self,
        tape: TurnTape,
        orch_context: OrchestrationContext,
        user_message_content: Optional[str] = None,
        current_total: int = 0,
    ) -> ExecutionResult:
        """
        Execute the tape cell by cell.

        Args:
            tape: The TurnTape to execute
            orch_context: Orchestration context with db, room_id, agent_manager
            user_message_content: For initial round (None for follow-ups)
            current_total: Current total messages count (for limit checking across tapes)

        Returns:
            ExecutionResult with counts and status flags
        """
        result = ExecutionResult()
        running_total = current_total

        # Performance tracking
        tape_start = time.perf_counter()
        perf = get_perf_logger()
        cell_count = 0

        while not tape.is_exhausted():
            # ===== SINGLE PAUSE CHECK =====
            room = await crud.get_room_cached(orch_context.db, orch_context.room_id)
            if room and room.is_paused:
                logger.info(f"⏸️  Tape paused | Room: {orch_context.room_id}")
                result.was_paused = True
                break

            # ===== SINGLE LIMIT CHECK (max_total_messages) =====
            if running_total >= self.max_total_messages:
                logger.info(
                    f"🛑 Tape limit reached (max_total_messages) | Room: {orch_context.room_id} | Total: {running_total}"
                )
                result.reached_limit = True
                break

            # ===== SINGLE LIMIT CHECK (room.max_interactions) =====
            if room and room.max_interactions is not None:
                current_count = await self._count_agent_messages(orch_context.db, orch_context.room_id)
                if current_count >= room.max_interactions:
                    logger.info(
                        f"🛑 Room interaction limit reached | Room: {orch_context.room_id} | "
                        f"Count: {current_count}/{room.max_interactions}"
                    )
                    result.reached_limit = True
                    break

            # Get current cell
            cell = tape.current_cell()
            if cell is None:
                break

            # Execute current cell
            try:
                cell_start = time.perf_counter()
                cell_count += 1

                cell_result = await self._execute_cell(cell, orch_context, user_message_content)

                # Log cell execution timing
                cell_duration_ms = (time.perf_counter() - cell_start) * 1000
                agent_names = [self.agents_by_id[id].name for id in cell.agent_ids if id in self.agents_by_id]
                perf.log_sync(
                    "tape_cell_execution",
                    cell_duration_ms,
                    ",".join(agent_names) if agent_names else None,
                    orch_context.room_id,
                    cell_type=cell.cell_type.value,
                    cell_num=cell_count,
                    hidden=cell.hidden,
                    responses=cell_result.responses,
                    skips=cell_result.skips,
                )

                result.total_responses += cell_result.responses
                result.total_skips += cell_result.skips
                # Only count visible responses toward the limit
                if not cell.hidden:
                    running_total += cell_result.responses

                # After hidden cells (e.g., Action Manager), check if travel occurred
                # and update orch_context.room_id for subsequent operations
                if cell.hidden:
                    await self._refresh_room_id_after_travel(orch_context)

            except asyncio.CancelledError:
                logger.info(f"⏹️  Tape interrupted | Room: {orch_context.room_id}")
                result.was_interrupted = True
                tape.cut_at_current()
                raise

            # Advance to next cell
            tape.advance()

        # Check if all agents skipped (no responses, some skips)
        if result.total_responses == 0 and result.total_skips > 0:
            result.all_skipped = True

        # Log total tape execution timing
        tape_duration_ms = (time.perf_counter() - tape_start) * 1000
        perf.log_sync(
            "tape_total_execution",
            tape_duration_ms,
            None,
            orch_context.room_id,
            cell_count=cell_count,
            responses=result.total_responses,
            skips=result.total_skips,
            paused=result.was_paused,
            interrupted=result.was_interrupted,
        )

        return result

    async def _execute_cell(
        self,
        cell: TurnCell,
        orch_context: OrchestrationContext,
        user_message_content: Optional[str],
    ) -> CellExecutionResult:
        """
        Execute a single cell.

        Args:
            cell: The cell to execute
            orch_context: Orchestration context
            user_message_content: User's action/message

        Returns:
            CellExecutionResult with response counts and optional captured output
        """
        # Get agents for this cell (filter out any that no longer exist)
        agents = [self.agents_by_id[id] for id in cell.agent_ids if id in self.agents_by_id]

        if not agents:
            logger.debug(f"Cell has no valid agents, skipping: {cell}")
            return CellExecutionResult()

        hidden_str = " (hidden)" if cell.hidden else ""
        logger.debug(f"Executing cell: {cell}{hidden_str} with {len(agents)} agent(s)")

        if cell.is_concurrent:
            # Concurrent execution (multiple agents at once)
            # Note: hidden not supported for concurrent cells
            return await self._execute_concurrent(agents, orch_context, user_message_content, cell)
        else:
            # Sequential execution (one agent, or interrupt agents one by one)
            return await self._execute_sequential(agents, orch_context, user_message_content, cell)

    async def _execute_sequential(
        self,
        agents: list,
        orch_context: OrchestrationContext,
        user_message_content: Optional[str],
        cell: TurnCell,
    ) -> CellExecutionResult:
        """
        Execute agents sequentially (one at a time).

        For INTERRUPT cells, process all agents sequentially.
        For SEQUENTIAL cells, there's only one agent.

        If cell.hidden is True, the agent's response is not saved to DB.
        For hidden agents (1-agent TRPG system), visible messages are created
        via tools (narration, suggest_options) rather than auto-save.

        Args:
            agents: List of agents to execute
            orch_context: Orchestration context
            user_message_content: User's action/message
            cell: The cell being executed
        """
        result = CellExecutionResult()

        for agent in agents:
            # Skip if this agent triggered the interrupt (self-interruption prevention)
            # This is handled in generator now, but double-check here
            if cell.cell_type == CellType.INTERRUPT and cell.triggering_agent_id == agent.id:
                logger.debug(f"⏭️  Skipping self-interrupt for {agent.name}")
                continue

            try:
                # Execute agent - wait for completion
                response_result = await self.response_generator.generate_response(
                    orch_context=orch_context,
                    agent=agent,
                    user_message_content=user_message_content,
                    hidden=cell.hidden,
                )

                # Handle response result (can be bool or tuple for hidden agents)
                if isinstance(response_result, tuple):
                    responded, response_text = response_result
                else:
                    responded = response_result
                    response_text = None

                if responded:
                    result.responses += 1
                    hidden_str = " (hidden)" if cell.hidden else ""
                    logger.debug(f"✅ Agent {agent.name} responded{hidden_str}")

                    # Capture output for passes_output cells (if needed)
                    if cell.passes_output and response_text:
                        result.output_text = response_text
                else:
                    result.skips += 1
                    logger.debug(f"⏭️  Agent {agent.name} skipped")

            except asyncio.CancelledError:
                # Re-raise cancellation to stop processing
                raise
            except Exception as e:
                logger.error(f"❌ Agent {agent.name} error: {e}")
                # Errors don't count as skips - try to continue
                try:
                    await orch_context.db.rollback()
                except Exception:
                    pass

        return result

    async def _execute_concurrent(
        self,
        agents: list,
        orch_context: OrchestrationContext,
        user_message_content: Optional[str],
        cell: TurnCell,
    ) -> CellExecutionResult:
        """Execute multiple agents concurrently via asyncio.gather.

        Note: hidden/passes_output not supported for concurrent cells.
        """
        tasks = [
            self.response_generator.generate_response(
                orch_context=orch_context,
                agent=agent,
                user_message_content=user_message_content,
            )
            for agent in agents
        ]

        logger.debug(f"⏳ Executing {len(tasks)} agents concurrently...")
        results = await asyncio.gather(*tasks, return_exceptions=True)

        cell_result = CellExecutionResult()

        for i, res in enumerate(results):
            if isinstance(res, Exception):
                logger.error(f"❌ Agent {agents[i].name} error: {res}")
                # Errors don't count as skips
            elif res is True or (isinstance(res, tuple) and res[0]):
                cell_result.responses += 1
                logger.debug(f"✅ Agent {agents[i].name} responded")
            else:
                cell_result.skips += 1
                logger.debug(f"⏭️  Agent {agents[i].name} skipped")

        return cell_result

    async def _count_agent_messages(self, db, room_id: int) -> int:
        """Count agent messages in room."""
        import models
        from sqlalchemy import func
        from sqlalchemy.future import select

        result = await db.execute(
            select(func.count(models.Message.id)).where(
                models.Message.room_id == room_id,
                models.Message.role == MessageRole.ASSISTANT,
            )
        )
        return result.scalar() or 0

    async def _refresh_room_id_after_travel(self, orch_context: OrchestrationContext) -> bool:
        """
        Check if player location changed and update orch_context.room_id.

        After the Action Manager uses the travel tool, the player's current
        location changes. This method fetches the new location's room_id
        and updates the orchestration context so subsequent agents (Narrator)
        use the correct room.

        Args:
            orch_context: The orchestration context to update

        Returns:
            True if room_id was updated, False otherwise
        """
        if not orch_context.world_id:
            return False

        import models
        from sqlalchemy.future import select

        # Expire all cached objects to ensure we get fresh data from DB
        # This is necessary because the travel tool may have updated location.room_id
        # in a different part of the session, and the identity map might have stale data
        orch_context.db.expire_all()

        # Get player state with current location
        result = await orch_context.db.execute(
            select(models.PlayerState)
            .options(selectinload(models.PlayerState.current_location))
            .where(models.PlayerState.world_id == orch_context.world_id)
        )
        player_state = result.scalar_one_or_none()

        if not player_state or not player_state.current_location:
            return False

        new_room_id = player_state.current_location.room_id
        if new_room_id and new_room_id != orch_context.room_id:
            old_room_id = orch_context.room_id
            orch_context.room_id = new_room_id
            logger.info(f"🗺️  Room updated after travel | Old: {old_room_id} -> New: {new_room_id}")
            return True

        return False
