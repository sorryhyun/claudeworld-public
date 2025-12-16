"""
Client pool for managing Claude SDK client lifecycle and pooling.

This module provides the ClientPool class which manages the lifecycle of
ClaudeSDKClient instances, implementing connection pooling to avoid spawning
multiple CLI processes unnecessarily.

SDK Constraint: ClaudeAgentOptions (system_prompt, output_format, tools,
mcp_servers, fork_session, resume) are ONLY applied at connect() time.
Updating client.options on an already-connected client has NO effect.

SDK Best Practice: Reuse ClaudeSDKClient instances within sessions to avoid
spawning multiple CLI processes. Each client maintains conversation context
across queries. Use per-client usage locks to prevent concurrent query/response.

Config Hash Tracking:
- Each pooled client is associated with a config hash
- When config hash changes (e.g., new tool groups, different world), client is reconnected
- This ensures MCP servers/tools are correctly configured without unnecessary reconnects
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional, Tuple

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
from domain.value_objects.task_identifier import TaskIdentifier
from infrastructure.logging.perf_logger import get_perf_logger

logger = logging.getLogger(__name__)
_perf = get_perf_logger()


@dataclass
class PooledClient:
    """A pooled client with its associated metadata."""

    client: ClaudeSDKClient
    config_hash: str  # Hash of MCP config used at connect time
    session_id: Optional[str] = None  # Session ID for conversation continuity


class ClientPool:
    """
    Manages pooling and lifecycle of Claude SDK clients.

    SDK Constraint: ClaudeAgentOptions are ONLY applied at connect() time.
    Updating client.options on an already-connected client has NO effect.

    SDK Best Practice: Reuse ClaudeSDKClient instances within sessions
    to avoid spawning multiple CLI processes. Each client maintains
    conversation context across queries.

    Pool Strategy:
        - Key: TaskIdentifier(room_id, agent_id)
        - Value: PooledClient (client + config_hash + session_id)
        - Cleanup: Background disconnect to avoid cancel scope issues
        - Concurrency: Semaphore allows up to MAX_CONCURRENT_CONNECTIONS simultaneous connections
        - Usage lock: Per-client lock to serialize query/receive_response
        - Config hash: Tracks MCP config used at connect; reconnects on change
    """

    # Allow up to 10 concurrent connections (prevents ProcessTransport issues while allowing parallelism)
    MAX_CONCURRENT_CONNECTIONS = 10
    # Stabilization delay after each connection (seconds)
    CONNECTION_STABILIZATION_DELAY = 0.05
    # Timeout for disconnect operations (seconds)
    DISCONNECT_TIMEOUT = 5.0

    def __init__(self):
        """Initialize the client pool."""
        self.pool: dict[TaskIdentifier, PooledClient] = {}
        # Use semaphore instead of lock to allow limited concurrency
        self._connection_semaphore = asyncio.Semaphore(self.MAX_CONCURRENT_CONNECTIONS)
        # Per-task_id locks to prevent duplicate client creation for the same task
        self._task_locks: dict[TaskIdentifier, asyncio.Lock] = {}
        # Per-task_id locks for serializing query/receive_response on each client
        self._usage_locks: dict[TaskIdentifier, asyncio.Lock] = {}
        self._cleanup_tasks: set[asyncio.Task] = set()

    def _get_task_lock(self, task_id: TaskIdentifier) -> asyncio.Lock:
        """Get or create a per-task_id lock for connection creation."""
        if task_id not in self._task_locks:
            self._task_locks[task_id] = asyncio.Lock()
        return self._task_locks[task_id]

    def _get_usage_lock(self, task_id: TaskIdentifier) -> asyncio.Lock:
        """Get or create a per-task_id lock for query/receive_response serialization."""
        if task_id not in self._usage_locks:
            self._usage_locks[task_id] = asyncio.Lock()
        return self._usage_locks[task_id]

    async def get_or_create(
        self, task_id: TaskIdentifier, options: ClaudeAgentOptions, config_hash: str = ""
    ) -> Tuple[ClaudeSDKClient, bool, asyncio.Lock]:
        """
        Get existing client or create new one.

        SDK Constraint: Options are baked in at connect time. This method does NOT
        update options on existing clients - that would have no effect.

        Reconnection triggers:
        1. Session ID change (conversation context reset)
        2. Config hash change (MCP servers/tools changed)

        Args:
            task_id: Identifier for this agent task
            options: SDK client configuration (only used for new connections)
            config_hash: Hash of MCP config (used to detect config changes)

        Returns:
            (client, is_new, usage_lock) tuple
            - client: ClaudeSDKClient instance
            - is_new: True if newly created, False if reused from pool
            - usage_lock: Lock to serialize query/receive_response on this client

        SDK Best Practice: Use lock to prevent ProcessTransport race
        conditions when creating multiple clients concurrently.
        """
        overall_start = time.perf_counter()

        # Check if client exists outside the lock (fast path)
        pool_check_start = time.perf_counter()
        if task_id in self.pool:
            pooled = self.pool[task_id]
            old_session_id = pooled.session_id
            new_session_id = getattr(options, "resume", None)
            old_config_hash = pooled.config_hash

            logger.debug(
                f"Client exists for {task_id} | "
                f"Session: {old_session_id} -> {new_session_id} | "
                f"Config: {old_config_hash[:8] if old_config_hash else 'none'} -> {config_hash[:8] if config_hash else 'none'}"
            )

            # Check if we need to reconnect
            session_changed = old_session_id != new_session_id and (
                old_session_id is not None or new_session_id is not None
            )
            config_changed = config_hash and old_config_hash != config_hash

            if session_changed:
                logger.info(
                    f"Session changed for {task_id} (old: {old_session_id}, new: {new_session_id}), recreating client"
                )
                self._remove_from_pool(task_id)
                # Fall through to create new client below
            elif config_changed:
                logger.info(
                    f"Config changed for {task_id} (old: {old_config_hash[:8]}, new: {config_hash[:8]}), recreating client"
                )
                self._remove_from_pool(task_id)
                # Fall through to create new client below
            else:
                pool_check_ms = (time.perf_counter() - pool_check_start) * 1000
                _perf.log_sync(
                    "pool_check_hit", pool_check_ms, None, task_id.room_id, agent_id=task_id.agent_id, reused=True
                )
                logger.debug(
                    f"Reusing existing client for {task_id} (config hash: {config_hash[:8] if config_hash else 'none'})"
                )
                # NOTE: We do NOT update options here - they are baked in at connect time
                # Updating client.options has no effect on the running CLI subprocess
                usage_lock = self._get_usage_lock(task_id)
                return pooled.client, False, usage_lock

        pool_check_ms = (time.perf_counter() - pool_check_start) * 1000
        _perf.log_sync("pool_check_miss", pool_check_ms, None, task_id.room_id, agent_id=task_id.agent_id, reused=False)

        # Use per-task_id lock to prevent duplicate client creation for the same task
        task_lock = self._get_task_lock(task_id)
        lock_wait_start = time.perf_counter()
        async with task_lock:
            lock_wait_ms = (time.perf_counter() - lock_wait_start) * 1000
            _perf.log_sync("task_lock_acquire", lock_wait_ms, None, task_id.room_id, agent_id=task_id.agent_id)

            # Double-check after acquiring task lock (another coroutine might have created it)
            if task_id in self.pool:
                pooled = self.pool[task_id]
                old_session_id = pooled.session_id
                new_session_id = getattr(options, "resume", None)
                old_config_hash = pooled.config_hash

                # Check if we need to reconnect
                session_changed = old_session_id != new_session_id and (
                    old_session_id is not None or new_session_id is not None
                )
                config_changed = config_hash and old_config_hash != config_hash

                if session_changed:
                    logger.info(f"Session changed for {task_id} while waiting for lock, recreating client")
                    self._remove_from_pool(task_id)
                    # Continue to create new client below
                elif config_changed:
                    logger.info(f"Config changed for {task_id} while waiting for lock, recreating client")
                    self._remove_from_pool(task_id)
                    # Continue to create new client below
                else:
                    logger.debug(f"Client for {task_id} was created while waiting for lock")
                    # NOTE: We do NOT update options here - they are baked in at connect time
                    overall_ms = (time.perf_counter() - overall_start) * 1000
                    _perf.log_sync(
                        "get_pooled_client",
                        overall_ms,
                        None,
                        task_id.room_id,
                        agent_id=task_id.agent_id,
                        created=False,
                        waited_for_other=True,
                    )
                    usage_lock = self._get_usage_lock(task_id)
                    return pooled.client, False, usage_lock

            # Use semaphore to limit overall connection concurrency (prevents ProcessTransport issues)
            semaphore_wait_start = time.perf_counter()
            async with self._connection_semaphore:
                semaphore_wait_ms = (time.perf_counter() - semaphore_wait_start) * 1000
                _perf.log_sync("semaphore_acquire", semaphore_wait_ms, None, task_id.room_id, agent_id=task_id.agent_id)

                logger.debug(
                    f"Creating new client for {task_id} (config hash: {config_hash[:8] if config_hash else 'none'})"
                )

                # Retry connection with exponential backoff to handle ProcessTransport race conditions
                max_retries = 3
                for attempt in range(max_retries):
                    try:
                        client_create_start = time.perf_counter()
                        client = ClaudeSDKClient(options=options)
                        client_create_ms = (time.perf_counter() - client_create_start) * 1000
                        _perf.log_sync(
                            "client_instantiate", client_create_ms, None, task_id.room_id, agent_id=task_id.agent_id
                        )

                        # Connect without a prompt - messages are sent via query() instead
                        connect_start = time.perf_counter()
                        await client.connect()
                        connect_ms = (time.perf_counter() - connect_start) * 1000
                        _perf.log_sync(
                            "client_connect",
                            connect_ms,
                            None,
                            task_id.room_id,
                            agent_id=task_id.agent_id,
                            attempt=attempt + 1,
                        )

                        # Store with metadata
                        session_id = getattr(options, "resume", None)
                        self.pool[task_id] = PooledClient(
                            client=client,
                            config_hash=config_hash,
                            session_id=session_id,
                        )

                        # Brief delay to let ProcessTransport stabilize before next connection
                        await asyncio.sleep(self.CONNECTION_STABILIZATION_DELAY)

                        overall_ms = (time.perf_counter() - overall_start) * 1000
                        _perf.log_sync(
                            "get_pooled_client",
                            overall_ms,
                            None,
                            task_id.room_id,
                            agent_id=task_id.agent_id,
                            created=True,
                            attempts=attempt + 1,
                        )
                        usage_lock = self._get_usage_lock(task_id)
                        return client, True, usage_lock
                    except Exception as e:
                        if "ProcessTransport is not ready" in str(e) and attempt < max_retries - 1:
                            delay = 0.3 * (2**attempt)  # Exponential backoff: 0.3s, 0.6s
                            logger.warning(
                                f"Connection failed for {task_id}, retrying in {delay}s (attempt {attempt + 1}/{max_retries})"
                            )
                            _perf.log_sync(
                                "client_connect_retry",
                                delay * 1000,
                                None,
                                task_id.room_id,
                                agent_id=task_id.agent_id,
                                attempt=attempt + 1,
                                error=str(e)[:50],
                            )
                            await asyncio.sleep(delay)
                        else:
                            # Re-raise on final attempt or non-transport errors
                            raise

    def _remove_from_pool(self, task_id: TaskIdentifier):
        """
        Remove a client from the pool and schedule background disconnect.

        Use this when replacing a client due to session or config changes.
        Background disconnect prevents subprocess leaks while avoiding
        cancel scope interference with SQLAlchemy operations.

        Args:
            task_id: Identifier for the client to remove
        """
        if task_id not in self.pool:
            return

        logger.info(f"🗑️  Removing client from pool for {task_id}")
        pooled = self.pool[task_id]
        del self.pool[task_id]

        # Also remove locks to prevent memory leak
        self._task_locks.pop(task_id, None)
        self._usage_locks.pop(task_id, None)

        # Schedule background disconnect to prevent subprocess leaks
        # (instead of relying on GC which may not clean up promptly)
        task = asyncio.create_task(self._disconnect_client_background(pooled.client, task_id))
        self._cleanup_tasks.add(task)
        task.add_done_callback(self._cleanup_tasks.discard)

    async def cleanup(self, task_id: TaskIdentifier):
        """
        Remove and cleanup a specific client.

        Args:
            task_id: Identifier for the client to cleanup

        SDK Best Practice: Disconnect in background task to avoid
        cancel scope issues. The cleanup happens outside the current
        async context to prevent premature cancellation.

        Note: For session/config changes, use _remove_from_pool() instead to avoid
        cancel scope interference with SQLAlchemy.
        """
        if task_id not in self.pool:
            return

        logger.info(f"🧹 Cleaning up client for {task_id}")
        pooled = self.pool[task_id]

        # Remove from pool immediately
        del self.pool[task_id]

        # Also remove locks to prevent memory leak
        self._task_locks.pop(task_id, None)
        self._usage_locks.pop(task_id, None)

        # Schedule disconnect in a background task (separate from HTTP request task)
        # This ensures disconnect runs in its own async context, avoiding cancel scope violations
        task = asyncio.create_task(self._disconnect_client_background(pooled.client, task_id))

        # Track the cleanup task
        self._cleanup_tasks.add(task)
        # Remove from tracking when done
        task.add_done_callback(self._cleanup_tasks.discard)

        logger.info(f"✅ Cleaned up client for {task_id}")

    def cleanup_stale_locks(self) -> int:
        """
        Remove locks for task_ids that are no longer in the pool.

        This prevents memory leaks from accumulating locks over time.

        Returns:
            Number of stale locks removed.
        """
        stale_task_locks = [task_id for task_id in self._task_locks if task_id not in self.pool]
        stale_usage_locks = [task_id for task_id in self._usage_locks if task_id not in self.pool]

        for task_id in stale_task_locks:
            del self._task_locks[task_id]
        for task_id in stale_usage_locks:
            del self._usage_locks[task_id]

        total_cleaned = len(stale_task_locks) + len(stale_usage_locks)
        if total_cleaned > 0:
            logger.debug(
                f"Cleaned up {len(stale_task_locks)} stale task locks and {len(stale_usage_locks)} stale usage locks"
            )

        return total_cleaned

    async def cleanup_room(self, room_id: int):
        """
        Cleanup all clients for a specific room.

        Args:
            room_id: Room ID to cleanup
        """
        tasks_to_cleanup = [task_id for task_id in self.pool.keys() if task_id.room_id == room_id]
        for task_id in tasks_to_cleanup:
            await self.cleanup(task_id)

    async def shutdown_all(self):
        """
        Graceful shutdown of all clients.

        SDK Best Practice: Wait for all cleanup tasks to complete
        before final shutdown to prevent resource leaks.
        """
        logger.info(f"🛑 Shutting down ClientPool with {len(self.pool)} pooled clients")

        # Cleanup all clients
        task_ids = list(self.pool.keys())
        for task_id in task_ids:
            await self.cleanup(task_id)

        # Wait for background cleanup tasks
        if self._cleanup_tasks:
            logger.info(f"⏳ Waiting for {len(self._cleanup_tasks)} cleanup tasks to complete")
            await asyncio.gather(*self._cleanup_tasks, return_exceptions=True)

        logger.info("✅ ClientPool shutdown complete")

    def get_keys_for_agent(self, agent_id: int) -> list[TaskIdentifier]:
        """
        Get all pool keys for a specific agent.

        Args:
            agent_id: Agent ID to filter

        Returns:
            List of TaskIdentifiers for this agent

        Used by agent_service.py for agent cleanup.
        """
        return [task_id for task_id in self.pool.keys() if task_id.agent_id == agent_id]

    def keys(self):
        """
        Get all pool keys.

        Returns:
            Dict keys view of all TaskIdentifiers in the pool
        """
        return self.pool.keys()

    async def _disconnect_client_background(self, client: ClaudeSDKClient, task_id: TaskIdentifier):
        """
        Background task for client disconnection with timeout.

        Isolated in separate async task to avoid cancel scope issues.
        Uses timeout to prevent hanging disconnect operations from accumulating.
        Uses asyncio.shield() to protect from cancellation of parent tasks.

        Args:
            client: The client to disconnect
            task_id: Identifier for logging purposes
        """
        try:
            # Small delay before disconnect to allow pending operations to complete
            # This prevents cancel scope interference with uvicorn lifespan handlers
            await asyncio.sleep(0.5)
            # Use shield to protect disconnect from cancellation by parent tasks
            # This prevents CancelledError from propagating when the main task is cancelled
            if hasattr(client, "disconnect"):
                await asyncio.wait_for(
                    asyncio.shield(client.disconnect()),
                    timeout=self.DISCONNECT_TIMEOUT,
                )
                logger.debug(f"Disconnected client for {task_id}")
            elif hasattr(client, "close"):
                await asyncio.wait_for(
                    asyncio.shield(client.close()),
                    timeout=self.DISCONNECT_TIMEOUT,
                )
                logger.debug(f"Closed client for {task_id}")
        except asyncio.TimeoutError:
            logger.warning(f"Timeout disconnecting client {task_id} (>{self.DISCONNECT_TIMEOUT}s)")
        except asyncio.CancelledError:
            # CancelledError is expected when parent task is cancelled
            # Just log and suppress - the client may already be disconnected
            logger.debug(f"Disconnect cancelled for {task_id} (parent task cancelled)")
        except Exception as e:
            # Suppress cancel scope errors and connection-related errors
            # These can happen if the client's internal state is tied to a completed task
            error_msg = str(e).lower()
            if (
                "cancel scope" not in error_msg
                and "cancelled" not in error_msg
                and "no active connection" not in error_msg
            ):
                logger.warning(f"Error disconnecting client {task_id}: {e}")
