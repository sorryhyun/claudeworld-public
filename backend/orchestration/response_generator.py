"""
Agent response generation for multi-agent conversations.

This module handles the logic for generating individual agent responses,
including context building, API calls, and message broadcasting.
"""

import logging
import time
from typing import Optional

import crud
import schemas
from core.settings import SKIP_MESSAGE_TEXT
from domain import Agent
from domain.entities.agent import is_action_manager, is_world_seed_generator
from domain.value_objects.contexts import AgentMessageData, AgentResponseContext, MessageContext, OrchestrationContext
from domain.value_objects.enums import MessageRole, WorldPhase
from i18n.timezone import format_kst_timestamp
from infrastructure.logging.perf_logger import get_perf_logger
from services.prompt_builder import build_runtime_system_prompt
from services.world_service import WorldService
from utils.helpers import get_pool_key

from orchestration.conversation import detect_conversation_type

from .context import build_conversation_context
from .gameplay_context import GameplayContextBuilder
from .handlers import save_agent_message

logger = logging.getLogger(__name__)


class ResponseGenerator:
    """
    Handles the generation of responses from individual agents.

    This class is responsible for:
    - Building conversation context for each agent
    - Generating agent responses via AgentManager
    - Handling interruption checks
    - Broadcasting responses to clients
    """

    def __init__(self, last_user_message_time: dict[int, float]):
        """
        Initialize the response generator.

        Args:
            last_user_message_time: Shared dict tracking last user message timestamp per room
        """
        self.last_user_message_time = last_user_message_time

    def _is_world_seed_generator(self, agent_name: str) -> bool:
        """Check if agent is World Seed Generator."""
        return is_world_seed_generator(agent_name)

    def _is_action_manager(self, agent_name: str) -> bool:
        """Check if agent is Action Manager (for gameplay context)."""
        return is_action_manager(agent_name)

    async def generate_response(
        self,
        orch_context: OrchestrationContext,
        agent: Agent,
        user_message_content: Optional[str] = None,
        hidden: bool = False,
    ) -> bool | tuple[bool, str]:
        """
        Generate a response from a single agent.
        In initial responses, this runs concurrently with other agents.
        In follow-up rounds, this runs sequentially.

        Args:
            orch_context: OrchestrationContext containing db, room_id, manager, agent_manager
            agent: Agent object
            user_message_content: The user's message (for initial responses), or None for follow-ups
            hidden: If True, don't save message to DB and return (responded, response_text) tuple.
                    For TRPG gameplay, hidden agents create visible messages via tools (narration tool).

        Returns:
            If hidden=False: True if agent responded, False if agent skipped
            If hidden=True: (True, response_text) if responded, (False, "") if skipped
        """
        # Record when this response generation started
        # Used to check if it was interrupted by a new user message
        response_start_time = time.time()
        perf = get_perf_logger()

        # Generate unique task ID for interruption tracking
        task_id = get_pool_key(orch_context.room_id, agent.id)

        # Fetch room to get created_at timestamp (use cache for performance)
        async with perf.track("fetch_room", agent_name=agent.name, room_id=orch_context.room_id):
            room = await crud.get_room_cached(orch_context.db, orch_context.room_id)

        # Fetch messages based on context type
        # In chat mode (chat_session_id is set), get messages since agent's last response, but:
        #   - Include game messages (chat_session_id is NULL)
        #   - Include current chat session messages only (not previous chat sessions)
        # In game mode, get messages since this agent's last response
        async with perf.track("fetch_messages", agent_name=agent.name, room_id=orch_context.room_id):
            if orch_context.chat_session_id is not None:
                # Chat mode: get messages after agent's last response
                all_recent_messages = await crud.get_messages_after_agent_response_cached(
                    orch_context.db,
                    orch_context.room_id,
                    agent.id,
                    limit=100,
                )
                # Filter: keep game messages (no chat_session_id) OR current chat session
                # This excludes previous chat session messages (SDK remembers those)
                room_messages = [
                    m
                    for m in all_recent_messages
                    if m.chat_session_id is None or m.chat_session_id == orch_context.chat_session_id
                ]
            else:
                # Game mode: get messages since agent's last response (cache for performance)
                room_messages = await crud.get_messages_after_agent_response_cached(
                    orch_context.db,
                    orch_context.room_id,
                    agent.id,
                    limit=120,
                )

        # Get agent config data
        agent_config = agent.get_config_data()

        # Get number of agents in the room
        agent_count = len(room.agents) if room else 0

        # Determine conversation type and participants using shared utility
        _, user_name, has_situation_builder = detect_conversation_type(room_messages, agent_count)

        # Check if this is a game room and get world settings for context building
        is_onboarding = room and room.world and room.world.phase == WorldPhase.ONBOARDING
        is_game = room and room.world and room.world.phase == WorldPhase.ACTIVE
        world_user_name = room.world.user_name if room and room.world else None
        world_language = room.world.language if room and room.world else None

        # Determine if in chat mode (before building context)
        is_chat_mode = orch_context.chat_session_id is not None

        # Build conversation context from room messages (only new messages since agent's last response)
        conv_ctx_start = time.perf_counter()
        conversation_context = build_conversation_context(
            room_messages,
            limit=25,
            agent_id=agent.id,
            agent_name=agent.name,
            agent_group=agent.group,
            agent_count=agent_count,
            user_name=user_name,
            is_onboarding=is_onboarding,
            is_game=is_game,
            is_chat_mode=is_chat_mode,
            world_user_name=world_user_name,
            world_language=world_language,
            recent_events=agent_config.recent_events,
        )
        conv_ctx_ms = (time.perf_counter() - conv_ctx_start) * 1000
        perf.log_sync("build_conv_context", conv_ctx_ms, agent.name, orch_context.room_id, msg_count=len(room_messages))

        # For follow-up rounds, skip if there are no new messages since this agent's last response
        if user_message_content is None:
            if not self._has_new_messages(conversation_context):
                return False

        # Create message context for handlers (include chat_session_id if in chat mode)
        msg_context = MessageContext(
            db=orch_context.db,
            room_id=orch_context.room_id,
            agent=agent,
            chat_session_id=orch_context.chat_session_id,
        )

        # Get this agent's session for this specific room
        session_id = await crud.get_room_agent_session(orch_context.db, orch_context.room_id, agent.id)

        # For active gameplay, use specialized context for Action Manager
        world_name = room.world.name if room and room.world else None
        message_to_agent = None
        gameplay_system_prompt_suffix = ""

        # Check if this is Action Manager gameplay context
        is_action_mgr = self._is_action_manager(agent.name)

        # Action Manager needs: is_game AND user_message_content
        should_build_am_context = is_game and world_name and is_action_mgr and user_message_content

        if should_build_am_context:
            gameplay_ctx_start = time.perf_counter()
            context_builder = GameplayContextBuilder(world_name)

            # Action Manager: system prompt gets lore + location + present characters (loaded from world)
            am_context = context_builder.build_action_manager_context()
            gameplay_system_prompt_suffix = context_builder.build_action_manager_system_prompt(am_context)
            message_to_agent = context_builder.build_action_manager_user_message(user_message_content, agent.name)
            gameplay_ctx_ms = (time.perf_counter() - gameplay_ctx_start) * 1000
            perf.log_sync(
                "build_gameplay_ctx",
                gameplay_ctx_ms,
                agent.name,
                orch_context.room_id,
                type="action_manager",
                npcs=len(am_context.present_npcs),
            )
            logger.info(
                f"[Gameplay] Built Action Manager context for world '{world_name}' with {len(am_context.present_npcs)} characters"
            )

        # Fall back to conversation context if not using gameplay context
        if message_to_agent is None:
            message_to_agent = conversation_context if conversation_context else "Continue the conversation naturally."

        # Format conversation start timestamp
        conversation_started = None
        if room and room.created_at:
            conversation_started = format_kst_timestamp(room.created_at, "%Y-%m-%d %H:%M:%S KST")

        # Check if this is World Seed Generator (uses persist_world_seed tool)
        is_world_seed_gen = self._is_world_seed_generator(agent.name)

        # Build agent response context
        # Determine effective system prompt based on context:
        # 1. Gameplay agents (Action Manager, Narrator): use stored prompt + gameplay suffix
        # 2. Chat mode NPCs: build runtime prompt with lore injected between guideline and traits
        # 3. Other agents: use stored prompt as-is
        sys_prompt_start = time.perf_counter()
        effective_system_prompt = agent.system_prompt

        is_gameplay_agent = is_action_mgr or is_world_seed_gen

        if gameplay_system_prompt_suffix:
            # Gameplay agents get lore appended as suffix (existing behavior)
            effective_system_prompt = f"{agent.system_prompt}\n\n{gameplay_system_prompt_suffix}"
            sys_prompt_ms = (time.perf_counter() - sys_prompt_start) * 1000
            perf.log_sync(
                "build_system_prompt",
                sys_prompt_ms,
                agent.name,
                orch_context.room_id,
                type="gameplay_suffix",
                prompt_len=len(effective_system_prompt),
            )
        elif is_chat_mode and world_name and not is_gameplay_agent:
            # Chat mode NPCs: build runtime prompt with lore injected in the middle
            # Structure: [platform_guideline] -> [lore] -> [character_traits]
            lore = WorldService.load_lore(world_name)
            if lore:
                effective_system_prompt = build_runtime_system_prompt(
                    agent_name=agent.name,
                    config_data=agent_config,
                    lore=lore,
                )
                sys_prompt_ms = (time.perf_counter() - sys_prompt_start) * 1000
                perf.log_sync(
                    "build_system_prompt",
                    sys_prompt_ms,
                    agent.name,
                    orch_context.room_id,
                    type="chat_mode_lore",
                    lore_len=len(lore),
                    prompt_len=len(effective_system_prompt),
                )
                logger.info(f"[ChatMode] Built runtime system prompt for '{agent.name}' with lore ({len(lore)} chars)")
            else:
                sys_prompt_ms = (time.perf_counter() - sys_prompt_start) * 1000
                perf.log_sync(
                    "build_system_prompt",
                    sys_prompt_ms,
                    agent.name,
                    orch_context.room_id,
                    type="default",
                    prompt_len=len(effective_system_prompt),
                )
        else:
            sys_prompt_ms = (time.perf_counter() - sys_prompt_start) * 1000
            perf.log_sync(
                "build_system_prompt",
                sys_prompt_ms,
                agent.name,
                orch_context.room_id,
                type="default",
                prompt_len=len(effective_system_prompt),
            )

        logger.debug(f"Building response context for agent: '{agent.name}' (id: {agent.id})")
        response_context = AgentResponseContext(
            system_prompt=effective_system_prompt,
            user_message=message_to_agent,
            agent_name=agent.name,
            config=agent.get_config_data(),
            room_id=orch_context.room_id,
            agent_id=agent.id,
            group_name=agent.group,
            session_id=session_id,
            conversation_history=None,  # Not needed - already in message_to_agent
            task_id=task_id,
            conversation_started=conversation_started,
            has_situation_builder=has_situation_builder,
            world_name=world_name,
            db=orch_context.db,  # Pass db for TRPG game tools
            world_id=orch_context.world_id,  # Pass world_id for TRPG game tools
        )

        # Handle streaming response events
        response_text = ""
        thinking_text = ""
        new_session_id = session_id
        memory_entries = []
        anthropic_calls = []
        skipped = False
        stream_started = False
        sdk_start_time = time.perf_counter()

        # Iterate over streaming events from agent manager
        async for event in orch_context.agent_manager.generate_sdk_response(response_context):
            event_type = event.get("type")

            if event_type == "stream_start":
                stream_started = True

            elif event_type == "content_delta":
                response_text += event.get("delta", "")

            elif event_type == "thinking_delta":
                thinking_text += event.get("delta", "")

            elif event_type == "stream_end":
                # Extract final data
                response_text = event.get("response_text") or response_text
                thinking_text = event.get("thinking_text") or thinking_text
                new_session_id = event.get("session_id", session_id)
                memory_entries = event.get("memory_entries", [])
                anthropic_calls = event.get("anthropic_calls", [])
                skipped = event.get("skipped", False)

                # Log SDK response timing
                sdk_duration_ms = (time.perf_counter() - sdk_start_time) * 1000
                perf.log_sync(
                    "sdk_response_total",
                    sdk_duration_ms,
                    agent.name,
                    orch_context.room_id,
                    response_len=len(response_text or ""),
                    thinking_len=len(thinking_text or ""),
                )

        # Memory entries are now written directly by the memorize tool
        # So we can skip this section (kept for reference/debugging)
        if memory_entries:
            logger.debug(
                f"📝 Agent {agent.name} recorded {len(memory_entries)} memories (handled by memorize tool directly)"
            )

        # Log anthropic tool calls if any
        if anthropic_calls:
            logger.info(f"🔒 Agent {agent.name} called anthropic tool: {anthropic_calls}")

        # Update this room-agent session_id if it changed
        if new_session_id and new_session_id != session_id:
            await crud.update_room_agent_session(orch_context.db, orch_context.room_id, agent.id, new_session_id)

        # Skip if agent chose not to respond
        if skipped or not response_text:
            # Save skip message if stream was started (so frontend can show persistent skip indicator)
            # But not for hidden agents (they don't appear in chat at all)
            if stream_started and not hidden:
                skip_message = schemas.MessageCreate(
                    content=SKIP_MESSAGE_TEXT,
                    role=MessageRole.ASSISTANT,
                    agent_id=agent.id,
                    thinking=thinking_text if thinking_text else None,
                    chat_session_id=orch_context.chat_session_id,
                )
                # Don't update room activity for skip messages
                await crud.create_message(
                    orch_context.db, orch_context.room_id, skip_message, update_room_activity=False
                )
            return (False, "") if hidden else False

        # Check if this response was interrupted by a new user message
        # If a user message arrived after this response started, skip broadcasting it
        if self._was_interrupted(orch_context.room_id, response_start_time, agent.name):
            return (False, "") if hidden else False

        # Check if room was paused while this agent was generating
        # This prevents messages from being saved after pause button is pressed
        if room and room.is_paused:
            logger.info(f"⏸️  Room {orch_context.room_id} was paused. Discarding response from {agent.name}")
            return (False, "") if hidden else False

        # For hidden agents, don't save to database - just return the output
        # The narration tool creates visible messages during execution
        if hidden:
            logger.info(f"👻 Hidden agent {agent.name} completed turn | response_len={len(response_text)}")
            return (True, response_text)

        # Save message to database
        message_data = AgentMessageData(
            content=response_text,
            thinking=thinking_text,
            anthropic_calls=anthropic_calls if anthropic_calls else None,
        )
        await save_agent_message(msg_context, message_data)

        return True

    def _has_new_messages(self, conversation_context: str) -> bool:
        """
        Check if conversation_context contains new messages for the agent to respond to.

        Args:
            conversation_context: The formatted conversation context

        Returns:
            True if there are new messages, False otherwise
        """
        # Check if conversation_context is empty or only contains the header/footer
        # The context builder adds a header and footer, so minimal context has ~2 lines
        context_lines = conversation_context.strip().split("\n")

        # Filter out header/footer lines
        actual_messages = [
            line
            for line in context_lines
            if line
            and not line.startswith("Here's the recent conversation")
            and not line.startswith("Respond naturally")
        ]

        return bool(actual_messages)

    def _was_interrupted(self, room_id: int, response_start_time: float, agent_name: str) -> bool:
        """
        Check if this response was interrupted by a new user message.

        Args:
            room_id: Room ID
            response_start_time: When this response generation started
            agent_name: Name of the agent (for logging)

        Returns:
            True if interrupted, False otherwise
        """
        if room_id in self.last_user_message_time:
            last_user_msg_time = self.last_user_message_time[room_id]
            if last_user_msg_time > response_start_time:
                logger.info(
                    f"⏭️  SKIPPING BROADCAST | Room: {room_id} | Agent: {agent_name} | "
                    f"Response started at {response_start_time:.3f}, but interrupted by user message at {last_user_msg_time:.3f}"
                )
                return True
        return False
