# ClaudeWorld Backend Migration Plan: Python → TypeScript + Bun

**Status:** Phases 0, 1, 2 and 3 complete (Phase 3 on 2026-08-22; its one open item is the live
frontend onboarding+gameplay pass, which needs a human and a Claude session). The repo root is a Bun workspace over
`backend-ts/` and `frontend/` (one `bun install`, one `bun.lock`), and the Python helper
scripts have moved from `scripts/` to `backend/scripts/` so they retire with the Python
tree; `scripts/` now holds only the release installers and the deploy shell script. Work lives in `backend-ts/`; the Python backend is untouched. `make dev` runs the TS backend and `make dev-python` runs the Python one. 1,500+ unit tests, `tsc`, `eslint` and the drift gate are clean, and `bun run smoke` boots the assembled backend against a throwaway database and exercises the real routes.
**Next:** Phase 4 — the parity harness that diffs integration scenarios across the two backends. That, not line-coverage parity, is the cutover gate.
**Goal:** Replace the Python/FastAPI backend with a TypeScript backend running on Bun, using `@anthropic-ai/claude-agent-sdk`, so the whole personal ecosystem (ClaudeWorld + yaar) shares one language, one toolchain, and one packaging pipeline.

## Why

- The TS and Python Agent SDKs are at feature parity and both wrap the same bundled Claude Code CLI, so nothing is lost capability-wise.
- `../yaar` already runs the TS Agent SDK (0.3.233) in production with a full provider layer (`packages/server/src/providers/claude/`: sdk-options, message-mapper, errors, escape-hook) and has a working cross-platform `bun build` exe pipeline — the riskiest parts of this migration are already solved once and can be cribbed.
- ClaudeWorld is the last Python project in the ecosystem; consolidating removes a second toolchain, test runner, and release pipeline.

## Hard Constraints (parity contract)

These make the migration invisible to users and keep rollback cheap:

1. **SQLite schema stays byte-compatible.** An existing `claudeworld.db` must open unmodified in the TS backend. The Drizzle schema is written to match the current Alembic head exactly; no data migration.
2. **REST + polling API contract is frozen.** Same paths, same JSON shapes, same auth flow. The React frontend ships zero changes for the cutover.
3. **Filesystem-primary architecture is preserved.** `agents/{name}/*.md`, `group_config.yaml`, `guidelines_3rd.yaml`, hot-reload semantics, and third-person config format all work identically.
4. **`.env` keeps working.** Existing `API_KEY_HASH` bcrypt hashes must verify (Bun.password auto-detects `$2b$` bcrypt hashes), `JWT_SECRET` and all optional vars keep their names.
5. **The Python backend stays runnable** (untouched on `master`) until the TS backend passes the parity test suite; work happens in `backend-ts/` on a branch.

## Target Stack

| Concern | Python (current) | TypeScript (target) | Notes |
|---|---|---|---|
| Runtime | uvicorn / CPython | Bun | |
| HTTP framework | FastAPI | **Hono** (confirmed 2026-08-21) | Small, fast, first-class Bun support, SSE streaming helper. Elysia was the alternative; its headline feature is end-to-end type safety into the frontend, which is worth nothing here because the parity contract says the React app ships unchanged. Routing overhead is not a factor either — a turn spawns CLI subprocesses and waits tens of seconds on the model. Hono wins on ecosystem breadth for the pieces actually needed: SSE, static serving, rate limiting. |
| ORM / migrations | SQLAlchemy + Alembic | **Drizzle** + `bun:sqlite` | Baseline generated from the current schema; Alembic history is not replayed. `bun:sqlite` is synchronous — fine for SQLite, removes the aiosqlite/greenlet layer entirely. |
| Validation / schemas | Pydantic | **Zod 4** | Same lib as yaar; schemas shared with tool definitions. |
| Agent SDK | `claude-agent-sdk` 0.2.131 | `@anthropic-ai/claude-agent-sdk` **≥0.3.233** | Match or exceed yaar's pin. ≥0.3.144 required for `extractFromBunfs()` (single-exe support). |
| Auth | bcrypt + PyJWT | `Bun.password.verify` + **jose** | Confirmed in Phase 1: existing `$2b$` hashes verify, and tokens round-trip between the two backends in both directions. |
| Scheduler | APScheduler | **croner** (or plain `setInterval`) | Only autonomous-round cadence is needed; APScheduler is overkill to replicate. |
| Images | Pillow | **sharp** | WebP conversion path in `utils/images.py`. |
| Rate limiting | slowapi | **tiny fixed-window middleware** | Settled in Phase 1. slowapi is used for exactly one route; a dependency would be more moving parts than the thing it limits. `src/http/middleware/rate-limit.ts`, same algorithm and same 429 body. |
| Hot reload of agent files | watchfiles | `fs.watch` (chokidar if edge cases appear) | |
| File locking | custom `infrastructure/locking.py` | **proper-lockfile** | Phase 1 note: the actual guarantee is atomic rename plus `O_APPEND`, not the lock. `proper-lockfile` covers read-modify-write only and, being directory-based, does not interlock with Python's `fcntl` locks. |
| MCP endpoint | fastapi-mcp | `@modelcontextprotocol/server` | Same packages yaar uses. |
| Lint / format | ruff | eslint + typescript-eslint (yaar's catalog config) | |
| Tests | pytest | `bun test` | |

## Scope Inventory (current Python LOC, excluding tests)

| Area | LOC | Port difficulty |
|---|---|---|
| `sdk/` (agent, client, handlers, tools, loaders, parsing) | ~10,900 | **High** — SDK API differences; this is the pilot |
| `orchestration/` + `tape/` | ~3,560 | High — depends on sdk/ |
| `services/` (+ facades) | ~4,180 | Medium |
| `routers/` (+ game/) | ~3,640 | Low — mechanical once services exist |
| `infrastructure/` (db, logging, cache, locking, scheduler) | ~4,430 | Medium |
| `crud/` | ~2,740 | Low |
| `domain/` (entities, services, value_objects) | ~2,590 | Low |
| `core/`, `schemas/`, `i18n/`, `utils/`, entrypoints | ~2,290 | Low |
| **Total** | **~34,300** | |
| Tests (`tests/unit` + `integration` + fixtures) | ~9,000 | Ported selectively (see Phase 4) |

## Phases

### Phase 0 — Pilot: SDK + one full game turn ✅ *complete — GO*

Delivered in `backend-ts/` on branch `ts-migration-phase0`. `bun run pilot` drives a scripted
player action through the real two-cell tape against a seeded SQLite database, with no HTTP
server, and asserts the result against the database rather than the return value.

**The stated go/no-go risk was a false premise.** The plan assumed there is "no `ClaudeSDKClient`
equivalent" and that persistent sessions would have to become one-shot `query()` calls with
`resume`. In fact `query()` accepts an *async iterable* as its prompt, and when given one the CLI
runs in streaming-input mode: one subprocess, one open control channel, N turns pushed in over its
lifetime, plus `interrupt()`. That is structurally what `ClaudeSDKClient` wraps, so the client pool
is a translation, not a redesign. Confirmed against a live CLI before anything else was built
(`src/scripts/spike-session.ts`): three turns on one session id, MCP tools callable on every turn,
hooks firing, and a `Task` sub-agent successfully calling a parent-provided MCP tool — the last
being the one capability that genuinely has no `resume`-based workaround.

Three details are load-bearing and cost real time to discover:

- **Manual `stream.next()`, never `for await`.** A `for await` that `break`s calls `.return()` and
  tears the session down; the turn must end at the `result` message while the stream stays alive.
- **Never call `Query.streamInput()`.** Despite the name it drains the iterable and then ends the
  CLI's stdin, killing a session meant to serve later turns.
- **A background pump, not consumer-driven reads.** Sub-agents can call MCP tools *after* the
  parent's `result`; if nobody drains the stream between turns the CLI cannot service `tools/call`.

**Exit criteria, verified across two consecutive turns (14 assertions):** both cells run, every NPC
reacts, `narration` fires and persists a message, narration streams incrementally via the
partial-JSON extractor, NPC reactions land in the message's `thinking` column, `suggest_options`
writes to `_state.json`, session ids persist for every agent, `recall` reads long-term memory, the
`PreToolUse` hook observes every tool call, and — the pool's whole reason to exist — turn two reuses
the same warm sessions with unchanged session ids.

**Also settled in Phase 0** (ahead of the plan, because the pilot needed them): the full Drizzle
schema for all 8 tables verified against a real `claudeworld.db`; the config/settings/paths layer;
the YAML loaders with mtime hot-reload; agent-config and memory parsing; Korean particle agreement;
the prompt builder; the CRUD surface for a turn; and the world/player/location/room-mapping
filesystem services. 211 unit tests, `tsc` and `eslint` clean.

**Parity landmine found and fixed:** SQLAlchemy stores `DateTime` columns in SQLite as *text*
(`2026-08-06 04:14:54.931812`), not as Unix integers. Drizzle's `integer({ mode: 'timestamp' })`
would have silently produced rows the Python backend cannot read. `src/db/columns.ts` reproduces
the format exactly.

### Phase 1 — Foundation ✅ *complete*

`bun run dev` starts a server that boots, opens or creates its database, authenticates, and
serves `/auth/login`, `/auth/verify` and `/auth/health`. 361 unit tests, `tsc` and `eslint`
clean, and a `backend-ts` CI job running typecheck, lint, tests and the drift gate alongside
the existing Python job.

- [x] Config/env loading (`core/`) — `src/config/{settings,paths}.ts`. All env var names preserved;
      `sys.frozen` replaced by a `CLAUDEWORLD_ROOT` override plus upward root discovery.
- [x] Logging infrastructure — `src/infrastructure/logging/`. Named leveled loggers in Python's
      exact line format (`logger.ts`), `latency.log` in Python's exact entry format (`perf.ts`),
      and the `debug.yaml`-driven agent transcript plus JSON message formatter (`agent-log.ts`).
      `turn-telemetry.ts` adapts Phase 0's `onEvent`/`onTelemetry` callbacks to those sinks, so
      the SDK layer still logs nothing directly. The fourteen `console.warn`/`console.error` call
      sites left over from Phase 0 now route through the logger, so the level setting is not a
      lie for half the backend.
- [x] In-memory cache — `src/infrastructure/cache.ts`. TTL, LRU cap, single-flight
      `getOrSetAsync`. *Not wired into CRUD*: Python's cached CRUD layer is `crud/cached.py`,
      which Phase 2 owns. The mtime caches inside the filesystem services remain a different
      thing — they are the hot-reload mechanism, not a request cache.
- [x] File locking — `src/infrastructure/locking.ts` (`proper-lockfile`). *Not wired into a
      writer yet*: the only caller in Python is `services/agent_config_service.py`, a Phase 2
      service. Note the guarantee is carried by atomic rename and `O_APPEND`, not by the lock;
      the lock covers read-modify-write only, and being directory-based rather than `flock` it
      does **not** interlock with the Python backend — acceptable only because the two never
      run at once.
- [x] Drizzle schema for **all** tables — `src/db/schema.ts`, all 8 tables plus `alembic_version`,
      verified column-for-column against a real `claudeworld.db` by `src/scripts/verify-schema.ts`.
- [x] Drift gate + migrations applied on startup. `drizzle/0000_baseline_schema.sql` is the
      committed baseline; `src/db/migrate.ts` applies it on startup and `bun run migration-check`
      is the CI gate — it builds a database from the migrations alone and diffs it against
      `schema.ts`, exactly what `alembic check` does for Python. With `--against <db>` it also
      diffs against a real Python-created database.
- [x] Auth — `src/auth/`. `Bun.password.verify` against existing `$2b$` hashes, `jose` HS256
      tokens with the same five claims, guest login flag, and a fixed-window limiter replacing
      slowapi (20/minute per IP on login, same 429 body).
- [x] Hono app skeleton — `src/http/`. CORS, the ported auth middleware exclusion table, the
      auth router, FastAPI's `{"detail": ...}` error envelope, and `src/main.ts`.

**Not carried over, deliberately:** `@track_perf` / `@track_interaction`. Those decorators exist
to recover `room_id` and `agent_name` out of a wrapped function's bound arguments via
`inspect.signature`; there is no TypeScript equivalent and no need for one, because every call
site already holds the context.

**Deferred:** `/auth/health/pool` reports on the SDK client pool, which no part of the HTTP layer
owns yet. It returns to the auth router when Phase 3 wires the pool into app state.

**Three parity landmines found and fixed:**

- **`.default()` on a Drizzle column emits a SQL `DEFAULT`; SQLAlchemy's `default=` does not.**
  Only `rooms.is_paused`, `rooms.is_finished` and `messages.timestamp` carry real server
  defaults. Seven other columns in `schema.ts` had `.default()` and would have produced a fresh
  install whose DDL no existing database shares. They now use `$defaultFn`, which fills the
  value into the INSERT the way the ORM does without touching the DDL.
- **A fresh TypeScript install left `alembic_version` empty.** Python reads that as "under
  Alembic control, at no revision", re-runs the baseline revision and dies on
  `CREATE TABLE agents`. A fresh install now stamps the Alembic head, which is what makes the
  documented rollback story actually true rather than assumed. Verified by running Python's
  `init_db()` against a TypeScript-created database: *"Database schema up to date
  (e872d9c86c83)"*.
- **A router held as a module singleton shares its rate-limit counters across apps.** The auth
  router is a factory (`createAuthRoutes()`), which is the shape Phase 2 needs anyway to inject
  the agent manager and orchestrator.

**Remaining cross-backend schema differences, all verified equivalent** by
`bun run migration-check --against <db>` against both a fresh Alembic database and a real
`claudeworld.db`: SQLAlchemy writes `VARCHAR`/`BOOLEAN` where Drizzle writes `text`/`integer`
(same SQLite affinity, except `BOOLEAN`→NUMERIC vs `INTEGER`, which is the one equivalence
written down explicitly in `src/db/introspect.ts`), foreign keys are declared in a different
order, and `player_states.world_id` is an inline `UNIQUE` on one side and a named unique index
on the other. The gate matches implicit indexes on their columns rather than their names, so
that constraint is genuinely verified rather than skipped.

**Known limitation:** the TypeScript backend refuses to adopt a database whose schema is behind
the Alembic head — there is no equivalent of `migrations.py`'s legacy catch-up. Before cutover
this needs either a decision that such databases must be upgraded by the Python backend first,
or a catch-up path of its own.

### Phase 2 — Game core ✅ *complete*

The whole game surface now runs on the TypeScript backend: a world can be created, interviewed
into existence, entered, played turn by turn, chatted in, travelled through, and polled — all
through the frozen REST contract the React app already speaks.

- [x] `domain/`, `crud/`, `services/`. `crud/` is complete for the game surface (chat-mode state
      transitions, inventory and stat mutation, every world/room/agent write, and the cached
      readers). `services/` gained the agent config/filesystem/cache facades, the agent factory,
      the persistence manager, the deletion-with-cleanup paths, history compression, and the
      player facade. `domain/` is a layer rather than a scattering of inline enums.
- [x] `schemas/` as Zod 4. All of `backend/schemas/`, including Pydantic's lax-mode request
      coercion, which Zod does not reproduce by default — a client sending `{"max_interactions":
      "20"}` would have started 422-ing at cutover.
- [x] `orchestration/` + `tape/`: the 2-cell gameplay tape, the onboarding tape, chat mode, and
      the room-level orchestrator (`src/orchestration/room-orchestrator.ts`) that tracks the
      in-flight turn, discards superseded responses, holds the transient status the poller
      reports, and interrupts.
- [x] `routers/game/` — every endpoint, 1:1 with `backend/routers/game/`, with integration tests
      that stand up the real Hono app over a temp database.

**The plan's own Phase 2 status section was stale, and the gap it hid was the SDK tool surface.**
Phase 0 cut a vertical slice — the parts one gameplay turn touches — and recorded `sdk/` as done.
In fact 8 of ~30 tools existed: no `travel`, no `change_stat`, no onboarding server, no sub-agent
persist tools, and no `group_config.yaml` tool-override mechanism at all, which is the feature the
whole "filesystem-primary, hot-reloading" architecture rests on. All of it is ported now, across
five MCP servers selected by a `ServerRole`.

**Three structural decisions worth carrying forward:**

- **The interrupt order is the reverse of Python's.** Stopping a turn is two actions: tell the CLI
  to stop, then unwind the local await. `SessionPool.interruptRoom` only reaches sessions it finds
  *busy*, and a session stops being busy the moment its read is aborted — so aborting first leaves
  every subprocess generating a response nobody is waiting for. Python could cancel first because
  `asyncio.Task.cancel()` propagates into the SDK client; an `AbortSignal` unwinds our own read and
  nothing more.
- **The SDK layer never imports orchestration.** Tools report progress and fire turn side effects
  (`narration` produced, sub-agent active, NPC memory round, destination pre-connect) through
  callbacks on `ServerDeps`, wired in `src/http/state.ts`. The dependency runs one way.
- **Per-world services are factories, not instances.** `PersistenceManager` and `PlayerFacade` both
  write to one world's row; a long-lived instance would write the right `player.yaml` and mirror it
  onto somebody else's record. `buildServers` binds them per turn.

**Fixed on the way in:** `world-services.test.ts` pointed `REAL_WORLDS_DIR` at the repo's own
`worlds/` directory, which is `.gitignore`d — so the suite passed only on a machine that had played
that exact world locally and failed with 34 errors on every fresh checkout, including CI. The
fixture is checked in under `src/tests/fixtures/worlds/`.

**Known gaps, all deliberate and pinned by tests:**

- `chatting_agents[].thinking_text` / `response_text` are always `""`. Python reads them from
  `AgentManager.get_streaming_state_for_room`; the TS SDK keeps that state on the turn and nothing
  publishes it per room. `has_narrated` — the flag that actually unblocks the input box — is wired.
- No agent pre-connect in `GET /worlds/{id}` and `POST /worlds/{id}/enter`.
  `RoomOrchestrator.preConnectLocation` needs a turn in flight, which is precisely not the case
  there. Latency only; the responses are identical.
- ~~`try_compress_image` is a pass-through until `sharp` arrives with the Phase 3 message
  routes.~~ **Closed in Phase 3** — `src/lib/images.ts` on `sharp`, same quality/effort settings
  and the same return-the-originals-on-failure contract.
- `equip_item`, `unequip_item`, `use_item`, `list_equipment` and `set_flag` are declared with no
  handler — exactly as in Python, where no factory produces them. `domain/player-rules.ts` already
  has every rule they need, so implementing them is a decision, not a port.

### Phase 3 — Remaining surface ✅ *complete, bar the live frontend pass*

Every router Python has now exists in TypeScript, the scheduler runs autonomous rounds on the
same two-second cadence, and images are really compressed rather than passed through.

- [x] Routers: `agents`, `agent_management`, `rooms`, `room_agents`, `messages`, `sse` (done
      earlier in the phase — see [Chat rooms](../CLAUDE.md#chat-rooms)), then `mcp_tools`
      (`src/http/routes/mcp-tools.ts`), `debug` (`routes/debug.ts`) and `readme`
      (`routes/readme.ts`).
- [x] `GET /auth/health/pool`, deferred out of Phase 1 because no part of the HTTP layer owned a
      pool yet. `SessionPool.stats()` is the reporter; `AppState.pool` is what the router reads.
- [x] Background scheduler — `src/infrastructure/scheduler.ts` plus `runAutonomousRound` in
      `orchestration/turn.ts` and `RoomOrchestrator.handleAutonomousRound`. Constructed in
      `createAppState`, started in `main.ts`, stopped first in `AppState.shutdown()`.
- [x] Image upload / WebP conversion — `sharp` behind `src/lib/images.ts`, replacing the
      Phase 2 pass-through.
- [x] i18n. Effectively already done: `i18n/korean.py` is `src/lib/korean.ts` and
      `i18n/serializers.py` is folded into `src/schemas/common.ts`. See the finding below for
      `i18n/timezone.py`.
- [x] Agent-file hot-reload watcher. **There is nothing to port** — see the finding below.
- [ ] Frontend smoke pass: run the untouched React app against the TS backend through full
      onboarding + gameplay. Not yet done; it needs a live Claude session and a human at the
      keyboard. Everything short of that is verified — `bun run smoke`, and a real `main.ts`
      boot serving `frontend/dist` on :8000 with the API on the same origin.

**Four findings worth keeping:**

- **The "agent-file hot-reload watcher" does not exist in the Python backend.** `watchfiles` is a
  declared dependency, but nothing imports it — it is there for `uvicorn --reload`. Hot reload of
  `agents/{name}/*.md` is achieved by *not caching*: both backends re-read the files on each
  build. The YAML loaders do cache, keyed on mtime, and that is ported
  (`sdk/loaders/yaml-config.ts`). No watcher is needed on either side.
- **`i18n/timezone.py` is dead code and was deliberately not ported.** Its only non-test caller is
  `response_generator.py:267`, which formats `room.created_at` into
  `AgentResponseContext.conversation_started` — a field nothing ever reads. Porting it would have
  meant porting the dead field too.
- **`API_PREFIXES` in `static.ts` matches on *segment boundaries*, where Python matches with
  `str.startswith`.** Python needs one `/mcp` entry to cover `/mcp-tools`; this backend needs
  both, and getting it wrong is silent — `/mcp-tools` is unauthenticated, so the request sails
  past auth and comes back as `index.html` with a 200 instead of its JSON. Only reproducible with
  a built frontend on disk, which is why `bun run smoke` did not catch it and booting the real
  server did. Pinned by a test in `http-static.test.ts`.
- **`routers/mcp_tools.py` is broken in Python: four of its five endpoints raise a 500.** Nothing
  calls the router, so nobody noticed. `chat` and `room/message` call
  `ChatOrchestrator.orchestrate_responses`, which does not exist; `get_conversation` passes a
  `limit=` that `crud.get_messages` does not accept; `create_room` calls `crud.create_room` with
  the wrong signature. Only `GET /mcp-tools/agents` works. This is the one Python bug that was
  *not* reproduced (see Open Decision 5) — reproducing it would mean shipping a router that does
  nothing — so the TypeScript port implements the intended behaviour and the parity harness has to
  special-case these four paths.

### Phase 4 — Test parity

- Port the unit suites that guard logic (domain services, tape, options builder, auth, crud) to `bun test`; skip suites that only test Python plumbing.
- **Parity harness:** run the existing *integration* scenarios (world creation → action → poll) against both backends and diff the responses. This, not line-coverage parity, is the cutover gate.
- ~~Wire `bun test` + eslint + drift gate into CI alongside the existing Python jobs~~ **done in Phase 1** — the `backend-ts` job in `.github/workflows/tests.yml`. What remains here is the parity harness itself.

### Phase 5 — Packaging & distribution

- Single executable via `bun build --compile`, embedding the platform CLI with `import ... with { type: "file" }` + `extractFromBunfs()`, passed as `pathToClaudeCodeExecutable`. Start from yaar's `scripts/build/exe-bundle.js`.
- **From Phase 1:** `src/db/migrate.ts` finds `drizzle/` by walking up from `import.meta.dir`, which does not survive `--compile`. The migration SQL has to be embedded the same way the CLI is, or read from beside the executable.
- **Open decision — native window:** pywebview + WebView2 has no direct Bun equivalent. Options: (a) ship `--browser` mode as the default and drop the native window, (b) spawn the OS webview from the compiled binary (small helper, WebView2 on Windows), (c) Tauri wrapper. Recommend (a) for the first TS release, revisit (b) after.
- Update `Makefile`, `scripts/install/install.sh` / `install.ps1`, and `.github/workflows/release.yml` (preserve `.env` / `claudeworld.db` / `worlds/` / edited agents on upgrade, LF pinning for `*.sh`).

### Cutover & rollback

- Cutover: parity harness green + one week of daily-driving the TS backend locally → move `backend-ts/` to `backend/`, retire the Python tree and uv/pytest tooling in a single PR, cut a release.
- Rollback: the Python backend and DB schema are untouched until that PR, so rollback is `git revert` — the DB works with either backend at all times.

## Known Gotchas (from SDK research + codebase)

| Gotcha | Consequence | Mitigation |
|---|---|---|
| TS SDK `env` option **replaces** the subprocess env (Python merges) | Broken `PATH`, missing auth vars, silent CLI failures | Always spread `process.env` into `env`; wrap in one helper |
| ~~No `ClaudeSDKClient` equivalent~~ — **wrong**; `query()` with an async-iterable prompt gives streaming-input mode: one subprocess, N turns, `interrupt()` | None. The pool translated directly. | Settled in Phase 0. Do not call `Query.streamInput()`; do not `for await` with a `break`; keep a background pump so late sub-agent tool calls are serviced |
| Option naming is camelCase (`allowedTools`, `permissionMode`, `mcpServers`) | Subtle config drop-through if translated mechanically | Central typed options builder (port of `options_builder.py`), no inline option dicts |
| `@tool` decorator → `tool(name, desc, zodSchema, handler)` | All 14 handler modules change shape | Define one handler-module convention in Phase 0, apply everywhere |
| `bun:sqlite` is synchronous | Long queries block the event loop | Fine for SQLite-scale queries; keep WAL mode. Confirmed in Phase 0: this removes `retry_on_db_lock` and `serialized_write` entirely, since a statement runs to completion before any other code does |
| Alembic history not portable | Fresh installs vs. upgraded installs must converge | Drizzle baseline == current Alembic head, verified by schema-dump diff in CI |
| SQLAlchemy stores SQLite `DateTime` as **text**, not integer | Drizzle's default timestamp mode writes rows Python cannot read | `src/db/columns.ts::sqlaDateTime` — found and fixed in Phase 0 |
| `permissionMode: 'bypassPermissions'` needs `allowDangerouslySkipPermissions: true` in the TS SDK (Python had no counterpart) | Every tool call stops at a permission prompt nobody can answer | Set in the central options builder |
| TS `tools` and `allowedTools` mean *different* things (Python set both to the same list) | `tools` restricts what exists, `allowedTools` waives the prompt — setting only one leaves CLI file/shell tools visible to characters | Both set explicitly in the options builder |
| `bun build --compile` can't `require.resolve` the bundled CLI | Compiled exe can't find `cli.js` | `extractFromBunfs()` (SDK ≥0.3.144) + explicit `pathToClaudeCodeExecutable` |
| bcrypt hash compat | Existing users locked out | `Bun.password.verify` handles `$2b$`; pinned by a test against a hash and PyJWT tokens generated by the Python side |
| Drizzle's `.default()` emits DDL where SQLAlchemy's `default=` does not | A fresh TS install has `DEFAULT` clauses no existing database has | `$defaultFn` for client-side defaults; `migration-check --against <db>` catches it — found and fixed in Phase 1 |
| A fresh TS install leaving `alembic_version` empty | Python re-runs the baseline revision and dies on `CREATE TABLE` | Fresh installs stamp the Alembic head; verified by running Python's `init_db()` against a TS-created database — found and fixed in Phase 1 |
| `SessionPool.interruptRoom` only reaches *busy* sessions, and an `AbortSignal` makes a session idle at once | Aborting before interrupting leaves every CLI subprocess generating a response nobody awaits | Interrupt the pool **first**, then abort — the reverse of Python, where `Task.cancel()` propagates into the SDK client. `room-orchestrator.ts`, found in Phase 2 |
| Pydantic's lax-mode coercion has no Zod equivalent (`"20"` → `20`, `"on"` → `True`, `2` → error) | Clients that were sending stringified numbers start 422-ing at cutover | `pydanticInt()` / `pydanticBool()` in `src/schemas/common.ts` — found in Phase 2 |
| An `async` function passed to `spawnBackground` runs synchronously to its first `await` | With synchronous `bun:sqlite`, a "background" turn's opening writes land *inside* the request handler | `startBackground` (microtask) and `deferBackground` (macrotask) in `routes/game/shared.ts`, matching Python's `spawn_background` and `BackgroundTasks` respectively — found in Phase 2 |
| Hono does not redirect `/worlds` to `/worlds/`; Starlette 307s | The frontend calls the unslashed form, which Python serves via redirect and Hono would 404 | Both spellings registered — found in Phase 2 |
| A tool server bound to one world writes the right `player.yaml` but mirrors it onto the wrong row | Silent cross-world corruption of `player_states` | `PersistenceManager` and `PlayerFacade` are per-world *factories*, bound in `buildServers` — found in Phase 2 |
| `API_PREFIXES` matches by segment here, by `str.startswith` in Python | `/mcp-tools` falls through to the SPA and answers `index.html` with a 200 instead of JSON — and only when a built frontend is on disk | List `/mcp-tools` separately from `/mcp` in `static.ts`; pinned in `http-static.test.ts` — found in Phase 3 |
| `setInterval` with an async callback is not APScheduler's `max_instances=1` | A tick slower than the interval stacks overlapping runs onto the same rooms | `BackgroundScheduler.tick()` guards on the in-flight promise and *drops* the overlapping tick — found in Phase 3 |
| `sharp` has no synchronous encode API, where Pillow blocks the thread | An `await` dropped between a turn's writes lets a concurrent action interleave its message row | Compression is hoisted above the write block in `routes/game/actions.ts`, restoring Python's atomic sequence — found in Phase 3 |
| `sharp` ships native `.node` binaries | `bun build --compile` cannot bundle them | Phase 5: treat them as external assets beside the executable, like the CLI |

## Open Decisions

1. Native window vs. browser-only for the packaged exe (Phase 5; recommend browser-only first).
2. ~~Whether to fold `frontend/` into the Bun workspace?~~ **Settled 2026-08-21: yes, and ahead of
   cutover.** The repo root is now a Bun workspace (`package.json` → `["backend-ts", "frontend"]`)
   with one `bun.lock`; both npm lockfiles are gone and `make install` is a single `bun install`.
   Bun 1.4's isolated linker gives each workspace its own `node_modules` of symlinks, so the
   TypeScript 6 / eslint 10 the backend pins do not collide with the frontend's TypeScript 5 /
   eslint 9. That linker also surfaced a latent bug: `src/sdk/handlers/context.ts` imported
   `@modelcontextprotocol/sdk` without declaring it, resolving only because the flat npm-style
   install hoisted the Agent SDK's copy. It is a declared dependency now.
3. ~~Hono confirmed over Elysia?~~ **Settled 2026-08-21: Hono.** Reasoning recorded in the Target Stack table.
4. From Phase 0: `to_system_prompt_markdown` hardcodes the Korean particle `이` in the memory-index heading instead of using `format_with_particles`, so vowel-final names read wrong (`크리스이 가진` should be `크리스가 가진`). Reproduced verbatim in the port. Fixing it changes every Korean agent's prompt, so it needs a deliberate call rather than a silent correction.
5. **From Phase 2 — five live Python bugs, all reproduced rather than fixed.** Each one is
   reproduced because the Phase 4 parity harness diffs responses between the two backends, and a
   silent correction there is indistinguishable from a regression. Each needs a decision:
   - `schemas.Location.is_draft` is wrong on the wire. `parse_adjacent_locations` rebuilds the model
     as a dict that omits `is_draft`, so it falls back to `False` for any location that *has*
     adjacencies. Nothing in `frontend/` reads it, so fixing it is cheap.
   - `delete_character` advertises `실종` in its description but keys its reason map on
     `disappearance`, so `실종` silently renders as `death`.
   - `merge_agent_configs` drops the memory index: an agent created *with* a `provided_config` gets
     a stored system prompt with no memory section, which then reappears on the first reload.
   - A partially failed history compression still clears `history.md` and still reports every turn
     as compressed — the skipped batches' turns are discarded permanently.
   - `sync_player_state_from_filesystem` reads `name`/`description`/`properties` off `player.yaml`
     inventory entries, which are in *reference* format and have none of those, so the DB inventory
     blob is written with empty names.
7. **From Phase 3 — a sixth live Python bug, and the one that could not be reproduced.**
   Four of `routers/mcp_tools.py`'s five endpoints raise a 500 as written (see Phase 3). Unlike
   the five above, reproducing it is not an option: a router that 500s on everything is a router
   with no observable behaviour to diff. The TypeScript port implements the intended behaviour, so
   the parity harness must skip `POST /mcp-tools/chat`, `GET /mcp-tools/conversation/{name}`,
   `POST /mcp-tools/room` and `POST /mcp-tools/room/message`, or fix them in Python first. Nothing
   in `frontend/` calls any of them.
6. **From Phase 2 — `chatting_agents` streaming state.** Python publishes per-room streaming text
   from `AgentManager`; the TS SDK keeps that state on the turn. Either the turn runner grows a
   per-room publisher, or the frontend stops rendering those two fields. `has_narrated`, the flag
   that actually gates the input box, already works.
