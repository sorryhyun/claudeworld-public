# ClaudeWorld Backend Migration Plan: Python → TypeScript + Bun

**Status:** Phase 0 complete (2026-08-21). Work lives in `backend-ts/` on branch `ts-migration-phase0`; the Python backend on `master` is untouched and is still the one that runs.
**Next:** finish Phase 1 — auth, the Hono skeleton, Drizzle migrations plus the drift gate, and the logging/cache/locking infrastructure.
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
| Auth | bcrypt + PyJWT | `Bun.password.verify` + **jose** | |
| Scheduler | APScheduler | **croner** (or plain `setInterval`) | Only autonomous-round cadence is needed; APScheduler is overkill to replicate. |
| Images | Pillow | **sharp** | WebP conversion path in `utils/images.py`. |
| Rate limiting | slowapi | hono-rate-limiter (or tiny middleware) | |
| Hot reload of agent files | watchfiles | `fs.watch` (chokidar if edge cases appear) | |
| File locking | custom `infrastructure/locking.py` | **proper-lockfile** | Advisory lock semantics must match (concurrent agent-file writes). |
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

### Phase 1 — Foundation

Partly delivered by Phase 0, which needed the config and schema layers to run a turn at all.

- [x] Config/env loading (`core/`) — `src/config/{settings,paths}.ts`. All env var names preserved;
      `sys.frozen` replaced by a `CLAUDEWORLD_ROOT` override plus upward root discovery.
- [ ] Logging infrastructure (JSON agent logs, `latency.log` perf logging). Not started. Phase 0
      passes telemetry out through callbacks (`onEvent` / `onTelemetry`) instead, so the sinks can
      be added without touching call sites.
- [ ] In-memory cache. Not started. Note the mtime caches inside the filesystem services are a
      different thing — they are the hot-reload mechanism, not the request cache Python's
      `infrastructure/cache.py` provides, and the CRUD layer currently has no cache at all.
- [ ] File locking (`proper-lockfile`). Not started.
- [x] Drizzle schema for **all** tables — `src/db/schema.ts`, all 8 tables plus `alembic_version`,
      verified column-for-column against a real `claudeworld.db` by `src/scripts/verify-schema.ts`.
- [ ] Drift gate + migrations applied on startup. **Partial.** `verify-schema.ts` diffs the schema
      against a live database, which is not the same guarantee as `migration-check`: there are no
      Drizzle migrations yet, so nothing yet proves a *fresh* install converges on the same schema
      as an upgraded one. That is the remaining half, and it belongs in CI.
- [ ] Auth: login endpoint, bcrypt verify of existing `API_KEY_HASH`, JWT issue/verify, guest login
      flag, rate limiting. Not started — `settings.ts` reads the env vars, nothing consumes them.
- [ ] Hono app skeleton with the auth router passing ported auth tests. Not started.

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
- Wire `bun test` + eslint + drift gate into CI alongside the existing Python jobs (both run during the transition).

### Phase 5 — Packaging & distribution

- Single executable via `bun build --compile`, embedding the platform CLI with `import ... with { type: "file" }` + `extractFromBunfs()`, passed as `pathToClaudeCodeExecutable`. Start from yaar's `scripts/build/exe-bundle.js`.
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
| bcrypt hash compat | Existing users locked out | `Bun.password.verify` handles `$2b$`; add a unit test against a known hash from `make setup` |

## Open Decisions

1. Native window vs. browser-only for the packaged exe (Phase 5; recommend browser-only first).
2. Whether to fold `frontend/` into the Bun workspace (recommend yes at cutover — one `bun install` for the whole repo — but not before).
3. ~~Hono confirmed over Elysia?~~ **Settled 2026-08-21: Hono.** Reasoning recorded in the Target Stack table.
4. From Phase 0: `to_system_prompt_markdown` hardcodes the Korean particle `이` in the memory-index heading instead of using `format_with_particles`, so vowel-final names read wrong (`크리스이 가진` should be `크리스가 가진`). Reproduced verbatim in the port. Fixing it changes every Korean agent's prompt, so it needs a deliberate call rather than a silent correction.
