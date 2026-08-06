"""
In-memory caching with TTL support for performance optimization.

This module provides a centralized cache manager for frequently accessed data:
- Agent configuration data (from filesystem)
- Database objects (agents, rooms)
- Recent messages
- Agent profile pictures

All caches support TTL (time-to-live) and manual invalidation.

Concurrency model:
- ONE ``threading.Lock`` guards all mutable state, taken by sync and async
  methods alike. There used to be two locks -- a ``threading.Lock`` in the sync
  methods and a separate ``asyncio.Lock`` in the async ones -- guarding the same
  dict. Two locks that do not exclude each other are no lock at all; that was
  only latent because the app runs on a single event-loop thread today, and it
  would have become a live race the first time anyone added a sync endpoint
  (FastAPI runs those in a threadpool) or a worker thread.
- Every critical section is pure dict work with no ``await`` inside, so holding
  a blocking lock never stalls the event loop.
- The one place that must await (``get_or_set_async``'s factory) runs *outside*
  the lock and is deduplicated with a per-key future, so N concurrent misses
  compute the value once instead of N times.
"""

import asyncio
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock
from typing import Any, Callable, Dict, Optional, TypeVar

logger = logging.getLogger("Cache")

T = TypeVar("T")

# Cap on live entries. Keys are per-room and per-agent, so the cache grows with
# world count; without a cap it only ever shrinks when an expired key happens to
# be read again or the 5-minute scheduler sweep runs.
DEFAULT_MAX_SIZE = 2000

_MISSING = object()


@dataclass
class CacheEntry:
    """Single cache entry with value and expiration time."""

    value: Any
    expires_at: float

    def is_expired(self) -> bool:
        """Check if this cache entry has expired."""
        return time.time() > self.expires_at


class CacheManager:
    """
    Thread-safe, async-safe in-memory cache with TTL support.

    Features:
    - TTL-based expiration
    - Bounded size with LRU eviction
    - Manual invalidation by key or pattern
    - Single-flight ``get_or_set_async``: concurrent misses compute once
    """

    def __init__(self, max_size: int = DEFAULT_MAX_SIZE):
        """Initialize cache manager with empty storage.

        Args:
            max_size: Maximum live entries before least-recently-used eviction.
        """
        # OrderedDict, not dict: the insertion order doubles as LRU recency,
        # maintained by move_to_end() on every hit.
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = Lock()
        self._max_size = max_size
        # Per-key in-flight computations for get_or_set_async (single-flight).
        self._inflight: Dict[str, "asyncio.Future[Any]"] = {}
        self._stats = {"hits": 0, "misses": 0, "invalidations": 0, "evictions": 0}

    # -- internals ---------------------------------------------------------

    def _lookup_locked(self, key: str) -> Any:
        """Read a live entry, dropping it if expired. Caller must hold the lock.

        Returns ``_MISSING`` on miss so a cached ``None`` stays distinguishable
        from "not cached" -- callers that conflate the two would re-run the
        factory on every read of a legitimately-None value.
        """
        entry = self._cache.get(key)
        if entry is None:
            self._stats["misses"] += 1
            return _MISSING

        if entry.is_expired():
            del self._cache[key]
            self._stats["misses"] += 1
            logger.debug(f"Cache expired: {key}")
            return _MISSING

        self._cache.move_to_end(key)  # mark as recently used
        self._stats["hits"] += 1
        return entry.value

    def _store_locked(self, key: str, value: Any, ttl_seconds: float) -> None:
        """Insert an entry and enforce the size cap. Caller must hold the lock."""
        self._cache[key] = CacheEntry(value=value, expires_at=time.time() + ttl_seconds)
        self._cache.move_to_end(key)

        while len(self._cache) > self._max_size:
            evicted_key, _ = self._cache.popitem(last=False)  # least recently used
            self._stats["evictions"] += 1
            logger.debug(f"Cache evicted (size cap {self._max_size}): {evicted_key}")

    # -- public API --------------------------------------------------------

    def get(self, key: str) -> Optional[Any]:
        """
        Get value from cache if it exists and hasn't expired.

        Args:
            key: Cache key

        Returns:
            Cached value or None if not found/expired
        """
        with self._lock:
            value = self._lookup_locked(key)
        return None if value is _MISSING else value

    def set(self, key: str, value: Any, ttl_seconds: float = 60):
        """
        Store value in cache with TTL.

        Args:
            key: Cache key
            value: Value to cache
            ttl_seconds: Time to live in seconds (default: 60)
        """
        with self._lock:
            self._store_locked(key, value, ttl_seconds)
        logger.debug(f"Cache set: {key} (TTL: {ttl_seconds}s)")

    def invalidate(self, key: str) -> bool:
        """
        Remove a specific key from cache.

        Args:
            key: Cache key to invalidate

        Returns:
            True if key existed, False otherwise
        """
        with self._lock:
            if key in self._cache:
                del self._cache[key]
                self._stats["invalidations"] += 1
                logger.debug(f"Cache invalidated: {key}")
                return True
            return False

    def invalidate_pattern(self, pattern: str):
        """
        Invalidate all keys matching a pattern (prefix match).

        Args:
            pattern: Key prefix to match
        """
        with self._lock:
            keys_to_delete = [k for k in self._cache if k.startswith(pattern)]
            for key in keys_to_delete:
                del self._cache[key]
                self._stats["invalidations"] += 1

        if keys_to_delete:
            logger.debug(f"Cache invalidated pattern '{pattern}': {len(keys_to_delete)} keys")

    def clear(self):
        """Clear all cache entries."""
        with self._lock:
            count = len(self._cache)
            self._cache.clear()
        logger.info(f"Cache cleared: {count} entries removed")

    def cleanup_expired(self):
        """Remove all expired entries from cache.

        Called every 5 minutes by the background scheduler (``_cleanup_cache``).
        The LRU cap bounds the cache regardless; this reclaims entries that
        expired and were never read again, before they reach the cap.
        """
        with self._lock:
            current_time = time.time()
            expired_keys = [key for key, entry in self._cache.items() if entry.expires_at < current_time]
            for key in expired_keys:
                del self._cache[key]

        if expired_keys:
            logger.debug(f"Cache cleanup: {len(expired_keys)} expired entries removed")

    def get_or_set(self, key: str, factory: Callable[[], T], ttl_seconds: float = 60) -> T:
        """
        Get value from cache or compute it if not found.

        Args:
            key: Cache key
            factory: Function to compute value if not cached
            ttl_seconds: Time to live in seconds

        Returns:
            Cached or computed value
        """
        with self._lock:
            value = self._lookup_locked(key)
        if value is not _MISSING:
            return value

        computed = factory()
        self.set(key, computed, ttl_seconds)
        return computed

    async def get_async(self, key: str) -> Optional[Any]:
        """
        Async-callable version of :meth:`get`.

        The lock is a plain threading.Lock held only across dict operations,
        so this never yields and never stalls the event loop.

        Args:
            key: Cache key

        Returns:
            Cached value or None if not found/expired
        """
        return self.get(key)

    async def set_async(self, key: str, value: Any, ttl_seconds: float = 60):
        """
        Async-callable version of :meth:`set`.

        Args:
            key: Cache key
            value: Value to cache
            ttl_seconds: Time to live in seconds (default: 60)
        """
        self.set(key, value, ttl_seconds)

    async def get_or_set_async(self, key: str, factory: Callable[[], Any], ttl_seconds: float = 60) -> Any:
        """
        Get value from cache or await ``factory()`` to compute it.

        Single-flight: if several callers miss the same key at once, exactly one
        runs the factory and the rest await its result. Without this, N
        concurrent requests for an uncached room each issued their own database
        query.

        If the leading caller is cancelled, waiters see ``CancelledError`` too
        and a later call re-leads; if it raises, every waiter sees that
        exception and nothing is cached.

        Args:
            key: Cache key
            factory: Async function to compute value if not cached
            ttl_seconds: Time to live in seconds

        Returns:
            Cached or computed value
        """
        with self._lock:
            value = self._lookup_locked(key)
            if value is not _MISSING:
                return value

            existing = self._inflight.get(key)
            if existing is None:
                pending: "asyncio.Future[Any]" = asyncio.get_running_loop().create_future()
                # Retrieve the exception on completion so a failed computation
                # with no waiters does not log "exception was never retrieved".
                pending.add_done_callback(_consume_future_exception)
                self._inflight[key] = pending
            else:
                pending = None  # type: ignore[assignment]

        if pending is None:
            return await existing  # another caller is already computing this key

        try:
            computed = await factory()
        except asyncio.CancelledError:
            self._finish_inflight(key, pending, cancel=True)
            raise
        except BaseException as exc:
            self._finish_inflight(key, pending, exception=exc)
            raise

        with self._lock:
            self._store_locked(key, computed, ttl_seconds)
        logger.debug(f"Cache set: {key} (TTL: {ttl_seconds}s)")

        self._finish_inflight(key, pending, result=computed)
        return computed

    def _finish_inflight(
        self,
        key: str,
        pending: "asyncio.Future[Any]",
        *,
        result: Any = None,
        exception: Optional[BaseException] = None,
        cancel: bool = False,
    ) -> None:
        """Release a single-flight slot and wake its waiters."""
        with self._lock:
            if self._inflight.get(key) is pending:
                del self._inflight[key]

        if pending.done():
            return
        if cancel:
            pending.cancel()
        elif exception is not None:
            pending.set_exception(exception)
        else:
            pending.set_result(result)

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        with self._lock:
            stats = dict(self._stats)
            size = len(self._cache)

        total = stats["hits"] + stats["misses"]
        hit_rate = (stats["hits"] / total * 100) if total > 0 else 0
        return {**stats, "total_requests": total, "hit_rate": round(hit_rate, 2), "size": size}

    def log_stats(self):
        """Log current cache statistics."""
        stats = self.get_stats()
        logger.info(
            f"Cache stats: {stats['hits']} hits, {stats['misses']} misses, "
            f"{stats['hit_rate']}% hit rate, {stats['size']} entries, "
            f"{stats['invalidations']} invalidations, {stats['evictions']} evictions"
        )


def _consume_future_exception(future: "asyncio.Future[Any]") -> None:
    """Retrieve a finished future's exception so asyncio does not warn about it."""
    if not future.cancelled():
        future.exception()


# Global cache instance
_cache_manager = CacheManager()


def get_cache() -> CacheManager:
    """Get the global cache manager instance."""
    return _cache_manager


# Cache key builders for consistent naming
def agent_config_key(agent_id: int) -> str:
    """Build cache key for agent config data."""
    return f"agent_config:{agent_id}"


def agent_object_key(agent_id: int) -> str:
    """Build cache key for agent database object."""
    return f"agent_obj:{agent_id}"


def room_object_key(room_id: int) -> str:
    """Build cache key for room database object."""
    return f"room_obj:{room_id}"


def room_agents_key(room_id: int) -> str:
    """Build cache key for room's agents list."""
    return f"room_agents:{room_id}"


def room_messages_key(room_id: int) -> str:
    """Build cache key for room's messages."""
    return f"room_messages:{room_id}"


def chatting_agents_key(room_id: int) -> str:
    """Build cache key for currently chatting agents."""
    return f"chatting_agents:{room_id}"
