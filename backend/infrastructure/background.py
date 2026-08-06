"""Registry for fire-and-forget background tasks.

`asyncio.create_task()` alone is not enough for work that nobody awaits: the
event loop keeps only a *weak* reference to a running task, so a task with no
other referent can be garbage-collected mid-flight, and an exception raised
inside it is never observed.

`spawn_background()` holds a strong reference until the task finishes, logs any
exception it raised, and lets shutdown wait for outstanding work.
"""

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

logger = logging.getLogger("BackgroundTasks")

# Strong references to in-flight tasks, so the GC cannot collect them early.
_background_tasks: set[asyncio.Task] = set()


def _log_task_exception(task: asyncio.Task) -> None:
    """Surface an exception from a task nobody awaits."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error(f"Background task '{task.get_name()}' failed: {exc}", exc_info=exc)


def spawn_background(coro: Coroutine[Any, Any, Any], *, name: str) -> asyncio.Task:
    """Start a fire-and-forget task that stays referenced and logs its failures.

    Args:
        coro: Coroutine to run.
        name: Task name, used in logs. Include identifying context
            (e.g. ``f"trigger_agent_responses:room={room_id}"``).

    Returns:
        The created task. Callers may ignore it — the registry keeps it alive.
    """
    task = asyncio.create_task(coro, name=name)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    task.add_done_callback(_log_task_exception)
    return task


def pending_background_tasks() -> set[asyncio.Task]:
    """Return the tasks that have not finished yet (for tests and diagnostics)."""
    return {task for task in _background_tasks if not task.done()}


async def drain_background_tasks(timeout: float = 10.0) -> None:
    """Wait for outstanding background tasks, cancelling whatever overruns.

    Called on application shutdown so in-flight agent turns get a chance to
    finish writing before the event loop goes away.
    """
    pending = pending_background_tasks()
    if not pending:
        return

    logger.info(f"Waiting up to {timeout:.0f}s for {len(pending)} background task(s)")
    _done, still_running = await asyncio.wait(pending, timeout=timeout)

    if still_running:
        names = ", ".join(sorted(task.get_name() for task in still_running))
        logger.warning(f"Cancelling {len(still_running)} background task(s) that overran shutdown: {names}")
        for task in still_running:
            task.cancel()
        await asyncio.gather(*still_running, return_exceptions=True)
