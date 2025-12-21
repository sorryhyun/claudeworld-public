"""
TRPG orchestrator for turn-based gameplay.

Handles the 1-agent gameplay system where Action Manager interprets player actions,
invokes sub-agents (stat_calculator, character_designer, location_designer) via Task tool,
and creates visible output via narration and suggest_options tools.
"""

import asyncio
import logging
import time
from typing import Dict, List, Optional

import crud
import models
from domain.value_objects.contexts import OrchestrationContext
from domain.value_objects.enums import WorldPhase
from sdk import AgentManager
from services.world_service import WorldService
from sqlalchemy.ext.asyncio import AsyncSession

from .response_generator import ResponseGenerator
from .tape import TapeExecutor
from .tape.trpg_generator import (
    create_gameplay_tape,
    create_onboarding_tape,
    has_gameplay_agents,
    has_onboarding_agents,
)

logger = logging.getLogger("TRPGOrchestrator")


class TRPGOrchestrator:
    """
    Orchestrates TRPG turn-based gameplay.

    Unlike ChatOrchestrator which handles free-form multi-agent chat,
    TRPGOrchestrator follows a strict sequential order for game resolution.
    """

    def __init__(self):
        # Track active processing tasks per room for interruption
        self.active_room_tasks: Dict[int, asyncio.Task] = {}
        # Used to skip broadcasting responses that were started before interruption
        self.last_user_message_time: Dict[int, float] = {}
        # Initialize response generator
        self.response_generator = ResponseGenerator(self.last_user_message_time)
        # Track rooms where seed generation is in progress (room_id -> agent info)
        self.seed_generation_rooms: Dict[int, dict] = {}
        # Track rooms where sub-agents are processing (room_id -> agent info)
        self.sub_agent_rooms: Dict[int, dict] = {}
        # Track rooms where narration has been produced (allows input unblocking)
        self.narration_produced_rooms: set[int] = set()

    def get_chatting_agents(self, room_id: int, agent_manager: AgentManager) -> list[int]:
        """
        Get list of agent IDs currently chatting (generating responses) in a room.
        """
        chatting_agent_ids = []
        for task_id in agent_manager.active_clients.keys():
            if task_id.room_id == room_id:
                chatting_agent_ids.append(task_id.agent_id)
        return chatting_agent_ids

    def set_seed_generation_active(self, room_id: int, agent_name: str = "World Seed Generator") -> None:
        """Mark that seed generation is in progress for a room."""
        self.seed_generation_rooms[room_id] = {
            "name": agent_name,
            "thinking_text": "Creating your world...",
            "response_text": "",
        }
        logger.info(f"[TRPG] Seed generation started | Room: {room_id}")

    def set_seed_generation_inactive(self, room_id: int) -> None:
        """Mark that seed generation is complete for a room."""
        if room_id in self.seed_generation_rooms:
            del self.seed_generation_rooms[room_id]
            logger.info(f"[TRPG] Seed generation complete | Room: {room_id}")

    def get_seed_generation_status(self, room_id: int) -> Optional[dict]:
        """Get seed generation status for a room, or None if not active."""
        return self.seed_generation_rooms.get(room_id)

    def set_sub_agent_active(self, room_id: int, agent_name: str, thinking_text: str = "") -> None:
        """Mark that a sub-agent is processing for a room."""
        self.sub_agent_rooms[room_id] = {
            "name": agent_name,
            "thinking_text": thinking_text or f"{agent_name} is processing...",
            "response_text": "",
        }
        logger.info(f"[TRPG] Sub-agent active | Room: {room_id} | Agent: {agent_name}")

    def set_sub_agent_inactive(self, room_id: int) -> None:
        """Mark that sub-agent processing is complete for a room."""
        if room_id in self.sub_agent_rooms:
            del self.sub_agent_rooms[room_id]
            logger.info(f"[TRPG] Sub-agent complete | Room: {room_id}")

    def get_sub_agent_status(self, room_id: int) -> Optional[dict]:
        """Get sub-agent status for a room, or None if not active."""
        return self.sub_agent_rooms.get(room_id)

    def set_narration_produced(self, room_id: int) -> None:
        """Mark that narration has been produced for a room (unblocks input)."""
        self.narration_produced_rooms.add(room_id)
        logger.info(f"[TRPG] Narration produced | Room: {room_id}")

    def clear_narration_produced(self, room_id: int) -> None:
        """Clear narration produced flag (called when AM turn ends)."""
        self.narration_produced_rooms.discard(room_id)

    def has_narration_produced(self, room_id: int) -> bool:
        """Check if narration has been produced for a room."""
        return room_id in self.narration_produced_rooms

    async def handle_player_action(
        self,
        db: AsyncSession,
        room_id: int,
        action_text: str,
        agent_manager: AgentManager,
        world: models.World,
    ) -> bool:
        """
        Handle a player action and orchestrate TRPG agent responses.

        Args:
            db: Database session
            room_id: Room ID (location room or onboarding room)
            action_text: The player's action text
            agent_manager: AgentManager for generating responses
            world: World model for phase detection

        Returns:
            True if processing completed, False if cancelled/failed
        """
        logger.info(f"[TRPG] Player action received | Room: {room_id} | Action: {action_text[:50]}...")

        # Record timestamp for interruption tracking
        self.last_user_message_time[room_id] = time.time()

        # Get all agents for the room
        all_agents = await crud.get_agents_cached(db, room_id)

        if not all_agents:
            logger.warning(f"[TRPG] No agents found in room {room_id}")
            return False

        # Create orchestration context with world info for TRPG tools
        orch_context = OrchestrationContext(
            db=db,
            room_id=room_id,
            agent_manager=agent_manager,
            world_id=world.id,
            world_name=world.name,
        )

        # Build agent lookup dict
        agents_by_id = {a.id: a for a in all_agents}

        # Create tape executor
        executor = TapeExecutor(
            response_generator=self.response_generator,
            agents_by_id=agents_by_id,
            max_total_messages=30,
        )

        # Determine which tape to generate based on world phase and available agents
        tape = None

        if world.phase == WorldPhase.ONBOARDING:
            # During onboarding, only Onboarding Manager responds
            if has_onboarding_agents(all_agents):
                tape = create_onboarding_tape(all_agents)
                logger.info("[TRPG] Onboarding phase - running Onboarding Manager")
            else:
                logger.warning("[TRPG] Onboarding phase but no onboarding agents in room")
        else:
            # Active gameplay - full turn sequence
            if has_gameplay_agents(all_agents):
                tape = create_gameplay_tape(all_agents)
                logger.info("[TRPG] Gameplay phase - running action round")
            else:
                logger.warning("[TRPG] Gameplay phase but no gameplay agents in room")

        if tape is None:
            # Fall back to simple sequential execution
            logger.warning("[TRPG] No valid tape, using simple sequential")
            return await self._handle_simple_sequential(db, room_id, action_text, agent_manager, all_agents, world)

        # Create processing task
        processing_task = asyncio.create_task(self._execute_tape(executor, tape, orch_context, action_text))

        # Track task for cancellation
        self.active_room_tasks[room_id] = processing_task

        try:
            result = await processing_task
            logger.info(
                f"[TRPG] Processing complete | Room: {room_id} | "
                f"Responses: {result.total_responses} | Skips: {result.total_skips}"
            )

            # Apply any pending phase changes after agent turn completes
            # This is used by the onboarding complete tool to defer phase transition
            if world.name:
                WorldService.apply_pending_phase(world.name)

            return True

        except asyncio.CancelledError:
            logger.info(f"[TRPG] Processing cancelled | Room: {room_id}")
            return False

        except Exception as e:
            logger.error(f"[TRPG] Error processing action | Room: {room_id} | Error: {e}")
            import traceback

            traceback.print_exc()
            return False

        finally:
            # Clean up task tracking (task may already be removed via pop() in interrupt)
            self.active_room_tasks.pop(room_id, None)
            # Clear narration produced flag for next turn
            self.clear_narration_produced(room_id)

    async def _execute_tape(self, executor, tape, orch_context, action_text):
        """Execute the tape and return result."""
        return await executor.execute(
            tape=tape,
            orch_context=orch_context,
            user_message_content=action_text,
        )

    async def _handle_simple_sequential(
        self,
        db: AsyncSession,
        room_id: int,
        action_text: str,
        agent_manager: AgentManager,
        agents: List[models.Agent],
        world: models.World,
    ) -> bool:
        """
        Fallback: Execute agents in simple sequential order when full TRPG setup is not available.
        """
        orch_context = OrchestrationContext(
            db=db,
            room_id=room_id,
            agent_manager=agent_manager,
            world_id=world.id,
            world_name=world.name,
        )

        for agent in agents:
            try:
                responded = await self.response_generator.generate_response(
                    orch_context=orch_context,
                    agent=agent,
                    user_message_content=action_text,
                )
                logger.info(f"[TRPG] Agent {agent.name} {'responded' if responded else 'skipped'}")
                # Clear action text after first agent (subsequent agents see conversation)
                action_text = None

            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"[TRPG] Agent {agent.name} error: {e}")

        # Apply any pending phase changes after all agents complete
        if world.name:
            WorldService.apply_pending_phase(world.name)

        return True

    async def interrupt_room(self, room_id: int, agent_manager: AgentManager):
        """Interrupt any ongoing processing in a room."""
        # Atomically remove and cancel task
        task = self.active_room_tasks.pop(room_id, None)
        if task and not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass  # Expected or timed out

        await agent_manager.interrupt_room(room_id)


# Global singleton
_trpg_orchestrator: Optional[TRPGOrchestrator] = None


def get_trpg_orchestrator() -> TRPGOrchestrator:
    """Get or create the global TRPG orchestrator instance."""
    global _trpg_orchestrator
    if _trpg_orchestrator is None:
        _trpg_orchestrator = TRPGOrchestrator()
    return _trpg_orchestrator
