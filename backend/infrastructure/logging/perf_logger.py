"""
Performance logging utility for tracking agent interaction latencies.

This module provides timing instrumentation for gameplay bottleneck analysis.
Enable with PERF_LOG=true environment variable or use `make dev-perf`.

Output: latency.log (in project root)
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger("PerfLogger")

# Check if performance logging is enabled
PERF_LOG_ENABLED = os.environ.get("PERF_LOG", "").lower() in ("true", "1", "yes")

# Log file path (project root)
LOG_FILE_PATH = Path(__file__).parent.parent.parent.parent / "latency.log"


@dataclass
class TimingEntry:
    """Single timing entry for latency tracking."""

    phase: str
    agent_name: Optional[str]
    duration_ms: float
    start_time: datetime
    end_time: datetime
    room_id: Optional[int] = None
    extra: dict = field(default_factory=dict)

    def to_log_line(self) -> str:
        """Format as a log line for latency.log."""
        timestamp = self.start_time.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        agent_str = f" [{self.agent_name}]" if self.agent_name else ""
        room_str = f" room={self.room_id}" if self.room_id else ""
        extra_str = " ".join(f"{k}={v}" for k, v in self.extra.items())
        if extra_str:
            extra_str = f" {extra_str}"

        return f"{timestamp} | {self.phase:30}{agent_str}{room_str} | {self.duration_ms:8.2f}ms{extra_str}"


class PerfLogger:
    """
    Performance logger for tracking latencies between agent interactions.

    Usage:
        perf = get_perf_logger()
        async with perf.track("sdk_response", agent_name="Narrator", room_id=1):
            await some_async_operation()
    """

    def __init__(self, enabled: bool = PERF_LOG_ENABLED):
        self.enabled = enabled
        self._lock = asyncio.Lock()
        self._entries: list[TimingEntry] = []
        self._interaction_count = 0
        self._session_start = datetime.now()

        if self.enabled:
            self._init_log_file()

    def _init_log_file(self):
        """Initialize or append to latency.log with session header."""
        with open(LOG_FILE_PATH, "a") as f:
            f.write(f"\n{'=' * 80}\n")
            f.write(f"Performance Logging Session Started: {self._session_start.isoformat()}\n")
            f.write(f"{'=' * 80}\n\n")

    async def _write_entry(self, entry: TimingEntry):
        """Write a timing entry to the log file."""
        if not self.enabled:
            return

        async with self._lock:
            with open(LOG_FILE_PATH, "a") as f:
                f.write(entry.to_log_line() + "\n")
            # Log to console as well
            logger.info(f"⏱️  {entry.to_log_line()}")

    def _create_entry(
        self,
        phase: str,
        agent_name: Optional[str] = None,
        room_id: Optional[int] = None,
        duration_ms: float = 0.0,
        **extra,
    ) -> TimingEntry:
        """Create a timing entry with a custom duration (for manual timing)."""
        now = datetime.now()
        return TimingEntry(
            phase=phase,
            agent_name=agent_name,
            duration_ms=duration_ms,
            start_time=now,
            end_time=now,
            room_id=room_id,
            extra=extra,
        )

    @asynccontextmanager
    async def track(
        self,
        phase: str,
        agent_name: Optional[str] = None,
        room_id: Optional[int] = None,
        **extra,
    ):
        """
        Async context manager for tracking operation timing.

        Args:
            phase: Name of the phase being tracked (e.g., "sdk_response", "tape_cell")
            agent_name: Optional agent name for agent-specific operations
            room_id: Optional room ID for room-specific tracking
            **extra: Additional metadata to include in the log
        """
        if not self.enabled:
            yield
            return

        start_time = datetime.now()
        start_perf = time.perf_counter()

        try:
            yield
        finally:
            end_perf = time.perf_counter()
            end_time = datetime.now()
            duration_ms = (end_perf - start_perf) * 1000

            entry = TimingEntry(
                phase=phase,
                agent_name=agent_name,
                duration_ms=duration_ms,
                start_time=start_time,
                end_time=end_time,
                room_id=room_id,
                extra=extra,
            )

            self._entries.append(entry)
            await self._write_entry(entry)

    def log_sync(
        self,
        phase: str,
        duration_ms: float,
        agent_name: Optional[str] = None,
        room_id: Optional[int] = None,
        **extra,
    ) -> None:
        """
        Log a timing entry synchronously (when duration already measured).

        Use this when you've measured duration externally and need to log
        from a synchronous context.

        Args:
            phase: Name of the phase being tracked
            duration_ms: Pre-calculated duration in milliseconds
            agent_name: Optional agent name
            room_id: Optional room ID
            **extra: Additional metadata
        """
        if not self.enabled:
            return

        now = datetime.now()
        entry = TimingEntry(
            phase=phase,
            agent_name=agent_name,
            duration_ms=duration_ms,
            start_time=now,
            end_time=now,
            room_id=room_id,
            extra=extra,
        )

        self._entries.append(entry)
        with open(LOG_FILE_PATH, "a") as f:
            f.write(entry.to_log_line() + "\n")
        logger.info(f"⏱️  {entry.to_log_line()}")

    async def log_async(
        self,
        phase: str,
        duration_ms: float,
        agent_name: Optional[str] = None,
        room_id: Optional[int] = None,
        **extra,
    ) -> None:
        """
        Log a timing entry asynchronously (when duration already measured).

        Use this when you've measured duration externally and need to log
        from an async context.

        Args:
            phase: Name of the phase being tracked
            duration_ms: Pre-calculated duration in milliseconds
            agent_name: Optional agent name
            room_id: Optional room ID
            **extra: Additional metadata
        """
        if not self.enabled:
            return

        now = datetime.now()
        entry = TimingEntry(
            phase=phase,
            agent_name=agent_name,
            duration_ms=duration_ms,
            start_time=now,
            end_time=now,
            room_id=room_id,
            extra=extra,
        )

        self._entries.append(entry)
        await self._write_entry(entry)

    def track_sync(
        self,
        phase: str,
        agent_name: Optional[str] = None,
        room_id: Optional[int] = None,
        **extra,
    ) -> Callable:
        """
        Decorator for tracking synchronous function timing.

        Args:
            phase: Name of the phase being tracked
            agent_name: Optional agent name
            room_id: Optional room ID
            **extra: Additional metadata
        """

        def decorator(func: Callable) -> Callable:
            @wraps(func)
            def wrapper(*args, **kwargs):
                if not self.enabled:
                    return func(*args, **kwargs)

                start_time = datetime.now()
                start_perf = time.perf_counter()

                try:
                    return func(*args, **kwargs)
                finally:
                    end_perf = time.perf_counter()
                    end_time = datetime.now()
                    duration_ms = (end_perf - start_perf) * 1000

                    entry = TimingEntry(
                        phase=phase,
                        agent_name=agent_name,
                        duration_ms=duration_ms,
                        start_time=start_time,
                        end_time=end_time,
                        room_id=room_id,
                        extra=extra,
                    )

                    self._entries.append(entry)
                    # Write synchronously for sync functions
                    with open(LOG_FILE_PATH, "a") as f:
                        f.write(entry.to_log_line() + "\n")

                    logger.info(f"⏱️  {entry.to_log_line()}")

            return wrapper

        return decorator

    async def log_interaction_start(self, room_id: int, user_message: str):
        """Log the start of a user interaction (action submission)."""
        if not self.enabled:
            return

        self._interaction_count += 1
        async with self._lock:
            with open(LOG_FILE_PATH, "a") as f:
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                f.write(f"\n--- Interaction #{self._interaction_count} | Room {room_id} ---\n")
                f.write(f"{timestamp} | USER_ACTION                    | msg_len={len(user_message)}\n")

    async def log_interaction_end(self, room_id: int, total_duration_ms: float, agent_count: int):
        """Log the end of a user interaction (all agents responded)."""
        if not self.enabled:
            return

        async with self._lock:
            with open(LOG_FILE_PATH, "a") as f:
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                f.write(
                    f"{timestamp} | INTERACTION_COMPLETE           | {total_duration_ms:8.2f}ms | agents={agent_count}\n"
                )
                f.write(f"--- End Interaction #{self._interaction_count} ---\n\n")

    def get_summary(self) -> dict[str, Any]:
        """Get summary statistics for the current session."""
        if not self._entries:
            return {"total_entries": 0}

        phases = {}
        for entry in self._entries:
            if entry.phase not in phases:
                phases[entry.phase] = []
            phases[entry.phase].append(entry.duration_ms)

        summary = {
            "total_entries": len(self._entries),
            "session_duration_s": (datetime.now() - self._session_start).total_seconds(),
            "interactions": self._interaction_count,
            "phases": {},
        }

        for phase, durations in phases.items():
            summary["phases"][phase] = {
                "count": len(durations),
                "total_ms": sum(durations),
                "avg_ms": sum(durations) / len(durations),
                "min_ms": min(durations),
                "max_ms": max(durations),
            }

        return summary

    async def write_summary(self):
        """Write session summary to log file."""
        if not self.enabled:
            return

        summary = self.get_summary()

        async with self._lock:
            with open(LOG_FILE_PATH, "a") as f:
                f.write(f"\n{'=' * 80}\n")
                f.write("Session Summary\n")
                f.write(f"{'=' * 80}\n")
                f.write(f"Total entries: {summary['total_entries']}\n")
                f.write(f"Session duration: {summary['session_duration_s']:.2f}s\n")
                f.write(f"Total interactions: {summary['interactions']}\n")
                f.write("\nPhase Breakdown:\n")

                for phase, stats in summary.get("phases", {}).items():
                    f.write(f"  {phase}:\n")
                    f.write(f"    count: {stats['count']}\n")
                    f.write(f"    total: {stats['total_ms']:.2f}ms\n")
                    f.write(f"    avg: {stats['avg_ms']:.2f}ms\n")
                    f.write(f"    min: {stats['min_ms']:.2f}ms\n")
                    f.write(f"    max: {stats['max_ms']:.2f}ms\n")

                f.write(f"{'=' * 80}\n\n")


# Singleton instance
_perf_logger: Optional[PerfLogger] = None


def get_perf_logger() -> PerfLogger:
    """Get the singleton performance logger instance."""
    global _perf_logger
    if _perf_logger is None:
        _perf_logger = PerfLogger()
    return _perf_logger


def is_perf_logging_enabled() -> bool:
    """Check if performance logging is enabled."""
    return PERF_LOG_ENABLED
