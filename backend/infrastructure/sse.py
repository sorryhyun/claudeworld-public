"""
Server-Sent Events (SSE) broadcaster for real-time streaming.

Manages per-room subscriber queues and broadcasts streaming events
from agent responses to connected SSE clients.
"""

import asyncio
import json
import logging
from collections import defaultdict

logger = logging.getLogger(__name__)


class EventBroadcaster:
    """
    Per-room SSE event broadcaster using asyncio.Queue per client.

    Each SSE client subscribes to a room and receives events via its own queue.
    Broadcasts are non-blocking (put_nowait) to avoid blocking agent generation.
    """

    def __init__(self, max_queue_size: int = 256):
        self._subscribers: dict[int, set[asyncio.Queue]] = defaultdict(set)
        self._max_queue_size = max_queue_size
        self._shutdown_event = asyncio.Event()

    def subscribe(self, room_id: int) -> asyncio.Queue:
        """Create a new subscriber queue for a room."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=self._max_queue_size)
        self._subscribers[room_id].add(queue)
        logger.debug(f"SSE subscriber added for room {room_id} (total: {len(self._subscribers[room_id])})")
        return queue

    def unsubscribe(self, room_id: int, queue: asyncio.Queue) -> None:
        """Remove a subscriber queue from a room."""
        subs = self._subscribers.get(room_id)
        if subs:
            subs.discard(queue)
            if not subs:
                del self._subscribers[room_id]
        logger.debug(
            f"SSE subscriber removed for room {room_id} "
            f"(remaining: {len(self._subscribers.get(room_id, set()))})"
        )

    def broadcast(self, room_id: int, event: dict) -> None:
        """
        Broadcast an event to all subscribers of a room.

        Non-blocking: drops events if a subscriber's queue is full
        rather than blocking the agent generation pipeline.
        """
        subs = self._subscribers.get(room_id)
        if not subs:
            return

        data = json.dumps(event)
        for queue in subs:
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                logger.warning(f"SSE queue full for room {room_id}, dropping event type={event.get('type')}")

    def get_subscriber_count(self, room_id: int) -> int:
        """Get the number of active subscribers for a room."""
        return len(self._subscribers.get(room_id, set()))

    def has_subscribers(self, room_id: int) -> bool:
        """Check if a room has any active SSE subscribers."""
        return bool(self._subscribers.get(room_id))

    @property
    def shutdown_event(self) -> asyncio.Event:
        """Event that is set when the server is shutting down."""
        return self._shutdown_event

    def shutdown(self) -> None:
        """Signal all SSE connections to terminate."""
        self._shutdown_event.set()
        # Wake up all subscriber queues so they can exit
        for room_subs in self._subscribers.values():
            for queue in room_subs:
                try:
                    queue.put_nowait(None)
                except asyncio.QueueFull:
                    pass
        logger.info("SSE broadcaster shutdown signalled")
