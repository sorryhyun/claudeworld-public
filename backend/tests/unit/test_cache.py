"""
Unit tests for CacheManager.

Covers TTL expiry, LRU eviction, invalidation, and the single-flight behaviour
of get_or_set_async.
"""

import asyncio

import pytest
from infrastructure.cache import CacheManager


@pytest.mark.unit
class TestCacheBasics:
    """TTL, hit/miss accounting, and invalidation."""

    def test_set_and_get(self):
        cache = CacheManager()
        cache.set("k", "v")
        assert cache.get("k") == "v"

    def test_missing_key_returns_none(self):
        assert CacheManager().get("nope") is None

    def test_expired_entry_is_a_miss(self):
        cache = CacheManager()
        cache.set("k", "v", ttl_seconds=-1)  # already expired

        assert cache.get("k") is None
        assert cache.get_stats()["size"] == 0  # and dropped from storage

    def test_invalidate(self):
        cache = CacheManager()
        cache.set("k", "v")

        assert cache.invalidate("k") is True
        assert cache.invalidate("k") is False
        assert cache.get("k") is None

    def test_invalidate_pattern_is_prefix_match(self):
        cache = CacheManager()
        cache.set("room_messages:1", "a")
        cache.set("room_messages:12", "b")
        cache.set("room_obj:1", "c")

        cache.invalidate_pattern("room_messages:")

        assert cache.get("room_messages:1") is None
        assert cache.get("room_messages:12") is None
        assert cache.get("room_obj:1") == "c"

    def test_cleanup_expired_leaves_live_entries(self):
        cache = CacheManager()
        cache.set("stale", "x", ttl_seconds=-1)
        cache.set("fresh", "y", ttl_seconds=60)

        cache.cleanup_expired()

        assert cache.get_stats()["size"] == 1
        assert cache.get("fresh") == "y"

    def test_stats_track_hits_and_misses(self):
        cache = CacheManager()
        cache.set("k", "v")
        cache.get("k")
        cache.get("absent")

        stats = cache.get_stats()
        assert stats["hits"] == 1
        assert stats["misses"] == 1
        assert stats["hit_rate"] == 50.0


@pytest.mark.unit
class TestEviction:
    """The cache must be bounded -- keys are per-room/per-agent and unbounded otherwise."""

    def test_evicts_when_over_max_size(self):
        cache = CacheManager(max_size=3)
        for i in range(5):
            cache.set(f"k{i}", i)

        stats = cache.get_stats()
        assert stats["size"] == 3
        assert stats["evictions"] == 2

    def test_evicts_least_recently_used(self):
        cache = CacheManager(max_size=3)
        cache.set("a", 1)
        cache.set("b", 2)
        cache.set("c", 3)

        cache.get("a")  # 'a' is now the most recently used, 'b' the least
        cache.set("d", 4)

        assert cache.get("b") is None
        assert cache.get("a") == 1
        assert cache.get("c") == 3
        assert cache.get("d") == 4


@pytest.mark.unit
class TestGetOrSet:
    """Factory invocation, including the cached-None case."""

    def test_computes_once_then_caches(self):
        cache = CacheManager()
        calls = 0

        def factory():
            nonlocal calls
            calls += 1
            return "computed"

        assert cache.get_or_set("k", factory) == "computed"
        assert cache.get_or_set("k", factory) == "computed"
        assert calls == 1

    def test_cached_none_is_not_recomputed(self):
        """A cached None must be a hit, not an endless factory re-run."""
        cache = CacheManager()
        calls = 0

        def factory():
            nonlocal calls
            calls += 1
            return None

        assert cache.get_or_set("k", factory) is None
        assert cache.get_or_set("k", factory) is None
        assert calls == 1


@pytest.mark.unit
class TestGetOrSetAsync:
    """Single-flight behaviour."""

    async def test_concurrent_misses_run_the_factory_once(self):
        cache = CacheManager()
        calls = 0
        release = asyncio.Event()

        async def factory():
            nonlocal calls
            calls += 1
            await release.wait()
            return "computed"

        waiters = [asyncio.create_task(cache.get_or_set_async("k", factory)) for _ in range(5)]
        await asyncio.sleep(0)  # let them all reach the factory / the in-flight future
        release.set()

        assert await asyncio.gather(*waiters) == ["computed"] * 5
        assert calls == 1

    async def test_cached_value_skips_the_factory(self):
        cache = CacheManager()
        await cache.set_async("k", "v")

        async def factory():
            raise AssertionError("factory must not run on a hit")

        assert await cache.get_or_set_async("k", factory) == "v"

    async def test_cached_none_is_not_recomputed(self):
        cache = CacheManager()
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            return None

        assert await cache.get_or_set_async("k", factory) is None
        assert await cache.get_or_set_async("k", factory) is None
        assert calls == 1

    async def test_factory_failure_propagates_to_all_waiters_and_caches_nothing(self):
        cache = CacheManager()
        release = asyncio.Event()

        async def failing_factory():
            await release.wait()
            raise RuntimeError("boom")

        waiters = [asyncio.create_task(cache.get_or_set_async("k", failing_factory)) for _ in range(3)]
        await asyncio.sleep(0)
        release.set()

        results = await asyncio.gather(*waiters, return_exceptions=True)
        assert all(isinstance(r, RuntimeError) for r in results)
        assert cache.get_stats()["size"] == 0

    async def test_key_is_usable_again_after_a_failure(self):
        """A failed computation must release its single-flight slot."""
        cache = CacheManager()

        async def failing_factory():
            raise RuntimeError("boom")

        async def good_factory():
            return "ok"

        with pytest.raises(RuntimeError):
            await cache.get_or_set_async("k", failing_factory)

        assert await cache.get_or_set_async("k", good_factory) == "ok"

    async def test_different_keys_do_not_block_each_other(self):
        cache = CacheManager()
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_factory():
            started.set()
            await release.wait()
            return "slow"

        async def fast_factory():
            return "fast"

        slow = asyncio.create_task(cache.get_or_set_async("slow", slow_factory))
        await started.wait()

        # Must not wait on the in-flight "slow" key.
        assert await cache.get_or_set_async("fast", fast_factory) == "fast"

        release.set()
        assert await slow == "slow"
