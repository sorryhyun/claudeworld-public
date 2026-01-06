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


def _get_log_file_path() -> Path:
    """Get log file path, handling PyInstaller bundles."""
    import sys

    if getattr(sys, "frozen", False):
        # In bundled mode, use working directory
        return Path.cwd() / "latency.log"
    else:
        # In dev mode, use project root
        return Path(__file__).parent.parent.parent.parent / "latency.log"


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
        with open(_get_log_file_path(), "a") as f:
            f.write(f"\n{'=' * 80}\n")
            f.write(f"Performance Logging Session Started: {self._session_start.isoformat()}\n")
            f.write(f"{'=' * 80}\n\n")

    async def _write_entry(self, entry: TimingEntry):
        """Write a timing entry to the log file."""
        if not self.enabled:
            return

        async with self._lock:
            with open(_get_log_file_path(), "a") as f:
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
        with open(_get_log_file_path(), "a") as f:
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
                    with open(_get_log_file_path(), "a") as f:
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
            with open(_get_log_file_path(), "a") as f:
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                f.write(f"\n--- Interaction #{self._interaction_count} | Room {room_id} ---\n")
                f.write(f"{timestamp} | USER_ACTION                    | msg_len={len(user_message)}\n")

    async def log_interaction_end(self, room_id: int, total_duration_ms: float, agent_count: int):
        """Log the end of a user interaction (all agents responded)."""
        if not self.enabled:
            return

        async with self._lock:
            with open(_get_log_file_path(), "a") as f:
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
            with open(_get_log_file_path(), "a") as f:
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


# =============================================================================
# Reusable Decorators
# =============================================================================


def _extract_context_from_args(
    args: tuple,
    kwargs: dict,
    room_id_param: str | None,
    agent_name_param: str | None,
    func: Callable,
) -> tuple[int | None, str | None]:
    """
    Extract room_id and agent_name from function arguments.

    Supports:
    - Direct parameters: room_id=0, agent_name="ctx"
    - Nested access: room_id="ctx.room_id", agent_name="ctx.agent_name"
    - ToolContext objects: auto-detects ctx parameter
    """
    import inspect

    sig = inspect.signature(func)
    bound = sig.bind_partial(*args, **kwargs)
    bound.apply_defaults()
    all_args = bound.arguments

    def get_value(param_spec: str | None) -> Any:
        if not param_spec:
            return None
        # Handle nested access like "ctx.room_id"
        parts = param_spec.split(".")
        value = all_args.get(parts[0])
        for part in parts[1:]:
            if value is None:
                return None
            value = getattr(value, part, None)
        return value

    room_id = get_value(room_id_param)
    agent_name = get_value(agent_name_param)

    # Auto-detect from common context objects if not explicitly specified
    if room_id is None or agent_name is None:
        for arg_name, arg_value in all_args.items():
            if arg_value is None:
                continue
            # Check for ToolContext or similar context objects
            if hasattr(arg_value, "room_id") and room_id is None:
                room_id = getattr(arg_value, "room_id", None)
            if hasattr(arg_value, "agent_name") and agent_name is None:
                agent_name = getattr(arg_value, "agent_name", None)
            # Check for 'ctx' dict with room_id/agent_name keys
            if isinstance(arg_value, dict):
                if room_id is None:
                    room_id = arg_value.get("room_id")
                if agent_name is None:
                    agent_name = arg_value.get("agent_name")

    return room_id, agent_name


def track_perf(
    phase: str | None = None,
    *,
    room_id: str | int | Callable[[], int | None] | None = None,
    agent_name: str | Callable[[], str | None] | None = None,
    include_result: bool = False,
    extra_from_result: Callable[[Any], dict] | None = None,
) -> Callable:
    """
    Decorator for tracking async function timing with automatic context extraction.

    Args:
        phase: Phase name for logging. Defaults to function name.
        room_id: One of:
            - Parameter path to extract room_id (e.g., "ctx.room_id")
            - Static int value
            - Callable that returns room_id (for closures)
        agent_name: One of:
            - Parameter path to extract agent_name (e.g., "ctx.agent_name")
            - Static string value
            - Callable that returns agent_name (for closures)
        include_result: If True, includes result info in log (success/error)
        extra_from_result: Callback to extract extra fields from result

    Example:
        # Path-based extraction
        @track_perf("tool_call", room_id="ctx.room_id", agent_name="ctx.agent_name")
        async def my_tool(ctx: ToolContext, args: dict):
            ...

        # Auto-detect from context objects
        @track_perf()
        async def move_character_tool(ctx: ToolContext, args: dict):
            ...

        # Closure-based (for inner functions)
        @track_perf("narration", room_id=lambda: ctx.room_id, agent_name=lambda: ctx.agent_name)
        async def narration_tool(args: dict):
            ...
    """

    def decorator(func: Callable) -> Callable:
        phase_name = phase or func.__name__

        def _resolve_context() -> tuple[int | None, str | None]:
            """Resolve room_id and agent_name, handling callables."""
            resolved_room_id: int | None = None
            resolved_agent_name: str | None = None

            # Handle room_id
            if callable(room_id):
                resolved_room_id = room_id()
            elif isinstance(room_id, int):
                resolved_room_id = room_id
            # Note: string path handled separately via _extract_context_from_args

            # Handle agent_name
            if callable(agent_name):
                resolved_agent_name = agent_name()
            elif isinstance(agent_name, str) and "." not in agent_name:
                # Static string, not a path
                resolved_agent_name = agent_name

            return resolved_room_id, resolved_agent_name

        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            perf = get_perf_logger()
            if not perf.enabled:
                return await func(*args, **kwargs)

            # First try callable/static values
            extracted_room_id, extracted_agent_name = _resolve_context()

            # Then try path-based extraction if needed
            if extracted_room_id is None or extracted_agent_name is None:
                # Only pass string paths to _extract_context_from_args
                room_path = room_id if isinstance(room_id, str) and "." in room_id else None
                agent_path = agent_name if isinstance(agent_name, str) and "." in agent_name else None
                path_room_id, path_agent_name = _extract_context_from_args(args, kwargs, room_path, agent_path, func)
                if extracted_room_id is None:
                    extracted_room_id = path_room_id
                if extracted_agent_name is None:
                    extracted_agent_name = path_agent_name

            start_time = datetime.now()
            start_perf = time.perf_counter()
            result = None
            error = None

            try:
                result = await func(*args, **kwargs)
                return result
            except Exception as e:
                error = e
                raise
            finally:
                end_perf = time.perf_counter()
                duration_ms = (end_perf - start_perf) * 1000

                extra: dict[str, Any] = {}
                if include_result:
                    extra["success"] = error is None
                    if error:
                        extra["error"] = str(error)[:50]
                if extra_from_result and result is not None:
                    try:
                        extra.update(extra_from_result(result))
                    except Exception:
                        pass

                entry = TimingEntry(
                    phase=phase_name,
                    agent_name=extracted_agent_name,
                    duration_ms=duration_ms,
                    start_time=start_time,
                    end_time=datetime.now(),
                    room_id=extracted_room_id,
                    extra=extra,
                )

                perf._entries.append(entry)
                await perf._write_entry(entry)

        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            perf = get_perf_logger()
            if not perf.enabled:
                return func(*args, **kwargs)

            # First try callable/static values
            extracted_room_id, extracted_agent_name = _resolve_context()

            # Then try path-based extraction if needed
            if extracted_room_id is None or extracted_agent_name is None:
                room_path = room_id if isinstance(room_id, str) and "." in room_id else None
                agent_path = agent_name if isinstance(agent_name, str) and "." in agent_name else None
                path_room_id, path_agent_name = _extract_context_from_args(args, kwargs, room_path, agent_path, func)
                if extracted_room_id is None:
                    extracted_room_id = path_room_id
                if extracted_agent_name is None:
                    extracted_agent_name = path_agent_name

            start_time = datetime.now()
            start_perf = time.perf_counter()
            result = None
            error = None

            try:
                result = func(*args, **kwargs)
                return result
            except Exception as e:
                error = e
                raise
            finally:
                end_perf = time.perf_counter()
                duration_ms = (end_perf - start_perf) * 1000

                extra: dict[str, Any] = {}
                if include_result:
                    extra["success"] = error is None
                    if error:
                        extra["error"] = str(error)[:50]
                if extra_from_result and result is not None:
                    try:
                        extra.update(extra_from_result(result))
                    except Exception:
                        pass

                entry = TimingEntry(
                    phase=phase_name,
                    agent_name=extracted_agent_name,
                    duration_ms=duration_ms,
                    start_time=start_time,
                    end_time=datetime.now(),
                    room_id=extracted_room_id,
                    extra=extra,
                )

                perf._entries.append(entry)
                with open(_get_log_file_path(), "a") as f:
                    f.write(entry.to_log_line() + "\n")
                logger.info(f"⏱️  {entry.to_log_line()}")

        # Return appropriate wrapper based on function type
        import asyncio

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper

    return decorator


def track_interaction(
    room_id_param: str = "room_id",
    action_param: str = "action_text",
) -> Callable:
    """
    Decorator for tracking full interaction (user action → all responses).

    Logs interaction start and end with total duration.

    Args:
        room_id_param: Parameter name for room_id
        action_param: Parameter name for action/message text

    Example:
        @track_interaction()
        async def handle_player_action(self, db, room_id: int, action_text: str, ...):
            ...
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            perf = get_perf_logger()

            # Extract room_id and action_text
            import inspect

            sig = inspect.signature(func)
            bound = sig.bind_partial(*args, **kwargs)
            bound.apply_defaults()
            all_args = bound.arguments

            room_id = all_args.get(room_id_param)
            action_text = all_args.get(action_param, "")

            if perf.enabled and room_id is not None:
                await perf.log_interaction_start(room_id, action_text or "")

            start_perf = time.perf_counter()
            result = None
            try:
                result = await func(*args, **kwargs)
                return result
            finally:
                if perf.enabled and room_id is not None:
                    duration_ms = (time.perf_counter() - start_perf) * 1000
                    # Count agents from result if it has that info
                    agent_count = 1
                    if hasattr(result, "total_responses"):
                        agent_count = result.total_responses
                    await perf.log_interaction_end(room_id, duration_ms, agent_count)

        return wrapper

    return decorator
