"""
TRPG orchestrator for turn-based gameplay.

Handles the 1-agent gameplay system where Action Manager interprets player actions,
invokes sub-agents (item_designer, character_designer, location_designer) via Task tool,
uses change_stat directly for stat/inventory changes,
and creates visible output via narration and suggest_options tools.
"""

import asyncio
import logging
import time
from typing import Dict, List, Optional

import crud
from domain.value_objects.contexts import OrchestrationContext
from domain.value_objects.enums import WorldPhase
from infrastructure.database import models
from infrastructure.logging.perf_logger import track_interaction
from sdk import AgentManager
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
        # Store agent_manager during turn execution (for tool access)
        self._current_agent_manager: Optional[AgentManager] = None
        # Store current orchestration context during turn (for memory rounds)
        self._current_orch_context: Optional[OrchestrationContext] = None

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

    @track_interaction(room_id_param="room_id", action_param="action_text")
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

        # Store context for tool access (e.g., memory rounds during travel)
        self._current_agent_manager = agent_manager
        self._current_orch_context = orch_context

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
            # Active gameplay - get NPCs and pre-connect them
            if has_gameplay_agents(all_agents):
                npcs = await self._get_npcs_at_current_location(db, world.id)
                npc_ids = [npc.id for npc in npcs]

                # Pre-connect NPC clients concurrently (warm up SDK clients)
                if npcs:
                    npc_names = [npc.name for npc in npcs]
                    logger.info(f"[TRPG] Found {len(npc_ids)} NPCs at location: {npc_names}")
                    await self._pre_connect_npcs(npcs[:5], db, room_id, world, agent_manager)

                tape = create_gameplay_tape(all_agents, npc_ids=npc_ids)
                logger.info(f"[TRPG] Gameplay phase - running action round (NPCs: {len(npc_ids)})")
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
            # Clear stored context
            self._current_agent_manager = None
            self._current_orch_context = None

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
        action_text: str | None,
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

        return True

    async def _get_npcs_at_current_location(self, db: AsyncSession, world_id: int) -> list:
        """Get NPC agents at the player's current location."""
        from crud.locations import get_characters_at_location

        player_state = await crud.get_player_state(db, world_id)
        if not player_state or not player_state.current_location_id:
            logger.debug("[TRPG] No current location for NPC reactions")
            return []

        return await get_characters_at_location(db, player_state.current_location_id, exclude_system_agents=True)

    async def _pre_connect_npcs(
        self,
        npcs: list,
        db: AsyncSession,
        room_id: int,
        world: models.World,
        agent_manager: AgentManager,
    ) -> None:
        """Pre-connect NPC clients concurrently to warm up SDK clients."""
        try:
            await asyncio.gather(*(
                agent_manager.pre_connect(
                    db=db,
                    room_id=room_id,
                    agent_id=npc.id,
                    agent_name=npc.name,
                    world_name=world.name,
                    world_id=world.id,
                    config_file=npc.config_file,
                    group_name=npc.group,
                )
                for npc in npcs
            ))
        except Exception as e:
            # Pre-connect is best-effort, don't fail the turn
            logger.debug(f"[TRPG] Pre-connect NPCs failed (non-critical): {e}")

    async def trigger_npc_memory_round(
        self,
        location_id: int,
        memory_prompt: str = "Use the memorize tool to remember any significant events from this conversation before the player leaves.",
    ) -> int:
        """
        Trigger NPCs at a location to memorize the conversation.

        Called by travel tool before player leaves a location.
        Each NPC gets a chance to use the memorize tool.

        Args:
            location_id: ID of the location where NPCs should memorize
            memory_prompt: The prompt to send to each NPC

        Returns:
            Number of NPCs that processed the memory round
        """
        if not self._current_orch_context or not self._current_agent_manager:
            logger.warning("[TRPG] Cannot trigger memory round - no active context")
            return 0

        from crud.locations import get_characters_at_location

        db = self._current_orch_context.db

        # Get NPCs at the location
        npcs = await get_characters_at_location(db, location_id, exclude_system_agents=True)
        if not npcs:
            logger.debug(f"[TRPG] No NPCs at location {location_id} for memory round")
            return 0

        logger.info(f"[TRPG] Starting memory round for {len(npcs)} NPCs at location {location_id}")

        # Create a temporary orchestration context for the memory round
        # Use the same db and agent_manager but with the location's room
        from crud.locations import get_location

        location = await get_location(db, location_id)
        if not location or not location.room_id:
            logger.warning(f"[TRPG] Location {location_id} has no room for memory round")
            return 0

        memory_orch_context = OrchestrationContext(
            db=db,
            room_id=location.room_id,
            agent_manager=self._current_agent_manager,
            world_id=self._current_orch_context.world_id,
            world_name=self._current_orch_context.world_name,
        )

        # Trigger all NPCs in parallel (hidden, they'll use memorize tool if needed)
        async def process_npc(npc):
            try:
                logger.debug(f"[TRPG] Memory round: triggering {npc.name}")
                responded, _ = await self.response_generator.generate_response(
                    orch_context=memory_orch_context,
                    agent=npc,
                    user_message_content=memory_prompt,
                    hidden=True,  # Don't save response to DB
                    skip_context=True,  # Use memory_prompt directly, SDK already has conversation
                )
                if responded:
                    logger.info(f"[TRPG] Memory round: {npc.name} processed")
                    return True
                else:
                    logger.debug(f"[TRPG] Memory round: {npc.name} skipped")
                    return False
            except Exception as e:
                logger.error(f"[TRPG] Memory round error for {npc.name}: {e}")
                return False

        results = await asyncio.gather(*[process_npc(npc) for npc in npcs])
        processed_count = sum(1 for r in results if r)

        logger.info(f"[TRPG] Memory round complete: {processed_count}/{len(npcs)} NPCs processed")
        return processed_count

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
