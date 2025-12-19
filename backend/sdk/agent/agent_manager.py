"""
Agent manager for handling Claude SDK client lifecycle and response generation.

This module provides the AgentManager class which orchestrates agent responses,
manages client interruption, and handles conversation sessions.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import AsyncIterator

from claude_agent_sdk import ClaudeSDKClient
from domain.value_objects.contexts import AgentResponseContext
from domain.value_objects.task_identifier import TaskIdentifier
from infrastructure.logging.agent_logger import append_response_to_debug_log, write_debug_log
from infrastructure.logging.formatters import format_message_for_debug
from infrastructure.logging.perf_logger import get_perf_logger

from sdk.agent.options_builder import build_agent_options
from sdk.agent.streaming_state import StreamingStateManager
from sdk.client.client_pool import ClientPool
from sdk.client.stream_parser import StreamParser
from sdk.loaders import get_debug_config

# Streaming timeout configuration
# Used for both the message queue read timeout and SDK query timeout
STREAMING_IDLE_TIMEOUT = 120.0  # 2 minutes between messages before timing out

# Configure from settings
DEBUG_MODE = get_debug_config().get("debug", {}).get("enabled", False)

# Suppress apscheduler debug/info logs
logging.getLogger("apscheduler").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)
_perf = get_perf_logger()


class AgentManager:
    """Manages Claude SDK clients for agent response generation and interruption."""

    def __init__(self):
        self.active_clients: dict[TaskIdentifier, ClaudeSDKClient] = {}
        # Client pool for managing SDK client lifecycle
        self.client_pool = ClientPool()
        # Stream parser for SDK message parsing
        self.stream_parser = StreamParser()
        # Streaming state manager for tracking partial responses
        self.streaming_state = StreamingStateManager()

    async def interrupt_all(self):
        """Interrupt all currently active agent responses."""
        logger.info(f"🛑 Interrupting {len(self.active_clients)} active agent(s)")
        for task_id, client in list(self.active_clients.items()):
            try:
                await client.interrupt()
                logger.debug(f"Interrupted task: {task_id}")
            except Exception as e:
                logger.warning(f"Failed to interrupt task {task_id}: {e}")
        # Clear the active clients after interruption
        self.active_clients.clear()

    async def shutdown(self):
        """
        Gracefully shutdown all pooled clients and wait for cleanup tasks to complete.
        Should be called during application shutdown.
        """
        logger.info("🛑 Shutting down AgentManager")

        # Delegate to client pool
        await self.client_pool.shutdown_all()

        logger.info("✅ AgentManager shutdown complete")

    def cleanup_stale_resources(self) -> int:
        """
        Clean up stale resources to prevent memory leaks.

        This includes:
        - Task locks for clients no longer in the pool

        Returns:
            Total number of resources cleaned up.
        """
        return self.client_pool.cleanup_stale_locks()

    async def interrupt_room(self, room_id: int):
        """Interrupt all agents responding in a specific room."""
        logger.info(f"🛑 Interrupting agents in room {room_id}")
        tasks_to_interrupt = [task_id for task_id in self.active_clients.keys() if task_id.room_id == room_id]
        for task_id in tasks_to_interrupt:
            try:
                client = self.active_clients.get(task_id)
                if client:
                    await client.interrupt()
                    logger.debug(f"Interrupted task: {task_id}")
                    del self.active_clients[task_id]
            except Exception as e:
                logger.warning(f"Failed to interrupt task {task_id}: {e}")

    async def get_streaming_state_for_room(self, room_id: int) -> dict[int, dict]:
        """
        Get current streaming state (thinking/response text) for all agents in a room.

        Args:
            room_id: Room ID

        Returns:
            Dict mapping agent_id to their current streaming state
            Example: {1: {"thinking_text": "...", "response_text": "..."}}
        """
        return await self.streaming_state.get_for_room(room_id)

    async def get_and_clear_streaming_state_for_room(self, room_id: int) -> dict[int, dict]:
        """
        Get and clear streaming state for all agents in a room.

        Used during interrupt to capture partial responses before clearing state.
        This ensures we can save any in-progress responses to DB.

        Args:
            room_id: Room ID

        Returns:
            Dict mapping agent_id to their streaming state (thinking_text, response_text)
        """
        return await self.streaming_state.get_and_clear_for_room(room_id)

    async def generate_sdk_response(self, context: AgentResponseContext) -> AsyncIterator[dict]:
        """
        Generate a response from an agent using Claude Agent SDK with session persistence.
        This is an async generator that yields streaming events as the response is generated.
        Agent can choose to skip responding by calling the 'skip' tool.
        Agent can record memories by calling the 'memorize' tool (if ENABLE_MEMORY_TOOL=true).

        Args:
            context: AgentResponseContext containing all parameters for response generation

        Yields:
            Streaming events:
            - {"type": "stream_start", "temp_id": str, "agent_id": int, ...}
            - {"type": "content_delta", "delta": str}
            - {"type": "thinking_delta", "delta": str}
            - {"type": "stream_end", "response_text": Optional[str], "thinking_text": str,
               "session_id": str, "memory_entries": list[str], "anthropic_calls": list[str]}
        """

        # Create task identifier from room and agent IDs
        task_id = context.task_id or TaskIdentifier(room_id=context.room_id, agent_id=context.agent_id)

        # Generate a temporary ID for this streaming response
        temp_id = f"temp_{task_id}_{uuid.uuid4().hex[:8]}"

        # Log what the agent is receiving
        logger.info(
            f"🤖 Agent generating response | Session: {context.session_id or 'NEW'} | Task: {task_id} | Temp ID: {temp_id}"
        )
        logger.debug(f"System prompt (first 100 chars): {context.system_prompt[:100]}...")
        logger.debug(f"User message: {context.user_message}")
        if context.conversation_history:
            logger.debug(f"Conversation history (length): {len(context.conversation_history)} chars")

        try:
            # Yield stream_start event
            yield {
                "type": "stream_start",
                "temp_id": temp_id,
            }

            # Build final system prompt
            response_text = ""
            thinking_text = ""
            new_session_id = context.session_id
            skip_tool_called = False
            memory_entries: list[str] = []  # Track memory entries from memorize tool calls
            anthropic_calls: list[str] = []  # Track anthropic tool calls (via hook)
            structured_output = None  # Track structured output if using output_format

            # Build the message with conversation history if provided
            message_to_send = context.user_message
            if context.conversation_history:
                message_to_send = f"{context.conversation_history}\n\n{context.user_message}"

            # Build agent options with hooks for anthropic calls
            # Returns (options, config_hash) - config_hash used by pool for change detection
            options, config_hash = build_agent_options(context, context.system_prompt, anthropic_calls)

            # Get or create client from pool (reuses client for same room-agent pair)
            # This prevents creating hundreds of agent session files
            # Pass config_hash so pool can detect MCP config changes and reconnect if needed
            pool_key = task_id
            pool_start = time.perf_counter()
            # NOTE: usage_lock returned but not currently used - AgentManager's clients
            # are keyed by (room_id, agent_id) and typically not accessed concurrently
            # pooled contains: client, msg_queue (for reading), pump_task (background drainer)
            pooled, is_new, _ = await self.client_pool.get_or_create(pool_key, options, config_hash)
            pool_duration_ms = (time.perf_counter() - pool_start) * 1000

            # Log pool fetch timing (overall summary - details logged in ClientPool)
            _perf.log_sync(
                "get_pooled_client_total",
                pool_duration_ms,
                context.agent_name,
                context.room_id,
                is_new=is_new,
            )

            # Register this client for interruption support
            self.active_clients[task_id] = pooled.client
            logger.debug(f"Registered client for task: {task_id}")

            # Initialize streaming state for this task
            await self.streaming_state.init(task_id)

            # Write debug log with complete agent input
            await write_debug_log(
                agent_name=context.agent_name,
                task_id=str(task_id),
                system_prompt=context.system_prompt,
                message_to_send=message_to_send,
                config_data={
                    "in_a_nutshell": context.config.in_a_nutshell,
                    "characteristics": context.config.characteristics,
                    "recent_events": context.config.recent_events,
                },
                options=options,
                has_situation_builder=context.has_situation_builder,
            )

            # Send the message via query() - this is the correct SDK pattern
            logger.info(
                f"📤 Sending message to agent | Task: {context.task_id} | Message length: {len(message_to_send)}"
            )

            try:
                # NOTE: output_format is now included in options at build time
                # Setting client.options.output_format here would have NO EFFECT on the CLI subprocess
                if context.output_format:
                    logger.info(f"📊 Using structured output format for {context.agent_name}")

                # Build query content: multimodal if image present, otherwise plain text
                if context.image:
                    # SDK requires async generator for multimodal content (native image support)
                    # Find [[IMAGE]] placeholder and insert image block at that position
                    IMAGE_PLACEHOLDER = "[[IMAGE]]"

                    async def multimodal_message_generator():
                        content_blocks = []

                        if IMAGE_PLACEHOLDER in message_to_send:
                            # Split text at placeholder to insert image at correct position
                            parts = message_to_send.split(IMAGE_PLACEHOLDER, 1)
                            text_before = parts[0]
                            text_after = parts[1] if len(parts) > 1 else ""

                            # Add text before image (if any)
                            if text_before.strip():
                                content_blocks.append({"type": "text", "text": text_before})

                            # Add image block at the correct position
                            content_blocks.append(
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": context.image.media_type,
                                        "data": context.image.data,
                                    },
                                }
                            )

                            # Add text after image (if any)
                            if text_after.strip():
                                content_blocks.append({"type": "text", "text": text_after})
                        else:
                            # Fallback: no placeholder found, append image at end
                            content_blocks.append({"type": "text", "text": message_to_send})
                            content_blocks.append(
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": context.image.media_type,
                                        "data": context.image.data,
                                    },
                                }
                            )

                        yield {
                            "type": "user",
                            "message": {
                                "role": "user",
                                "content": content_blocks,
                            },
                        }

                    logger.info(f"📸 Sending multimodal message with native image | Task: {context.task_id}")
                    query_content = multimodal_message_generator()
                else:
                    query_content = message_to_send

                # Track query timing
                query_start = time.perf_counter()

                # Add timeout to query to prevent hanging
                await asyncio.wait_for(
                    pooled.client.query(query_content),
                    timeout=20.0,
                )

                # Log query latency
                query_duration_ms = (time.perf_counter() - query_start) * 1000
                _perf.log_sync(
                    "sdk_query_send",
                    query_duration_ms,
                    context.agent_name,
                    context.room_id,
                    msg_len=len(message_to_send),
                )

                logger.info(f"📬 Message sent, waiting for response | Task: {context.task_id}")
            except asyncio.TimeoutError:
                logger.error(f"⏰ Timeout sending message to agent | Task: {context.task_id}")
                raise Exception("Timeout sending message to agent")

            # Track time to first token
            streaming_start = time.perf_counter()
            first_token_logged = False

            # Read from message queue (filled by pump task in client_pool)
            # The pump keeps SDK control channel healthy for background subagent MCP calls
            while True:
                try:
                    message = await asyncio.wait_for(
                        pooled.msg_queue.get(),
                        timeout=STREAMING_IDLE_TIMEOUT,
                    )
                except asyncio.TimeoutError:
                    logger.error(f"⏰ Timeout waiting for message | Task: {context.task_id}")
                    raise Exception("Timeout waiting for response from agent")

                # Check for end sentinel (pump finished - stream ended)
                if message is None:
                    logger.debug(f"Received end sentinel for task: {task_id}")
                    break

                # Check if this is the final result message
                is_result_message = message.__class__.__name__ == "ResultMessage"
                # Parse the message using StreamParser
                parsed = self.stream_parser.parse_message(message, response_text, thinking_text)

                # Calculate deltas for yielding
                content_delta = parsed.response_text[len(response_text) :]
                thinking_delta = parsed.thinking_text[len(thinking_text) :]

                # Log time to first token (content or thinking)
                if not first_token_logged and (content_delta or thinking_delta):
                    first_token_ms = (time.perf_counter() - streaming_start) * 1000
                    first_token_logged = True
                    token_type = "content" if content_delta else "thinking"
                    _perf.log_sync(
                        "time_to_first_token",
                        first_token_ms,
                        context.agent_name,
                        context.room_id,
                        token_type=token_type,
                    )

                # Update session if found
                if parsed.session_id:
                    new_session_id = parsed.session_id

                # Update skip flag
                if parsed.skip_used:
                    skip_tool_called = True

                # Collect memory entries
                memory_entries.extend(parsed.memory_entries)

                # Capture structured output if present
                if parsed.structured_output:
                    structured_output = parsed.structured_output
                    logger.info(f"📊 Captured structured output for {context.agent_name}")

                # Update accumulated text
                response_text = parsed.response_text
                thinking_text = parsed.thinking_text

                # Update streaming state for polling access
                await self.streaming_state.update(task_id, thinking_text, response_text)

                # Yield delta events for content and thinking
                if content_delta:
                    logger.info(f"🔄 YIELDING content delta | Length: {len(content_delta)}")
                    yield {
                        "type": "content_delta",
                        "delta": content_delta,
                        "temp_id": temp_id,
                    }

                if thinking_delta:
                    logger.info(f"🔄 YIELDING thinking delta | Length: {len(thinking_delta)}")
                    yield {
                        "type": "thinking_delta",
                        "delta": thinking_delta,
                        "temp_id": temp_id,
                    }

                # Debug log each message received from the SDK
                # Configuration loaded from debug.yaml
                if DEBUG_MODE:
                    # Get streaming config from debug.yaml
                    config = get_debug_config()
                    streaming_config = config.get("debug", {}).get("logging", {}).get("streaming", {})

                    if streaming_config.get("enabled", True):
                        # Skip system init messages if configured
                        is_system_init = (
                            message.__class__.__name__ == "SystemMessage"
                            and hasattr(message, "subtype")
                            and message.subtype == "init"
                        )
                        skip_system_init = streaming_config.get("skip_system_init", True)

                        if not (is_system_init and skip_system_init):
                            logger.debug(f"📨 Received message:\n{format_message_for_debug(message)}")

                # Break after ResultMessage - this is the final message for our request
                if is_result_message:
                    logger.debug(f"Received ResultMessage for task: {task_id}")
                    break

            # Update pooled client's session_id to match the new session from SDK response
            if new_session_id and pooled.session_id != new_session_id:
                logger.debug(f"Updating pooled session_id: {pooled.session_id} -> {new_session_id}")
                pooled.session_id = new_session_id

            # Unregister the client when done
            if context.task_id and context.task_id in self.active_clients:
                del self.active_clients[context.task_id]
                logger.debug(f"Unregistered client for task: {context.task_id}")

            # Clean up streaming state
            await self.streaming_state.clear(task_id)

            # Log response summary
            final_response = response_text if response_text else None
            if skip_tool_called:
                logger.info(f"⏭️  Agent skipped | Session: {new_session_id}")
                final_response = None
            else:
                logger.info(
                    f"✅ Response generated | Length: {len(response_text)} chars | Thinking: {len(thinking_text)} chars | Session: {new_session_id}"
                )
            if memory_entries:
                logger.info(f"💾 Recorded {len(memory_entries)} memory entries")
            if anthropic_calls:
                logger.info(f"🔒 Agent called anthropic {len(anthropic_calls)} times: {anthropic_calls}")

            # Append response to debug log
            append_response_to_debug_log(
                agent_name=context.agent_name,
                task_id=context.task_id or "default",
                response_text=final_response or "",
                thinking_text=thinking_text,
                skipped=skip_tool_called,
            )

            # Yield stream_end event with final data
            yield {
                "type": "stream_end",
                "temp_id": temp_id,
                "response_text": final_response,
                "thinking_text": thinking_text,
                "session_id": new_session_id,
                "memory_entries": memory_entries,
                "anthropic_calls": anthropic_calls,
                "skipped": skip_tool_called,
                "structured_output": structured_output,
            }

        except asyncio.CancelledError:
            # Task was cancelled due to interruption - this is expected
            # Clean up client from active_clients (but keep it in pool for reuse)
            if context.task_id and context.task_id in self.active_clients:
                del self.active_clients[context.task_id]
                logger.debug(f"Unregistered client for task (interrupted): {context.task_id}")

            # Clean up streaming state
            await self.streaming_state.clear(task_id)

            logger.info(f"🛑 Agent response interrupted | Task: {context.task_id}")
            # Yield stream_end to indicate interruption
            yield {
                "type": "stream_end",
                "temp_id": temp_id,
                "response_text": None,
                "thinking_text": "",
                "session_id": context.session_id,
                "memory_entries": [],
                "anthropic_calls": [],
                "skipped": True,
            }

        except Exception as e:
            # Clean up client on error
            if context.task_id and context.task_id in self.active_clients:
                del self.active_clients[context.task_id]
                logger.debug(f"Unregistered client for task (error cleanup): {context.task_id}")

            # Clean up streaming state
            await self.streaming_state.clear(task_id)

            # Check if this is an interruption-related error
            error_str = str(e).lower()
            if "interrupt" in error_str or "cancelled" in error_str:
                logger.info(f"🛑 Agent response interrupted | Task: {context.task_id}")
                # Yield stream_end to indicate interruption
                yield {
                    "type": "stream_end",
                    "temp_id": temp_id,
                    "response_text": None,
                    "thinking_text": "",
                    "session_id": context.session_id,
                    "memory_entries": [],
                    "anthropic_calls": [],
                    "skipped": True,
                }
                return

            # Remove client from pool on any error to ensure fresh client next time
            # task_id was already created at the beginning of the function
            if task_id in self.client_pool.pool:
                # Use cleanup to properly disconnect in background task
                await self.client_pool.cleanup(task_id)

            # Always log full traceback for KeyError to help debug item_id issues
            if isinstance(e, KeyError):
                logger.error(f"❌ Error generating response (KeyError): {str(e)}", exc_info=True)
            else:
                logger.error(f"❌ Error generating response: {str(e)}", exc_info=DEBUG_MODE)
            # Yield error as stream_end
            yield {
                "type": "stream_end",
                "temp_id": temp_id,
                "response_text": f"Error generating response: {str(e)}",
                "thinking_text": "",
                "session_id": context.session_id,
                "memory_entries": [],
                "anthropic_calls": [],
                "skipped": False,
            }
