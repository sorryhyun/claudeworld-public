"""
Streaming state management for agent response generation.

This module provides the StreamingStateManager class which tracks the current
thinking and response text during agent response streaming, enabling real-time
polling access to partial responses.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from domain.value_objects.task_identifier import TaskIdentifier


class StreamingStateManager:
    """
    Manages streaming state for agent response generation.

    Tracks current thinking/response text per task during generation,
    enabling real-time polling access to partial responses.

    Thread-safe: All operations are synchronized via an asyncio lock.
    """

    def __init__(self):
        """Initialize the streaming state manager."""
        self._state: dict[TaskIdentifier, dict] = {}
        self._lock = asyncio.Lock()

    async def init(self, task_id: TaskIdentifier, agent_name: str = "", hidden: bool = False) -> None:
        """
        Initialize streaming state for a task.

        Args:
            task_id: Task identifier to initialize state for
            agent_name: Agent name for catch-up events
            hidden: If True, suppress response_text (for hidden agents like NPC reactions)
        """
        async with self._lock:
            self._state[task_id] = {"thinking_text": "", "response_text": "", "narration_text": "", "agent_name": agent_name, "hidden": hidden}

    async def update(self, task_id: TaskIdentifier, thinking_text: str, response_text: str) -> None:
        """
        Update streaming state for a task if it still exists.

        Args:
            task_id: Task identifier to update
            thinking_text: Current accumulated thinking text
            response_text: Current accumulated response text
        """
        async with self._lock:
            if task_id in self._state:
                self._state[task_id]["thinking_text"] = thinking_text
                # Don't expose response_text for hidden agents (e.g., NPC reactions)
                if not self._state[task_id].get("hidden"):
                    self._state[task_id]["response_text"] = response_text

    async def update_narration(self, task_id: TaskIdentifier, narration_text: str) -> None:
        """
        Update narration text for a task if it still exists.

        Args:
            task_id: Task identifier to update
            narration_text: Current accumulated narration text
        """
        async with self._lock:
            if task_id in self._state:
                self._state[task_id]["narration_text"] = narration_text

    async def clear(self, task_id: TaskIdentifier) -> None:
        """
        Clear streaming state for a task.

        Args:
            task_id: Task identifier to clear state for
        """
        async with self._lock:
            if task_id in self._state:
                del self._state[task_id]

    async def get_for_room(self, room_id: int) -> dict[int, dict]:
        """
        Get current streaming state for all agents in a room.

        Args:
            room_id: Room ID to get state for

        Returns:
            Dict mapping agent_id to their current streaming state
            Example: {1: {"thinking_text": "...", "response_text": "..."}}
        """
        async with self._lock:
            result = {}
            for task_id, state in self._state.items():
                if task_id.room_id == room_id:
                    # Return a copy to prevent external mutation
                    result[task_id.agent_id] = {
                        "thinking_text": state.get("thinking_text", ""),
                        "response_text": state.get("response_text", ""),
                        "narration_text": state.get("narration_text", ""),
                        "agent_name": state.get("agent_name", ""),
                    }
            return result

    async def get_and_clear_for_room(self, room_id: int) -> dict[int, dict]:
        """
        Get and clear streaming state for all agents in a room.

        Used during interrupt to capture partial responses before clearing state.
        This ensures we can save any in-progress responses to DB.

        Args:
            room_id: Room ID to get and clear state for

        Returns:
            Dict mapping agent_id to their streaming state (thinking_text, response_text)
        """
        async with self._lock:
            result = {}
            task_ids_to_clear = []

            for task_id, state in self._state.items():
                if task_id.room_id == room_id:
                    # Copy the state (don't just reference it)
                    result[task_id.agent_id] = {
                        "thinking_text": state.get("thinking_text", ""),
                        "response_text": state.get("response_text", ""),
                    }
                    task_ids_to_clear.append(task_id)

            # Clear the streaming state for these tasks
            for task_id in task_ids_to_clear:
                del self._state[task_id]

            return result
