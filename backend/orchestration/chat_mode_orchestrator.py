"""
Chat mode orchestrator for free-form NPC conversations.

Handles player-NPC conversations outside the Action Manager -> Narrator gameplay loop.
In chat mode:
- Only NPCs at the current location respond
- No Action Manager, no Narrator
- NPCs can use their normal tools (memorize, skip, etc.)
- Standard multi-agent turn logic with priority and interrupt_every_turn
"""

import asyncio
import logging
import time
from typing import Dict, List, Optional

import crud
import models
from domain.value_objects.contexts import OrchestrationContext
from sdk import AgentManager
from sqlalchemy.ext.asyncio import AsyncSession

from .response_generator import ResponseGenerator
from .tape import TapeExecutor
from .tape.models import CellType, TurnCell, TurnTape

logger = logging.getLogger("ChatModeOrchestrator")


def create_chat_mode_tape(npcs: List[models.Agent]) -> Optional[TurnTape]:
    """
    Create a tape for chat mode NPC responses.

    Args:
        npcs: List of NPC agents at the current location

    Returns:
        TurnTape for chat mode, or None if no NPCs
    """
    if not npcs:
        return None

    tape = TurnTape()

    # Separate interrupt (every-turn) agents from regular agents
    interrupt_agents = [a for a in npcs if a.interrupt_every_turn]
    regular_agents = [a for a in npcs if not a.interrupt_every_turn]

    # Sort regular agents by priority (higher first)
    regular_agents.sort(key=lambda a: a.priority, reverse=True)

    # Add regular agents as concurrent cell (or sequential if only one)
    if regular_agents:
        if len(regular_agents) == 1:
            tape.cells.append(
                TurnCell(
                    cell_type=CellType.SEQUENTIAL,
                    agent_ids=[regular_agents[0].id],
                )
            )
        else:
            # Concurrent execution for multiple regular NPCs
            tape.cells.append(
                TurnCell(
                    cell_type=CellType.CONCURRENT,
                    agent_ids=[a.id for a in regular_agents],
                )
            )

    # Add interrupt agents (always respond) as sequential cells
    # Sort by priority (higher first)
    interrupt_agents.sort(key=lambda a: a.priority, reverse=True)
    for agent in interrupt_agents:
        tape.cells.append(
            TurnCell(
                cell_type=CellType.INTERRUPT,
                agent_ids=[agent.id],
            )
        )

    logger.info(f"Created chat mode tape: {len(regular_agents)} regular NPCs, {len(interrupt_agents)} interrupt NPCs")
    return tape


class ChatModeOrchestrator:
    """
    Orchestrates NPC-only conversations in chat mode.

    Key differences from TRPGOrchestrator:
    - Only NPCs respond (no Action_Manager, Narrator)
    - Uses standard multi-agent tape logic (priority, interrupt_every_turn)
    - NPCs can use their normal tools including memorize
    - No hidden agents or passes_output
    """

    def __init__(self):
        # Track active processing tasks per room for interruption
        self.active_room_tasks: Dict[int, asyncio.Task] = {}
        # Used to skip broadcasting responses that were started before interruption
        self.last_user_message_time: Dict[int, float] = {}
        # Initialize response generator
        self.response_generator = ResponseGenerator(self.last_user_message_time)

    def get_chatting_agents(self, room_id: int, agent_manager: AgentManager) -> list[int]:
        """Get list of agent IDs currently chatting in a room."""
        chatting_agent_ids = []
        for task_id in agent_manager.active_clients.keys():
            if task_id.room_id == room_id:
                chatting_agent_ids.append(task_id.agent_id)
        return chatting_agent_ids

    async def handle_chat_message(
        self,
        db: AsyncSession,
        room_id: int,
        message_text: str,
        agent_manager: AgentManager,
        world_id: int,
        world_name: str,
        location_id: int,
        chat_session_id: Optional[int] = None,
    ) -> bool:
        """
        Handle a player message in chat mode.

        Triggers NPC responses from characters at the current location.

        Args:
            db: Database session
            room_id: Room ID (location room)
            message_text: The player's message text
            agent_manager: AgentManager for generating responses
            world_id: World ID
            world_name: World name
            location_id: Current location ID
            chat_session_id: Chat session ID for message grouping (separate from game context)

        Returns:
            True if processing completed, False if cancelled/failed
        """
        logger.info(
            f"[ChatMode] Message received | Room: {room_id} | Session: {chat_session_id} | Text: {message_text[:50]}..."
        )

        # Record timestamp for interruption tracking
        self.last_user_message_time[room_id] = time.time()

        # Get NPCs at current location (excludes system agents)
        npcs = await crud.get_characters_at_location(db, location_id, exclude_system_agents=True)

        if not npcs:
            logger.info(f"[ChatMode] No NPCs at location {location_id}, no responses needed")
            return True

        logger.info(f"[ChatMode] Found {len(npcs)} NPCs at location: {[n.name for n in npcs]}")

        # Create orchestration context with chat_session_id for separate chat context
        orch_context = OrchestrationContext(
            db=db,
            room_id=room_id,
            agent_manager=agent_manager,
            world_id=world_id,
            world_name=world_name,
            chat_session_id=chat_session_id,
        )

        # Build agent lookup dict
        agents_by_id = {a.id: a for a in npcs}

        # Create tape for NPC responses
        tape = create_chat_mode_tape(npcs)
        if tape is None:
            return True

        # Create tape executor
        executor = TapeExecutor(
            response_generator=self.response_generator,
            agents_by_id=agents_by_id,
            max_total_messages=15,  # Lower limit for chat mode
        )

        # Create processing task
        processing_task = asyncio.create_task(
            executor.execute(
                tape=tape,
                orch_context=orch_context,
                user_message_content=message_text,
            )
        )

        # Track task for cancellation
        self.active_room_tasks[room_id] = processing_task

        try:
            result = await processing_task
            logger.info(
                f"[ChatMode] Processing complete | Room: {room_id} | "
                f"Responses: {result.total_responses} | Skips: {result.total_skips}"
            )
            return True

        except asyncio.CancelledError:
            logger.info(f"[ChatMode] Processing cancelled | Room: {room_id}")
            return False

        except Exception as e:
            logger.error(f"[ChatMode] Error processing message | Room: {room_id} | Error: {e}")
            import traceback

            traceback.print_exc()
            return False

        finally:
            # Clean up task tracking
            if room_id in self.active_room_tasks and self.active_room_tasks[room_id] == processing_task:
                del self.active_room_tasks[room_id]

    async def interrupt_room(self, room_id: int, agent_manager: AgentManager):
        """Interrupt any ongoing processing in a room."""
        if room_id in self.active_room_tasks:
            task = self.active_room_tasks[room_id]
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        await agent_manager.interrupt_room(room_id)


# Global singleton
_chat_mode_orchestrator: Optional[ChatModeOrchestrator] = None


def get_chat_mode_orchestrator() -> ChatModeOrchestrator:
    """Get or create the global chat mode orchestrator instance."""
    global _chat_mode_orchestrator
    if _chat_mode_orchestrator is None:
        _chat_mode_orchestrator = ChatModeOrchestrator()
    return _chat_mode_orchestrator
