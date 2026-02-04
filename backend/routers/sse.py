"""
SSE (Server-Sent Events) endpoint for real-time streaming.

Provides:
- POST /rooms/{room_id}/stream/ticket - Get a single-use SSE auth ticket
- GET /rooms/{room_id}/stream?ticket=... - SSE event stream
"""

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, Request, status
from infrastructure.sse import EventBroadcaster
from infrastructure.sse_ticket import SSETicketManager
from sse_starlette.sse import EventSourceResponse

logger = logging.getLogger(__name__)

router = APIRouter()

KEEPALIVE_INTERVAL = 15  # seconds


def _get_broadcaster(request: Request) -> EventBroadcaster:
    return request.app.state.event_broadcaster


def _get_ticket_manager(request: Request) -> SSETicketManager:
    return request.app.state.sse_ticket_manager


@router.post("/{room_id}/stream/ticket")
async def create_stream_ticket(room_id: int, request: Request):
    """
    Create a single-use ticket for SSE authentication.

    Requires JWT auth (X-API-Key header). The returned ticket is used
    as a query parameter for the SSE endpoint since EventSource API
    cannot send custom headers.
    """
    # Auth info is injected by middleware into request.state
    user_id = getattr(request.state, "user_id", None)
    user_role = getattr(request.state, "user_role", None)

    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    ticket_manager = _get_ticket_manager(request)
    ticket = ticket_manager.create_ticket(user_id=user_id, role=user_role or "admin", room_id=room_id)

    return {"ticket": ticket}


@router.get("/{room_id}/stream")
async def stream_events(room_id: int, ticket: str, request: Request):
    """
    SSE endpoint for real-time event streaming.

    Authenticated via single-use ticket (from POST /stream/ticket).
    Streams events: stream_start, content_delta, thinking_delta, stream_end, new_message, keepalive.
    """
    ticket_manager = _get_ticket_manager(request)
    ticket_data = ticket_manager.validate_ticket(ticket, room_id)

    if not ticket_data:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired ticket")

    broadcaster = _get_broadcaster(request)

    # Get streaming state manager for catch-up events
    agent_manager = request.app.state.agent_manager
    streaming_state = await agent_manager.get_streaming_state_for_room(room_id)

    async def event_generator():
        queue = broadcaster.subscribe(room_id)
        try:
            # Send catch-up events for agents already streaming
            if streaming_state:
                for agent_id, state in streaming_state.items():
                    catch_up = {
                        "type": "catch_up",
                        "agent_id": agent_id,
                        "agent_name": state.get("agent_name", ""),
                        "thinking_text": state.get("thinking_text", ""),
                        "response_text": state.get("response_text", ""),
                    }
                    yield {"event": "catch_up", "data": json.dumps(catch_up)}

            # Send connected confirmation
            yield {"event": "connected", "data": json.dumps({"room_id": room_id})}

            while not broadcaster.shutdown_event.is_set():
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_INTERVAL)
                    if data is None:
                        # Shutdown sentinel
                        break
                    # data is already a JSON string from broadcaster
                    parsed = json.loads(data)
                    event_type = parsed.get("type", "message")
                    yield {"event": event_type, "data": data}
                except asyncio.TimeoutError:
                    # Send keepalive to prevent connection timeout
                    yield {"event": "keepalive", "data": ""}
                except asyncio.CancelledError:
                    break
        finally:
            broadcaster.unsubscribe(room_id, queue)

    return EventSourceResponse(event_generator())
