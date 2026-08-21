# ClaudeWorld Backend Migration Plan: Python → TypeScript + Bun

**Status:** Phases 0 and 1 complete (2026-08-21). Work lives in `backend-ts/` on branch `ts-migration-phase0`; the Python backend on `master` is untouched. On this branch `make dev` runs the TS backend (auth only) and `make dev-python` runs the Python one.
**Next:** Phase 2 — the game core: finish `domain/`/`crud/`/`services/`, chat mode, the interrupt path, and the `routers/game/` surface.
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

### Phase 2 — Game core

Phase 0 cut a vertical slice through this phase — the parts one gameplay turn touches — rather than
completing any layer. What is marked partial below is genuinely partial, not "done but untested".

- [ ] Port `domain/`, `crud/`, `services/`. **Partial.**
  - `crud/` — the turn subset only: worlds, rooms, agents, messages, locations, player-state,
    sessions. Read paths plus `createMessage` / `incrementTurn` / `addActionToHistory` /
    `addAgentToRoom` / `addGameplayAgentsToRoom`. Every world/room/agent *write* path, the chat-mode
    state transitions, inventory and stat mutation, and all of `crud/cached.py` are absent.
  - `services/` — read paths of world, player, location-storage and room-mapping. Agent factory,
    persistence manager, item service, agent-filesystem service and history compression are absent.
  - `domain/` — not ported as a layer. Its enums live inline in `db/schema.ts`; its entity logic
    has no home yet.
- [ ] Port `orchestration/` + `tape/` (full 2-cell tape, chat mode, interrupts). **Partial.**
  - [x] The 2-cell gameplay tape, its executor, and the conversation / Action-Manager context
        builders, all exercised end-to-end by the pilot.
  - [ ] Chat mode — absent entirely.
  - [ ] Interrupts — the primitives exist and are wired (`AgentSession.interrupt`,
        `SessionPool.interruptRoom`, `AbortSignal` through the executor and turn runner, and the
        "interrupt keeps the session, error evicts it" rule). The room-level orchestrator path that
        cancels a turn and persists the partial response is **not** ported, and none of the
        interrupt path has been exercised — the pilot only runs turns to completion.
- [ ] Port `routers/game/` (actions, chat_mode, locations, polling, state, worlds) with golden
      fixtures. Not started.

### Phase 3 — Remaining surface

- Routers: `agents`, `agent_management`, `rooms`, `room_agents`, `messages`, `sse`, `mcp_tools`, `debug`, `readme`.
- Background scheduler for autonomous agent rounds; agent-file hot-reload watcher; i18n; image upload/WebP conversion.
- Frontend smoke pass: run the untouched React app against the TS backend through full onboarding + gameplay.

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

## Open Decisions

1. Native window vs. browser-only for the packaged exe (Phase 5; recommend browser-only first).
2. Whether to fold `frontend/` into the Bun workspace (recommend yes at cutover — one `bun install` for the whole repo — but not before).
3. ~~Hono confirmed over Elysia?~~ **Settled 2026-08-21: Hono.** Reasoning recorded in the Target Stack table.
4. From Phase 0: `to_system_prompt_markdown` hardcodes the Korean particle `이` in the memory-index heading instead of using `format_with_particles`, so vowel-final names read wrong (`크리스이 가진` should be `크리스가 가진`). Reproduced verbatim in the port. Fixing it changes every Korean agent's prompt, so it needs a deliberate call rather than a silent correction.
