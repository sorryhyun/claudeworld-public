# Backend Cleanup Plan - Remaining Items

Items identified during backend audit but deferred from the initial cleanup pass.
Initial pass removed ~450 lines (write_queue, AgentNotFoundError, delete_agents_by_world, Agent.from_db_model, lock_key parameter, LocationService facade).

---

## Medium Priority

### WorldFacade passthrough removal
- **File**: `backend/services/facades/world_facade.py` (~486 lines)
- **Issue**: Most methods are thin orchestration wrappers (sync_from_fs, enter_world, delete_world) that could be inlined into router handlers
- **Approach**: Move orchestration logic directly into `routers/game/worlds.py`; delete facade
- **Risk**: Low — methods are sequential calls with no complex logic

### TransientStateService consolidation
- **File**: `backend/services/transient_state_service.py` (~181 lines)
- **Issue**: Wrapper around `_state.json` I/O. Most methods are one-liners delegating to file read/write. Already tightly coupled with RoomMappingService.
- **Approach**: Merge into RoomMappingService (which already imports and uses TransientStateService)
- **Risk**: Low — functional merge, no behavior change

---

## Low Priority

### CatalogService (Phase 2 speculative code)
- **File**: `backend/services/catalog_service.py` (~80 lines)
- **Issue**: Loads equipment slots, time domains, recharge events — zero current usage in gameplay loop
- **Approach**: Delete or move to `backend/future/` until Phase 2 begins

### PlayerFacade Phase 2 equipment methods
- **File**: `backend/services/facades/player_facade.py` (~180 lines of equipment code)
- **Issue**: `equip_item_to_slot()`, `unequip_from_slot()`, `use_item_affordance()`, `get_equipment()` — premature abstraction for future equipment system
- **Approach**: Remove equipment methods, keep core stat/inventory methods

### LocationStorage verbosity
- **File**: `backend/services/location_storage.py` (~268 lines)
- **Issue**: Some internal helper methods could be consolidated (~80-100 lines reducible)
- **Approach**: Inline small helpers, reduce method count
- **Risk**: Very low but also low impact

---

## Verified as Justified (Keep)

- **PlayerService** — mtime-based caching provides real performance benefit
- **WorldService** — essential FS-primary architecture cornerstone
- **RoomMappingService** — fuzzy location matching justifies dedicated service
- **All routers** — no dead endpoints found (44 endpoints, all active)
- **All schemas** — all actively used
- **services/__init__.py** — all 7 re-exports are used

---
---

# Fragility Remediation Plan

Separate track from the cleanup items above: these are correctness/robustness
defects rather than dead code. Found during a read-only review of `backend/`
(2026-08-06), alongside the `claude-agent-sdk` 0.1.48 → 0.2.131 bump and the
Opus 5 / Sonnet 5 model swap.

Every item was verified against the source at the cited `file:line`. Two items
from the initial verbal review did **not** survive verification and are recorded
as retractions at the end rather than silently dropped.

P0 = live defect with a plausible user-visible symptom. P1 = latent hazard.
P2 = structural debt.

---

## P0-1 — Background tasks leak DB sessions and can be garbage-collected

**Status: FIXED** (2026-08-06). `background_session()` added in
`infrastructure/database/connection.py`; `spawn_background()` /
`drain_background_tasks()` added in `infrastructure/background.py`; every call
site below converted; `traceback.print_exc()` replaced with `logger.exception`
across the backend; shutdown drains outstanding tasks in the app lifespan.
Covered by `tests/unit/test_background_tasks.py`.

Measured before/after with a `connect`/`close` listener on the sync engine: the
old pattern left a DBAPI connection open past the end of every coroutine, the
new one returns to 0.

**Severity:** high · **Confidence:** high · **Effort:** ~half a day

### What's wrong

Two independent defects sit on the same lines, in every "reply to the user, then
do the real work in the background" endpoint.

**(a) The session is never deterministically closed.**

```python
# backend/routers/messages.py:217
async for task_db in get_db_generator():
    try:
        ...
    finally:
        pass          # "Session cleanup handled by generator" — it isn't
    break             # <-- exits the generator without closing it
```

`get_db` (`infrastructure/database/connection.py:81`) is an async generator whose
cleanup lives in `async with async_session_maker() as session:`. That `__aexit__`
only runs when the generator is closed. Breaking out of `async for` does not
close it — finalization is deferred to the event loop's async-generator hooks at
GC time. Under SQLite + `NullPool`, each leaked session holds a connection until
then.

**(b) The task may be collected mid-flight.**

```python
# backend/routers/messages.py:257
asyncio.create_task(trigger_agent_responses())   # return value discarded
```

CPython's event loop holds only a **weak** reference to a running task. With no
strong reference, a task can be garbage-collected before it completes.
Exceptions are also lost — the handler logs, then calls `traceback.print_exc()`,
which writes to stdout and bypasses logging.

Together these are the most plausible root cause for intermittent "the agents
just never responded" reports.

### Call sites

| File | Generator-break | Fire-and-forget task |
|---|---|---|
| `routers/messages.py` | `:217` | `:257` |
| `routers/game/actions.py` | `:170` | `:197` |
| `routers/game/chat_mode.py` | `:43`, `:213`, `:468` | `:147`, `:234`, `:318` |
| `routers/game/worlds.py` | — | `:249` |
| `sdk/handlers/location_tools.py` | — | `:219` |
| `core/app_factory.py` | `:98` | — |

### Fix

1. Add a helper in `infrastructure/database/connection.py`:

   ```python
   @asynccontextmanager
   async def background_session() -> AsyncIterator[AsyncSession]:
       """Session for work outside a request. Do NOT use get_db() here —
       it is a FastAPI dependency generator and must be closed by FastAPI."""
       async with async_session_maker() as session:
           yield session
   ```

2. Replace every `async for task_db in get_db_generator(): ... break` with
   `async with background_session() as task_db:`.

3. Add a task registry so tasks stay referenced and failures surface:

   ```python
   _background_tasks: set[asyncio.Task] = set()

   def spawn_background(coro, *, name: str) -> asyncio.Task:
       task = asyncio.create_task(coro, name=name)
       _background_tasks.add(task)
       task.add_done_callback(_background_tasks.discard)
       task.add_done_callback(_log_task_exception)
       return task
   ```

   `_log_task_exception` calls `task.exception()` (ignoring `CancelledError`)
   and logs via `logger.exception`. Replace the bare `asyncio.create_task(...)`
   calls with `spawn_background(...)`.

4. Replace `traceback.print_exc()` with `logger.exception(...)`.

5. Await outstanding tasks on shutdown in the app lifespan.

### Verification

- Unit test: assert the session is closed once the task finishes (patch
  `async_session_maker`, assert `__aexit__` ran).
- Unit test: `spawn_background` on a coroutine that raises → assert the logger
  received the exception.
- Manual: send N messages, then check `gc.get_objects()` for `AsyncSession`
  instances, or enable SQLAlchemy pool logging and confirm connections return.

---

## P0-2 — `safe_read_file` is very likely broken on Windows

**Status: FIXED** (2026-08-06), all four sub-items, in
`infrastructure/locking.py`. Covered by `tests/unit/test_locking.py`, which
simulates the Windows paths by patching the module's platform flags and a stub
`msvcrt` (CI is POSIX, so the real thing still wants a Windows run).

**Correction to the diagnosis below:** `safe_read_file` has **zero callers** —
it is dead code, so it cannot be the shipped symptom. The same defect on the
*reachable* path is `sdk/loaders/cache.py:44`, which reads every YAML config
through `file_lock(path, "r")`. On Windows that raised, was swallowed at `:47`,
and returned `{}` — i.e. **all YAML config silently loaded as empty** on the
`.exe` build. Fixed by not attempting an advisory lock on read-only handles.

**Severity:** high on the Windows build · **Confidence:** medium-high (needs a
Windows box to confirm) · **Effort:** ~half a day

### What's wrong

`backend/infrastructure/locking.py:179-203`:

```python
with open(file_path, "r", encoding="utf-8") as f:
    ...
    elif HAS_MSVCRT:
        msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)   # needs a WRITABLE handle
```

`msvcrt.locking` on a read-only handle raises `OSError`. That propagates to the
function's outer `except Exception` (`:201`), which logs and **returns `""`**.

On the shipped Windows `.exe` (`HAS_FCNTL=False`, `HAS_MSVCRT=True`) this means
agent config reads can silently yield empty content instead of failing loudly.

Three related defects in the same module:

- **`file_lock` gives no mutual exclusion on Windows.** `msvcrt.locking` locks
  *N bytes from the current file position*. In `"a"` mode the position is EOF, so
  two concurrent appenders lock **different** byte ranges and both proceed
  (`:105`).
- **`file_lock(path, "w")` truncates before locking.** `open(path, "w")` at `:96`
  destroys the file, then the lock is taken at `:99`. A concurrent reader can
  observe an empty file.
- **`HAS_MSVCRT` is conditionally defined.** It is only assigned inside the
  `except ImportError` branch (`:28-39`); when `fcntl` imports successfully it is
  never bound. Currently harmless because `HAS_FCNTL` is always checked first and
  short-circuits, but it is a latent `NameError` one refactor away.

### Fix

1. Define `HAS_MSVCRT = False` at module scope, before the `try`.
2. `safe_read_file`: on Windows, either open `"r+"` when a lock is genuinely
   needed, or skip advisory locking for reads entirely.
3. Make writes atomic instead of locked: write to a temp file in the same
   directory, then `os.replace()` (atomic on POSIX and Windows). This closes the
   truncate-before-lock window and removes most of the need for `file_lock`.
4. Narrow the `except Exception` in `safe_read_file` so a *lock* failure is
   logged but the read still proceeds. Never return `""` for "I could not read
   it" — that is indistinguishable from a legitimately empty file. Raise, or
   return `str | None`.

### Verification

- On Windows (or a Wine/CI runner), assert `safe_read_file` returns real content.
- Assert two concurrent appenders to the same path both land.
- Assert a missing file and an unreadable file are distinguishable to the caller.

---

## P1-1 — Cancellation during DB I/O on a shared session

**Status: FIXED** (2026-08-06). Most of "give the background task its own
session" already fell out of P0-1, as anticipated. What remained:
`background_session()` now **invalidates** rather than closes on cancellation
(`connection.py`), because a normal `close()` issues a ROLLBACK on a connection
that may be part-way through a statement; and `run_uninterruptible()`
(`infrastructure/background.py`) wraps the two response-persistence writes in
`response_generator.py` so an interrupt cannot land between the INSERT and the
COMMIT. Note that helper is deliberately *not* a bare `asyncio.shield` — shield
re-raises in the caller immediately and leaves the write running loose, which
the enclosing `background_session()` would then close out from under. Covered by
`tests/unit/test_background_tasks.py`.

**Not addressed:** concurrent agent coroutines within one tape still share
`orch_context.db`. That is a separate defect from the cancellation one and
fixing it means re-plumbing ORM objects across sessions.

**Severity:** medium · **Confidence:** medium · **Effort:** ~1 day

`orchestration/orchestrator.py:275` (and `trpg_orchestrator.py:212`,
`chat_mode_orchestrator.py:177`) start a processing task that borrows the
caller's `AsyncSession` via `OrchestrationContext.db`. When a new user message
arrives, `interrupt_room_processing` cancels that task
(`trpg_orchestrator.py:411`, `chat_mode_orchestrator.py:214`).

Cancelling a coroutine parked inside `await session.execute(...)` leaves the
session/connection in an indeterminate state — and the session is then reused.
The `asyncio.wait_for(..., timeout=PROCESSING_TIMEOUT)` at `orchestrator.py:288`
can cancel at the same point.

**Fix:** give the background task its own session (falls out of P0-1's
`background_session` helper), so cancellation can only poison a session that is
about to be discarded. Shield genuinely non-interruptible commit sequences with
`asyncio.shield`, and treat a cancelled task's session as tainted — close it
rather than reuse it.

**Verification:** a test that cancels a task mid-`execute` and asserts the next
operation on a fresh session succeeds.

---

## P1-2 — `retry_on_db_lock` matches too broadly and retries a poisoned session

**Status: FIXED** (2026-08-06) in `connection.py`. Matching is now restricted to
SQLite's own `"database is locked"` / `"database table is locked"`, read from the
DBAPI exception under SQLAlchemy's wrapper (`.orig`). The decorator finds the
`AsyncSession` in the call arguments and rolls it back between attempts, and
`max_retries < 1` raises `ValueError` at decoration time instead of `raise None`
at call time. Covered by `tests/unit/test_database.py`.

**Also found:** those tests were all *skipping*. `DATABASE_URL` is unset under
test, so `DATABASE_TYPE` defaulted to `postgresql` and the decorator was a no-op
passthrough. `tests/conftest.py` now pins SQLite, which is what ships.

**Severity:** medium · **Confidence:** high · **Effort:** ~2 hours

`infrastructure/database/connection.py:152`:

```python
if "database is locked" in exc_msg or "locked" in exc_msg:
```

The second clause makes the first redundant and matches far more than intended —
`"deadlocked"`, and any application error whose message happens to contain
"locked". Those get retried up to 5 times with backoff.

Worse, the retry re-invokes the wrapped function without rolling back. If the
failure happened mid-transaction the session is already in a failed state, so all
5 attempts fail and the ~3s of backoff is pure added latency.

Also, `raise last_exc` at `:163` raises `None` (→ `TypeError`) when
`max_retries <= 0`.

**Fix:** match `"database is locked"` / `"database table is locked"` only —
ideally by catching `sqlite3.OperationalError` rather than string matching. Roll
back before retrying (this likely means converting the decorator into a context
manager used at the call site, so it can see the session). Guard the
`max_retries <= 0` case.

**Verification:** unit test that an exception reading `"account is locked"` is
raised immediately rather than retried.

---

## P1-3 — `cache.py` guards one dict with two unrelated locks

**Severity:** low today, medium if threading is ever introduced ·
**Confidence:** high (design), corrected on live impact · **Effort:** ~half a day

**Status: FIXED** (2026-08-06). `infrastructure/cache.py` now uses a single
`threading.Lock` for all state, sync and async alike — correct under both
threading and asyncio, and every critical section is pure dict work with no
`await` inside, so it never stalls the loop. (Making every method async was the
other option, but `Agent.get_config_data()` in `models.py` is a sync ORM method
that calls `cache.get`/`cache.set`, so that would have forced a much wider
refactor.) Storage is an `OrderedDict` with LRU eviction at `max_size=2000`, and
`get_or_set_async` is single-flight via a per-key `asyncio.Future`. Covered by
the new `tests/unit/test_cache.py` — there were no cache tests at all before.

**Correction:** "`cleanup_expired` has no caller" is wrong. It is called by
`infrastructure/scheduler.py:220` (`_cleanup_cache`) every 5 minutes. The
unbounded-growth concern stands anyway between sweeps, hence the LRU cap.

`infrastructure/cache.py` protects `self._cache` with a `threading.Lock` in the
sync methods (`:76`, `:101`, `:116`, `:131`) and a separate `asyncio.Lock` in the
async ones (`:190`, `:215`, `:232`). **The two do not exclude each other.**

**Correction to the initial review:** I first reported this as a live race via
FastAPI's sync-endpoint threadpool. That is **not** currently reachable — there
are no sync (`def`) route handlers, no `run_in_executor`, no `asyncio.to_thread`,
and the scheduler is `AsyncIOScheduler` (`infrastructure/scheduler.py:44`), so
everything runs on one event-loop thread. Current usage is 16 sync
`invalidate`/`invalidate_pattern` calls against 6 `get_or_set_async` calls; on a
single thread the loop serializes them.

So this is a **latent** hazard, not an active bug. It becomes real the moment
someone adds a sync endpoint or a worker thread. Two genuine issues remain
regardless:

- **No eviction / unbounded growth.** `cleanup_expired` (`:147`) exists but has
  no caller — expired entries are only dropped when read again. Keys are
  per-room and per-agent, so the dict grows with world count.
- **`get_or_set_async` is not single-flight.** It releases the lock across
  `await factory()` (`:244`), so N concurrent misses run the factory N times.

**Fix:** pick one concurrency model — for an asyncio-only app, drop the
`threading.Lock` and make every method async. Add a max size with LRU eviction,
or schedule `cleanup_expired` on the existing `AsyncIOScheduler`. For
single-flight, store an `asyncio.Future` per in-flight key so concurrent callers
await the same computation.

---

## P2 — Migrations are hand-rolled, unversioned, and run on every boot

**Status: FIXED** (2026-08-06). Alembic adopted, configured programmatically in
`infrastructure/database/alembic_runner.py` — there is no `alembic.ini`, so the
URL and target metadata have one definition and the `.exe` has one fewer data
file. `init_db()` now branches three ways: empty database → run the revisions;
tables but no `alembic_version` → run the legacy catch-up once, verify, stamp;
stamped → upgrade. CLI is `scripts/alembic_cli.py` (`poe migration`,
`poe migration-new`, `poe migration-check`).

**Deviation from step 3 of the plan below:** the 929 lines were *not* ported to
per-table revisions, deliberately. Every database that needs those ALTERs is
pre-Alembic by definition and is handled by the catch-up path; every database
that does not already matches the baseline revision. Porting them would have
produced revisions that never run for anyone. `migrations.py` is now frozen and
documented as such, and can be deleted once no supported upgrade path starts
from a pre-Alembic database.

**On the blanket `except Exception` (step 5):** kept, because several of them
guard DDL that legitimately may not apply (constraint names that vary by
database age, `DROP COLUMN` on older SQLite). What makes them safe is
`verify_schema_matches_models()`, which diffs the finished schema against
models.py before stamping and raises on a missing table or column — so anything
they swallow surfaces as a hard error rather than a half-migrated schema.
Cosmetic diffs (types, server defaults, index naming) warn instead, since a
database grown through years of ALTERs differs harmlessly in those ways and
hard-failing would brick real upgrades.

`_sync_agents_from_filesystem` is now `sync_agents_from_filesystem`, called by
`init_db` in its own transaction (step 4). Drift check runs in CI (step 2);
verified it exits non-zero when a column is added to models.py without a
revision. Covered by `tests/unit/test_alembic_migrations.py`.

**Severity:** medium (operational) · **Confidence:** high · **Effort:** 2-3 days

`infrastructure/database/migrations.py` is 929 lines of idempotent "add column if
missing" logic, executed on every startup inside a single `engine.begin()`
transaction (`:41-64`).

- **No version tracking.** No `alembic_version` equivalent, so there is no way to
  know which migrations a given database has seen, and no down-migrations.
- **Drift is silent.** `Base.metadata.create_all` handles fresh installs and the
  hand-written `ALTER`s handle upgrades. Nothing checks that the two agree, so a
  column added to `models.py` but not to `migrations.py` works on fresh installs
  and is missing on upgrades.
- **Failures are swallowed.** `except Exception` around DDL at `:230`, `:303`,
  `:308`, `:316`, `:319`, `:328`, `:460` means a failed migration can leave a
  half-migrated schema that the app then runs against.
- **A data migration rides inside the schema transaction.**
  `_sync_agents_from_filesystem` (`:509`) does filesystem I/O and data writes in
  the same transaction as the DDL.

**Fix (incremental, safest order):**

1. Add Alembic; `alembic stamp head` existing databases so they are not
   re-migrated.
2. Add a CI check that autogenerate produces an empty diff against `models.py`.
   This catches drift permanently and is worth doing even before step 3.
3. Port existing migrations to Alembic revisions one table at a time, keeping the
   legacy path behind a flag until a release has soaked.
4. Move `_sync_agents_from_filesystem` out of migrations into an explicit startup
   step with its own transaction and error handling.
5. Remove the blanket `except Exception` wrappers — a migration failure should
   abort startup loudly.

---

## P2 — Test and config hygiene

**Status: FIXED** (2026-08-06), all three items, plus two things found on the way.

- **(#1)** Deleted `backend/pytest.ini`; the root `pyproject.toml` block is the
  only config and every `poe` task now runs from the repo root (`cd backend` was
  also silently breaking `test-cov`, whose `--cov=backend` resolved to a
  nonexistent `backend/backend`). Marker list merged, `--strict-markers` kept,
  `-p no:warnings` dropped in favour of `filterwarnings`.
- **(#2)** *Three* tests hung, not one — the whole of `TestGenerateSDKResponse`.
  They were written against a `receive_response()` architecture the code no
  longer uses: a pump task in `ClientPool` drains the client into
  `pooled.msg_queue`, and `get_or_create` returns `(PooledClient, is_new, Lock)`,
  not the client. The AsyncMock queue returned a fresh MagicMock forever, which
  is neither the `None` sentinel nor a `ResultMessage`, so the read loop spun
  without end. Rewritten around a real `PooledClient` with a real
  `asyncio.Queue`. The four outright failures were all stale assertions, not
  regressions: `starting_location` became required on `CompleteOnboardingInput`;
  `max_thinking_tokens` was replaced by adaptive thinking; `StreamParser` now
  deliberately ignores a trailing `AssistantMessage` TextBlock once deltas have
  accumulated (it holds the whole turn, so appending duplicated the response).
  All 133 now pass.
- **(#3)** Stale `write_queue.py` references were in five files, not two:
  `CLAUDE.md`, `AGENTS.md`, `backend/README.md`, `backend/ARCHITECTURE.md`,
  `.claude/agents/backend-dev.md`.

**Found while wiring CI:** there was no test workflow at all
(`.github/workflows/` had only the two Claude actions and the release build), so
`-m sdk` was not the only thing unguarded — nothing ran. `tests.yml` now runs
ruff, `-m unit` (SDK included), `-m integration`, and the schema drift check.

**Found while wiring CI (2):** the integration suite was *entirely broken* — 39
of 43 tests errored at setup. `get_jwt_secret()` calls `sys.exit(1)` when
`JWT_SECRET` is unset, so the suite passed only on a machine with a populated
`.env`. `tests/conftest.py` now pins `JWT_SECRET`, `API_KEY_HASH` and
`DATABASE_URL` at import. All 43 pass.

Cheap, and reduces the chance of everything above regressing.

1. **Two competing pytest configs.** `backend/pytest.ini` and
   `[tool.pytest.ini_options]` in root `pyproject.toml` both exist. Because
   `poe test` does `cd backend && pytest`, the `.ini` wins and the root block is
   dead config — edits to it silently do nothing. They have already drifted (root
   lacks `--strict-markers` / `-p no:warnings`; the ini lacks `filterwarnings`).
   **Fix:** delete one. Either keep `backend/pytest.ini` and make the poe tasks
   the only entry point, or delete the ini and always run from the repo root.

2. **The SDK test suite hangs and never completes** (129 tests, `-m sdk`).
   Confirmed pre-existing: reproduced identically on 0.1.48 with all changes
   stashed, so it is not from the version bump. The hang is
   `test_generate_response_basic_flow` at `sdk/agent/agent_manager.py:364`,
   awaiting `pooled.msg_queue.get()` on a `MagicMock` that never resolves;
   roughly four other tests fail outright.
   **Fix:** give the mocked `msg_queue` a real `asyncio.Queue` pre-loaded with a
   `ResultMessage` and the `None` end sentinel. Then wire `-m sdk` into CI so it
   cannot rot again — being excluded from `poe test` is why it did.

3. **Stale docs.** `CLAUDE.md` and `backend/README.md` both document
   `infrastructure/database/write_queue.py`. That file was deleted in the initial
   cleanup pass (see top of this document); the doc references were missed.

---

## Retractions from the initial verbal review

Recorded so they are not re-litigated later.

- **"`ClientPool._task_locks` / `_usage_locks` grow forever" — withdrawn.**
  They are removed on pool eviction (`sdk/client/client_pool.py:525-526`,
  `:558-559`), and the `cleanup_stale_locks` sweep (`:572`) *is* wired up — via
  `AgentManager.cleanup_stale_resources` (`sdk/agent/agent_manager.py:101`),
  called from `infrastructure/scheduler.py:233`. No leak. A minor TOCTOU remains
  (pool membership is read at `client_pool.py:366` outside the lock), but it is
  re-checked under the lock at `:418`, which is the correct double-checked
  pattern. No action.

- **"`cache.py` has a live threadpool race" — downgraded to latent.** See P1-3.
  The design flaw is real; the exploit path is not currently reachable.

---

## Suggested sequencing

| Order | Item | Why first |
|---|---|---|
| 1 | ~~P0-1~~ done | Highest user-visible impact; unblocks P1-1 |
| 2 | ~~P2 test hygiene~~ done | Need a trustworthy suite before touching more |
| 3 | ~~P0-2~~ done | Isolated to one module; ships in the Windows build |
| 4 | ~~P1-1~~ done | Mostly falls out of P0-1 |
| 5 | ~~P1-2, P1-3~~ done | Small and independent |
| 6 | ~~P2 migrations~~ done | Largest; do it with the suite green |
