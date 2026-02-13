"""
Custom Claude Agent SDK transport utilities.

Claude Agent SDK exposes a low-level `Transport` interface (re-exported at the
package root) that can be used to implement custom connections. The official
SDK currently ships a subprocess-based transport (internal), but this file
provides a safe extension seam inside ClaudeWorld.

Current use cases:
  - Opt-in JSONL logging of raw control-protocol traffic for debugging.
  - MetricsTransport for performance instrumentation (integrates with perf_logger).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from claude_agent_sdk import ClaudeAgentOptions, Transport
from core import get_settings
from domain.value_objects.task_identifier import TaskIdentifier
from infrastructure.logging.perf_logger import get_perf_logger

from sdk.loaders import get_debug_config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TransportLoggingConfig:
    """Configuration for transport-level logging."""

    enabled: bool
    output_dir: str
    include_writes: bool
    include_reads: bool
    max_payload_chars: int


def _load_transport_logging_config() -> TransportLoggingConfig:
    debug_config = get_debug_config()
    debug_enabled = bool(debug_config.get("debug", {}).get("enabled", False))
    transport_cfg = debug_config.get("debug", {}).get("logging", {}).get("transport", {})

    enabled = debug_enabled and bool(transport_cfg.get("enabled", False))
    output_dir = str(transport_cfg.get("output_dir", "transport_logs"))
    include_writes = bool(transport_cfg.get("include_writes", True))
    include_reads = bool(transport_cfg.get("include_reads", False))
    max_payload_chars = int(transport_cfg.get("max_payload_chars", 5000))

    if max_payload_chars < 0:
        max_payload_chars = 0

    return TransportLoggingConfig(
        enabled=enabled,
        output_dir=output_dir,
        include_writes=include_writes,
        include_reads=include_reads,
        max_payload_chars=max_payload_chars,
    )


def _truncate_str(value: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    if len(value) <= max_chars:
        return value
    return value[:max_chars] + "…(truncated)"


async def _empty_stream() -> AsyncIterator[dict[str, Any]]:
    # Async generator that never yields (keeps streaming connection open).
    return
    yield {}  # type: ignore[unreachable]


class JsonlLoggingSubprocessTransport(Transport):
    """
    Transport that runs the SDK's subprocess CLI transport and logs raw traffic.

    This is intentionally behind debug config flags because the raw JSON traffic
    can contain large payloads (prompts, tool inputs/outputs).

    Note: This relies on the SDK's internal `SubprocessCLITransport` module.
    If the SDK changes internal paths, logging will auto-disable with a warning.
    """

    def __init__(self, *, options: ClaudeAgentOptions, log_path: Path, cfg: TransportLoggingConfig):
        self._options = options
        self._log_path = log_path
        self._cfg = cfg
        self._inner: Optional[Transport] = None
        self._fh: Optional[object] = None
        self._log_lock = asyncio.Lock()

    async def connect(self) -> None:
        if self._inner is not None:
            return

        # Import internal transport lazily to avoid hard dependency at import time.
        from claude_agent_sdk._internal.transport.subprocess_cli import (  # type: ignore[attr-defined]
            SubprocessCLITransport,
        )

        self._log_path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self._log_path, "a", encoding="utf-8")

        try:
            self._inner = SubprocessCLITransport(prompt=_empty_stream(), options=self._options)
            await self._inner.connect()
            await self._log_event({"event": "connect"})
        except Exception:
            # Avoid leaking file handles on connect failures.
            await self.close()
            raise

    async def write(self, data: str) -> None:
        if self._cfg.include_writes:
            await self._log_event(
                {
                    "direction": "write",
                    "payload": _truncate_str(data, self._cfg.max_payload_chars),
                }
            )
        if self._inner is None:
            raise RuntimeError("Transport not connected")
        await self._inner.write(data)

    def read_messages(self) -> AsyncIterator[dict[str, Any]]:
        return self._read_messages_impl()

    async def _read_messages_impl(self) -> AsyncIterator[dict[str, Any]]:
        if self._inner is None:
            raise RuntimeError("Transport not connected")

        async for message in self._inner.read_messages():
            if self._cfg.include_reads:
                await self._log_event({"direction": "read", "message": message})
            yield message

    async def close(self) -> None:
        if self._inner is not None:
            await self._log_event({"event": "close"})
            await self._inner.close()
            self._inner = None

        if self._fh is not None:
            try:
                self._fh.close()  # type: ignore[union-attr]
            finally:
                self._fh = None

    def is_ready(self) -> bool:
        return bool(self._inner and self._inner.is_ready())

    async def end_input(self) -> None:
        if self._inner is None:
            return
        await self._inner.end_input()

    async def _log_event(self, event: dict[str, Any]) -> None:
        if self._fh is None:
            return
        event_with_meta = {
            "ts": datetime.now().isoformat(),
            **event,
        }
        line = json.dumps(event_with_meta, ensure_ascii=False, default=str)
        async with self._log_lock:
            try:
                self._fh.write(line + "\n")  # type: ignore[union-attr]
                self._fh.flush()  # type: ignore[union-attr]
            except Exception:
                # Logging must never take down the agent pipeline.
                pass


@dataclass
class TransportMetrics:
    """Accumulated metrics for a transport instance."""

    connect_count: int = 0
    connect_success: int = 0
    connect_error: int = 0
    connect_total_ms: float = 0.0

    write_count: int = 0
    write_error: int = 0
    write_total_ms: float = 0.0
    write_total_bytes: int = 0

    read_count: int = 0
    read_error: int = 0

    close_count: int = 0


class MetricsTransport(Transport):
    """
    Transport wrapper that collects performance metrics.

    Wraps any inner transport and tracks:
    - Connect timing and success/error rates
    - Write timing and throughput (bytes)
    - Read message counts
    - Error rates

    Metrics are logged via perf_logger when PERF_LOG=true.

    Usage:
        inner = SubprocessCLITransport(...)
        transport = MetricsTransport(inner, task_id)
        await transport.connect()
    """

    def __init__(self, inner: Transport, task_id: TaskIdentifier):
        self._inner = inner
        self._task_id = task_id
        self._metrics = TransportMetrics()
        self._perf = get_perf_logger()

    @property
    def metrics(self) -> TransportMetrics:
        """Access accumulated metrics."""
        return self._metrics

    async def connect(self) -> None:
        self._metrics.connect_count += 1
        start = time.perf_counter()

        try:
            await self._inner.connect()
            elapsed_ms = (time.perf_counter() - start) * 1000
            self._metrics.connect_success += 1
            self._metrics.connect_total_ms += elapsed_ms

            self._perf.log_sync(
                "transport_connect",
                elapsed_ms,
                room_id=self._task_id.room_id,
                agent_id=self._task_id.agent_id,
                success=True,
            )
        except Exception as e:
            elapsed_ms = (time.perf_counter() - start) * 1000
            self._metrics.connect_error += 1
            self._metrics.connect_total_ms += elapsed_ms

            self._perf.log_sync(
                "transport_connect",
                elapsed_ms,
                room_id=self._task_id.room_id,
                agent_id=self._task_id.agent_id,
                success=False,
                error=str(e)[:100],
            )
            raise

    async def write(self, data: str) -> None:
        self._metrics.write_count += 1
        data_bytes = len(data.encode("utf-8"))
        start = time.perf_counter()

        try:
            await self._inner.write(data)
            elapsed_ms = (time.perf_counter() - start) * 1000
            self._metrics.write_total_ms += elapsed_ms
            self._metrics.write_total_bytes += data_bytes

            self._perf.log_sync(
                "transport_write",
                elapsed_ms,
                room_id=self._task_id.room_id,
                agent_id=self._task_id.agent_id,
                bytes=data_bytes,
            )
        except Exception as e:
            elapsed_ms = (time.perf_counter() - start) * 1000
            self._metrics.write_error += 1

            self._perf.log_sync(
                "transport_write",
                elapsed_ms,
                room_id=self._task_id.room_id,
                agent_id=self._task_id.agent_id,
                bytes=data_bytes,
                error=str(e)[:100],
            )
            raise

    def read_messages(self) -> AsyncIterator[dict[str, Any]]:
        return self._read_messages_impl()

    async def _read_messages_impl(self) -> AsyncIterator[dict[str, Any]]:
        try:
            last_read_time = time.perf_counter()
            async for message in self._inner.read_messages():
                now = time.perf_counter()
                wait_ms = (now - last_read_time) * 1000
                self._metrics.read_count += 1

                # Only log significant waits (>500ms) to reduce noise from streaming tokens
                if wait_ms > 500:
                    msg_type = type(message).__name__
                    self._perf.log_sync(
                        "transport_read_gap",
                        wait_ms,
                        room_id=self._task_id.room_id,
                        agent_id=self._task_id.agent_id,
                        msg_type=msg_type,
                    )

                last_read_time = now
                yield message
        except Exception as e:
            self._metrics.read_error += 1
            logger.warning(f"MetricsTransport read error for {self._task_id}: {e}")
            raise

    async def close(self) -> None:
        self._metrics.close_count += 1

        # Log summary metrics on close
        self._perf.log_sync(
            "transport_summary",
            self._metrics.connect_total_ms + self._metrics.write_total_ms,
            room_id=self._task_id.room_id,
            agent_id=self._task_id.agent_id,
            connects=self._metrics.connect_count,
            connect_errors=self._metrics.connect_error,
            writes=self._metrics.write_count,
            write_errors=self._metrics.write_error,
            write_bytes=self._metrics.write_total_bytes,
            reads=self._metrics.read_count,
            read_errors=self._metrics.read_error,
        )

        await self._inner.close()

    def is_ready(self) -> bool:
        return self._inner.is_ready()

    async def end_input(self) -> None:
        await self._inner.end_input()


def build_transport(options: ClaudeAgentOptions, task_id: TaskIdentifier) -> Transport | None:
    """
    Build an optional custom transport for the SDK client.

    Transport layers (from outermost to innermost):
    1. MetricsTransport (when PERF_LOG=true) - performance instrumentation
    2. JsonlLoggingSubprocessTransport (when debug.logging.transport.enabled) - raw traffic logging
    3. SDK's built-in SubprocessCLITransport (default)

    Returns None to use SDK's built-in transport when no wrappers are needed.
    """
    from infrastructure.logging.perf_logger import is_perf_logging_enabled

    perf_enabled = is_perf_logging_enabled()
    jsonl_cfg = _load_transport_logging_config()

    # If neither metrics nor JSONL logging is enabled, use SDK default
    if not perf_enabled and not jsonl_cfg.enabled:
        return None

    # Build the innermost transport (JSONL logging or SDK default)
    inner_transport: Transport | None = None

    if jsonl_cfg.enabled:
        # Fail-safe: if the SDK internal transport path changes, fall back to SDK default.
        try:
            from claude_agent_sdk._internal.transport.subprocess_cli import (
                SubprocessCLITransport,  # type: ignore[attr-defined]  # noqa: F401
            )
        except Exception as e:
            logger.warning(f"SDK internal SubprocessCLITransport not available; transport logging disabled: {e}")
            # Fall through - inner_transport stays None

        if inner_transport is None:
            # Derive log path relative to backend directory (works in bundled mode too).
            base_dir = get_settings().backend_dir
            out_dir = Path(base_dir) / jsonl_cfg.output_dir
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"transport_room{task_id.room_id}_agent{task_id.agent_id}_{ts}.jsonl"
            log_path = out_dir / filename

            try:
                inner_transport = JsonlLoggingSubprocessTransport(options=options, log_path=log_path, cfg=jsonl_cfg)
            except Exception as e:
                logger.warning(f"Failed to create logging transport: {e}")
                # Fall through - inner_transport stays None

    # If we couldn't create JSONL transport but metrics is enabled, we need a base transport
    if inner_transport is None and perf_enabled:
        try:
            from claude_agent_sdk._internal.transport.subprocess_cli import (
                SubprocessCLITransport,  # type: ignore[attr-defined]
            )

            inner_transport = SubprocessCLITransport(prompt=_empty_stream(), options=options)
        except Exception as e:
            logger.warning(f"Failed to create subprocess transport for metrics: {e}")
            return None

    # Wrap with MetricsTransport if perf logging is enabled
    if inner_transport is not None and perf_enabled:
        return MetricsTransport(inner_transport, task_id)

    return inner_transport
