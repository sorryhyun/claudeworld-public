"""
Background scheduler for autonomous agent chat rounds.

This module runs periodic tasks to process agent conversations in active rooms,
enabling background chatroom interactions when users are not actively viewing.

Architecture note:
- The scheduler identifies active rooms that need processing
- It delegates actual orchestration to ChatOrchestrator.process_autonomous_round()
- Game rooms (rooms with world_id) are excluded - they use TRPGOrchestrator instead
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from orchestration import ChatOrchestrator
from sdk import AgentManager
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload

from infrastructure.database import models

logger = logging.getLogger("BackgroundScheduler")

# Suppress noisy APScheduler "max instances reached" warnings
# These are expected during heavy load and not actionable
logging.getLogger("apscheduler.scheduler").setLevel(logging.ERROR)


class BackgroundScheduler:
    """Manages background tasks for autonomous agent conversations."""

    def __init__(
        self,
        chat_orchestrator: ChatOrchestrator,
        agent_manager: AgentManager,
        get_db_session,
        max_concurrent_rooms: int = 5,
    ):
        self.scheduler = AsyncIOScheduler()
        self.chat_orchestrator = chat_orchestrator
        self.agent_manager = agent_manager
        self.get_db_session = get_db_session
        self.max_concurrent_rooms = max_concurrent_rooms
        self.is_running = False
        # Create semaphore once to properly enforce concurrent room limit
        self._room_semaphore = asyncio.Semaphore(max_concurrent_rooms) if max_concurrent_rooms else None

    def start(self):
        """Start the background scheduler."""
        if not self.is_running:
            # Run autonomous chat rounds every 2 seconds
            self.scheduler.add_job(
                self._process_active_rooms,
                "interval",
                seconds=2,
                id="process_active_rooms",
                replace_existing=True,
                max_instances=1,  # Only one instance at a time (prevents overwhelming system)
                coalesce=True,  # Skip missed runs if previous job still running
                misfire_grace_time=None,  # Never misfire - just skip if busy (suppresses warnings)
            )

            # Clean up expired cache entries every 5 minutes
            self.scheduler.add_job(
                self._cleanup_cache, "interval", minutes=5, id="cleanup_cache", replace_existing=True
            )

            self.scheduler.start()
            self.is_running = True
            logger.info(
                "🚀 Background scheduler started - processing rooms every 2 seconds, cache cleanup every 5 minutes"
            )

    def stop(self):
        """Stop the background scheduler."""
        if self.is_running:
            self.scheduler.shutdown()
            self.is_running = False
            logger.info("🛑 Background scheduler stopped")

    async def _process_active_rooms(self):
        """
        Process autonomous chat rounds for all active rooms.

        A room is considered active if:
        - It has messages in the last 5 minutes
        - It's not paused
        - It has at least 2 agents
        """
        try:
            async with self._session_scope() as db:
                active_rooms = await self._get_active_rooms(db)

            if not active_rooms:
                # Don't log when there's no activity (too noisy)
                return

            logger.info(f"🔄 Processing {len(active_rooms)} active room(s)")

            async def process_with_error_handling(room):
                try:
                    if self._room_semaphore:
                        async with self._room_semaphore:
                            await self._process_room_for_background_job(room)
                    else:
                        await self._process_room_for_background_job(room)
                except Exception as e:
                    logger.error(f"❌ Error processing room {room.id}: {e}")
                    import traceback

                    traceback.print_exc()

            # Process all active rooms concurrently with a small cap
            await asyncio.gather(*[process_with_error_handling(room) for room in active_rooms])

        except Exception as e:
            logger.error(f"💥 Error in _process_active_rooms: {e}")
            import traceback

            traceback.print_exc()

    @asynccontextmanager
    async def _session_scope(self):
        """
        Provides a database session with proper transaction handling.

        - Commits on successful completion
        - Rolls back on any exception
        - Always closes the session properly
        """
        session_gen = self.get_db_session()
        session = await anext(session_gen)
        try:
            yield session
            await session.commit()  # Explicit commit on success
        except Exception:
            await session.rollback()  # Explicit rollback on error
            raise
        finally:
            try:
                await session_gen.aclose()
            except Exception as e:
                logger.error(f"Error closing database session: {e}")

    async def _process_room_for_background_job(self, room: models.Room):
        async with self._session_scope() as room_db:
            await self._process_room_autonomous_round(room_db, room)

    async def _get_active_rooms(self, db: AsyncSession) -> list:
        """
        Get rooms that should have autonomous agent interactions.

        Criteria:
        - Has messages in the last 5 minutes
        - Not paused
        - Not finished (all agents haven't skipped)
        - Has at least 2 agents
        """
        # Calculate cutoff time (5 minutes ago)
        cutoff_time = datetime.now(timezone.utc) - timedelta(minutes=5)

        # Use the room's last_activity_at field to avoid repeated full message scans
        # Exclude game rooms (rooms with world_id) - they use TRPGOrchestrator, not ChatOrchestrator
        stmt = (
            select(models.Room)
            .options(selectinload(models.Room.agents))  # Eager load agents
            .where(
                models.Room.is_paused == False,
                models.Room.is_finished == False,
                models.Room.last_activity_at >= cutoff_time,
                models.Room.world_id.is_(None),  # Exclude TRPG game rooms
            )
            .order_by(models.Room.last_activity_at.desc())
        )

        # Optionally cap the number of rooms fetched to reduce load during spikes
        if self.max_concurrent_rooms:
            stmt = stmt.limit(self.max_concurrent_rooms)

        result = await db.execute(stmt)
        rooms = result.scalars().all()

        # Filter rooms with at least 2 agents (agents already loaded via selectinload)
        active_rooms = [room for room in rooms if len(room.agents) >= 2]

        return active_rooms

    def _cleanup_completed_tasks(self):
        """Remove completed tasks from active_room_tasks to prevent memory leak."""
        completed_rooms = [room_id for room_id, task in self.chat_orchestrator.active_room_tasks.items() if task.done()]
        for room_id in completed_rooms:
            del self.chat_orchestrator.active_room_tasks[room_id]
            logger.debug(f"Cleaned up completed task for room {room_id}")

    async def _process_room_autonomous_round(self, db, room: models.Room):
        """
        Process one autonomous round for a room.

        Delegates to ChatOrchestrator.process_autonomous_round() which handles
        the tape-based scheduling logic. This keeps orchestration logic centralized.
        """
        # Clean up completed tasks before processing
        self._cleanup_completed_tasks()

        # Delegate to ChatOrchestrator for the actual orchestration
        await self.chat_orchestrator.process_autonomous_round(
            db=db,
            room=room,
            agent_manager=self.agent_manager,
        )

    async def _cleanup_cache(self):
        """
        Clean up expired cache entries and stale orchestrator/agent state.
        This runs every 5 minutes to prevent memory bloat.
        """
        try:
            from infrastructure.cache import get_cache

            cache = get_cache()
            cache.cleanup_expired()
            cache.log_stats()

            # Clean up stale orchestrator entries to prevent memory leaks
            self.chat_orchestrator.cleanup_stale_entries()

            # Clean up stale agent manager resources (task locks, etc.)
            self.agent_manager.cleanup_stale_resources()
        except Exception as e:
            logger.error(f"Error during cache cleanup: {e}")
