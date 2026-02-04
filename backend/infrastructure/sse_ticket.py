"""
SSE ticket authentication manager.

Provides short-lived, single-use tickets for SSE connections.
Needed because the EventSource API cannot send custom headers (no JWT in URL).
"""

import logging
import secrets
import time

logger = logging.getLogger(__name__)

TICKET_TTL = 60  # Tickets expire after 60 seconds
CLEANUP_INTERVAL = 300  # Clean expired tickets every 5 minutes


class TicketData:
    """Data associated with an SSE ticket."""

    __slots__ = ("user_id", "role", "room_id", "created_at")

    def __init__(self, user_id: str, role: str, room_id: int):
        self.user_id = user_id
        self.role = role
        self.room_id = room_id
        self.created_at = time.monotonic()


class SSETicketManager:
    """
    Manages short-lived, single-use tickets for SSE authentication.

    Flow:
    1. Client calls POST /rooms/{room_id}/stream/ticket with JWT auth
    2. Server issues a ticket (random token valid for 60s)
    3. Client connects to GET /rooms/{room_id}/stream?ticket=...
    4. Server validates and consumes the ticket (single-use)
    """

    def __init__(self):
        self._tickets: dict[str, TicketData] = {}
        self._last_cleanup = time.monotonic()

    def create_ticket(self, user_id: str, role: str, room_id: int) -> str:
        """
        Create a short-lived, single-use ticket for SSE auth.

        Args:
            user_id: Authenticated user ID from JWT
            role: User role from JWT (admin/guest)
            room_id: Room the ticket is valid for

        Returns:
            Ticket string (URL-safe token)
        """
        self._maybe_cleanup()
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = TicketData(user_id=user_id, role=role, room_id=room_id)
        logger.debug(f"SSE ticket created for user={user_id} room={room_id}")
        return ticket

    def validate_ticket(self, ticket: str, room_id: int) -> TicketData | None:
        """
        Validate and consume a ticket (single-use).

        Args:
            ticket: The ticket string to validate
            room_id: The room ID the connection is for (must match ticket)

        Returns:
            TicketData if valid, None otherwise
        """
        data = self._tickets.pop(ticket, None)
        if data is None:
            return None

        # Check expiration
        if time.monotonic() - data.created_at > TICKET_TTL:
            logger.debug("SSE ticket expired")
            return None

        # Check room_id matches
        if data.room_id != room_id:
            logger.warning(f"SSE ticket room mismatch: ticket={data.room_id} request={room_id}")
            return None

        return data

    def _maybe_cleanup(self) -> None:
        """Periodically remove expired tickets."""
        now = time.monotonic()
        if now - self._last_cleanup < CLEANUP_INTERVAL:
            return

        self._last_cleanup = now
        expired = [
            ticket
            for ticket, data in self._tickets.items()
            if now - data.created_at > TICKET_TTL
        ]
        for ticket in expired:
            del self._tickets[ticket]

        if expired:
            logger.debug(f"Cleaned up {len(expired)} expired SSE tickets")
