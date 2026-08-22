# backend/CLAUDE.md

The ClaudeWorld server: HTTP surface, database, the Claude Agent SDK layer, and the
turn orchestration that drives the game. Bun + Hono + Drizzle + `bun:sqlite`.

Repo-wide context — dev commands, single-port serving, env vars — is in the root
[`CLAUDE.md`](../CLAUDE.md).

## Layout

```
backend/
├── sdk/config/            Prompt YAML. DATA, not code: hot-reloaded on mtime and
│                          edited by users, which is why it sits beside src/
│                          rather than inside it.
│                          guidelines_3rd.yaml · localization.yaml
│                          lore_guidelines.yaml · conversation_context.yaml
├── infrastructure/logging/debug.yaml   Agent debug logging config
├── src/
│   ├── main.ts            Server entrypoint (logging → config checks → DB → listen)
│   ├── auth/              Password verification, JWT issue/verify, roles
│   ├── config/            settings.ts (env) + paths.ts (project root discovery)
│   ├── crud/              Database operations (pure CRUD, no business logic)
│   ├── db/                Drizzle schema, migrations, introspection, drift diff
│   ├── domain/            Enums, errors, player rules, serializers, slash commands
│   ├── http/              Hono app, middleware (auth, rate limit), routes/, state.ts
│   ├── infrastructure/    cache.ts, locking.ts, background.ts, scheduler.ts, sse*, logging/
│   ├── lib/               Shared helpers (async queue, Korean particles, WebP compression)
│   ├── orchestration/     Room orchestrator, turn, context builders, tape/
│   ├── schemas/           Zod request/response models
│   ├── sdk/               Claude Agent SDK integration (see below)
│   ├── services/          Business logic + filesystem-primary world/player services
│   ├── scripts/           pilot, smoke, seed, setup-env, verify-schema, check-migrations
│   └── tests/             bun test suites + fixtures
└── drizzle/               Committed SQL baseline + snapshot
```

Routes, for orientation:

```
http/routes/auth.ts · debug.ts · mcp-tools.ts · readme.ts
http/routes/game/    worlds · actions · locations · chat-mode · state · polling
http/routes/rooms/   rooms · agents · messages · sse
http/routes/agents/  index · profile-pic
```

## Tooling

```bash
bun run dev                       # bun --watch src/main.ts
bun run test                      # bun test src/tests --parallel  (~3.8s, 1589 tests)
bun test src/tests/tape.test.ts   # single file
bun test -t "narration"           # tests matching a pattern
bun run typecheck                 # tsc --noEmit
bun run lint                      # eslint src

bun run migration-check           # Schema drift gate (runs in CI)
bun run migration-check -- --against <db>   # diff against a real database file
bun run migration-new             # drizzle-kit generate
bun run verify-schema <db>        # diff schema.ts against a real .db

bun run smoke                     # Boot the app against a throwaway DB, hit real routes
bun run pilot                     # Drive three real game turns, no HTTP  (live CLI)
bun run spike                     # SDK-behaviour harness (real CLI, real tokens)
bun run setup                     # The .env wizard (`make setup` calls this)
```

## `src/sdk/` — the largest subsystem

```
sdk/
├── client/       Persistent session, session pool, stream parser, narration extractor
├── agent/        Options builder, hooks, turn runner
├── tools/        Tool declarations (Zod schemas + descriptions)
├── handlers/     Tool implementations and MCP server assembly
├── mcp/          Stateless MCP endpoint, adapter, per-turn registry
├── loaders/      YAML config with mtime hot-reload
└── parsing/      Agent config + long-term memory parsing
```

**Load-bearing details** (each cost real time to discover — don't undo them):

- **Sessions are streaming-input `query()` calls.** `query()` accepts an async iterable
  as its prompt; given one, the CLI runs one subprocess with an open control channel
  serving N turns. Read it with manual `stream.next()` — a `for await` that `break`s
  calls `.return()` and tears the session down. Never call `Query.streamInput()`;
  despite the name it ends the CLI's stdin. Keep the background pump running between
  turns, or late sub-agent `tools/call` requests hang.
- **Interrupt before abort.** `SessionPool.interruptRoom` only reaches *busy* sessions,
  and an `AbortSignal` makes a session idle instantly. Aborting first leaves subprocesses
  generating responses nobody awaits.
- **The SDK layer never imports orchestration.** Tools report progress and fire turn side
  effects through callbacks on `ServerDeps`, wired in `src/http/state.ts`. The dependency
  runs one way.
- **Per-world services are factories, not instances.** `PersistenceManager` and
  `PlayerFacade` each write one world's row; a long-lived instance silently mirrors state
  onto the wrong record. `buildServers` binds them per turn.
- **The SDK is pinned exactly, and `bun run spike` is the canary.** `spike-session.ts` is
  the only place CLI behaviour is asserted against a live subprocess — the pin, streaming
  sessions, MCP tools across turns, hook firing, `Options.agents`, `outputFormat`. Run it
  on every SDK bump. Its first run found two silent bugs, so treat a version bump without
  a spike run as unverified.
- **The sub-agent dispatch tool is `Agent`, not `Task`.** CLI 2.1.238 renamed it; a hook
  matching only `Task` fires never and fails silently. `SUBAGENT_DISPATCH_TOOLS` in
  `sdk/agent/hooks.ts` is the single list, and `options-builder.ts` derives `NATIVE_TOOLS`
  from it. `SubagentStart`/`SubagentStop` pair on `agent_id`, *not* the dispatch's
  `tool_use_id` — those are different ids.
- **`Options.agents` is the only way a sub-agent exists.** Built-in agents are disabled and
  `settingSources: []` blocks filesystem discovery, so `sdk/agent/subagent-definitions.ts`
  is what dispatch resolves against. It drops any designer whose `mcp__subagents__persist_*`
  tool the turn does not serve — a definition naming a tool that is not there leaves the
  sub-agent with no tools at all and no diagnostic.
- **`readOnlyHint` is a scheduling flag, not documentation.** Claude Code's tool wrapper
  reads `annotations.readOnlyHint` as `isConcurrencySafe()`, so an unannotated tool is
  always executed on its own. The query tools declare `readOnly: true` on their
  `ToolDefinition` and `buildToolSets` stamps the annotation in one pass; a tool that
  writes must never be marked, and `group_config.yaml` deliberately cannot override it.
  Namespace-wide guidance goes in `SERVER_INSTRUCTIONS` (served on `server/discover`,
  rendered by the CLI as one context block), not repeated across tool descriptions.
- **In-process MCP servers are a closed question.** The SDK accepts one only as
  `{ type: 'sdk', instance }` typed against `@modelcontextprotocol/sdk` v1, whose
  `CallToolResult.structuredContent` is incompatible with the v2
  `@modelcontextprotocol/server` this backend standardized on. See §3 of
  [`../docs/sdk-modernization-plan.md`](../docs/sdk-modernization-plan.md) for the
  compiler output; do not re-litigate it without checking whether the SDK's peer
  dependency has moved to v2.
- **`env` replaces the subprocess environment, it does not merge.** Everything goes
  through `src/sdk/client/env.ts`, which also strips the parent harness's auth variables
  so this works when launched from inside Claude Code.
- **Options are built in exactly one place** (`src/sdk/agent/options-builder.ts`). An
  inline options object drops fields silently.

## Database

- **`bun:sqlite` is synchronous.** A statement runs to completion before any other code
  does, so there is no retry-on-lock or serialized-write layer. An `async` function handed
  to a "background" helper runs synchronously to its first `await`; use `startBackground`
  (microtask) or `deferBackground` (macrotask) from `routes/game/shared.ts`.
- **SQLite `DateTime` columns are text, not integers** (`2026-08-06 04:14:54.931812`).
  `src/db/columns.ts` reproduces the format; Drizzle's default timestamp mode would not.
- **Drizzle's `.default()` emits a SQL `DEFAULT` clause; use `$defaultFn` for client-side
  defaults** unless the column genuinely carries a server default in existing databases.
  Only `rooms.is_paused`, `rooms.is_finished` and `messages.timestamp` have real server
  defaults. `bun run migration-check --against <db>` is what catches getting this wrong.
- **Existing databases are adopted, not migrated.** An existing `claudeworld.db` is
  verified against `schema.ts` and then stamped — nothing here writes DDL to a populated
  database. A fresh install also stamps `alembic_version`; that is vestigial now that the
  Python backend is gone, but harmless and still covered by `src/tests/migrate.test.ts`.

**Adding a database field:**

1. Update `src/db/schema.ts`
2. `bun run migration-new`
3. Review the generated file in `drizzle/`
4. Update `src/schemas/` and `src/crud/`, restart (migrations apply on startup)

`bun run migration-check` builds a database from the migrations alone and diffs it against
`schema.ts` — it fails if the two have drifted, and it runs in CI.

## Auth

Auth functions take a config object, not the environment. `resolveAuthConfig()` does the
env-over-`.env` layering once, so the rest of `src/auth/` is pure and testable.

`Bun.password.verify` reads the `$2b$` prefix and dispatches to bcrypt, so hashes written
by any bcrypt implementation — including the ones the old Python wizard produced — verify
unchanged. `src/scripts/setup-env.ts` writes `$2b$` hashes at cost 12 to match.

## Game System

Seven specialized agents collaborate in two phases: **Onboarding** (interview → world
generation) and **Gameplay** (a 2-cell tape where NPCs react first, then the Action Manager
coordinates sub-agents and handles narration).

**Gameplay tape flow:**

1. **Cell 1 (NPC Reactions)** — NPCs at the player's location react concurrently (hidden),
   responses collected
2. **Cell 2 (Action Manager)** — receives NPC reactions, interprets the action, invokes
   sub-agents, generates narration

Implemented in `src/orchestration/tape/` (`gameplay-tape.ts`, `chat-tape.ts`,
`executor.ts`), driven by `room-orchestrator.ts`.

[`../docs/how_it_works.md`](../docs/how_it_works.md) has the detailed architecture — agent
roles, turn flow diagrams, sub-agent invocation, data storage, API endpoints. **Its code
references still point at the deleted Python tree**; the design is unchanged, the paths are
not.

## Chat Rooms

`/rooms` and `/agents` are the chat half of the app — the part that predates the TRPG mode
and that `usePolling.ts` / `useSSE.ts` drive.

```
http/routes/rooms/     rooms.ts (CRUD, pause/resume) · agents.ts (membership)
                       messages.ts (list, poll, send, chatting-agents) · sse.ts (ticket, stream)
http/routes/agents/    index.ts (CRUD, configs, reload, direct-room) · profile-pic.ts
infrastructure/        sse.ts (EventBroadcaster) · sse-ticket.ts (SSETicketManager)
orchestration/tape/    chat-room-tape.ts (the chat-room scheduler)
```

**Load-bearing details:**

- **A chat room has no world.** `rooms.world_id IS NULL`, so there is no player state, no
  location and no Action Manager. `ResponderContext.world` in `orchestration/turn.ts` is
  therefore `World | null`, and the non-world path falls back to `settings.userName` for
  the user's display name. `runChatRoomTurn` is the entry point;
  `RoomOrchestrator.handleChatRoomMessage` tracks it with the same interrupt and supersede
  rules a world turn gets, because both are properties of the *room*.
- **The chat-room tape is a loop, not a tape.** An initial round (interrupt agents answer
  the user, then priority agents sequentially, then the rest *concurrently*), followed by
  up to `MAX_FOLLOW_UP_ROUNDS` rounds in which the agents answer each other. A round where
  everyone skips marks the room finished. This is a different scheduler from both game
  tapes — see `tape/chat-room-tape.ts`.
- **SSE authenticates with a ticket, not the JWT.** `EventSource` cannot send a header, so
  the client POSTs for a 60-second single-use ticket bound to one room.
  `middleware/auth.ts` excludes `GET /rooms/{id}/stream` *because* `sse.ts` authenticates
  it instead — the exclusion and the `validateTicket` call are two halves of one check.
- **Route order is load-bearing in two places.** `GET /agents/configs` must precede
  `GET /agents/:agent_id`, or "configs" parses as an id and the picker 422s — the same
  hazard `/worlds/importable` has.
- **The profile-pic route is unauthenticated** (an `<img src>` cannot send a header), so
  the agent name validation in `profile-pic.ts` is a security control, not a nicety.
- **Chat rooms keep talking with nobody watching.** `infrastructure/scheduler.ts` gives
  every *active* chat room one follow-up round every two seconds — not paused, not
  finished, active in the last five minutes, `world_id IS NULL`, at least two agents,
  capped at `MAX_CONCURRENT_ROOMS`. Two details are load-bearing. It goes through
  `RoomOrchestrator.handleAutonomousRound`, so a background round takes the room's single
  in-flight slot and yields to a user message rather than piling on. And a tick arriving
  while the previous one is still running is **dropped, not queued** — which a bare
  `setInterval` with an async callback does the opposite of. Constructed in
  `createAppState`, started only by `main.ts` (so tests and `bun run smoke` never get a
  timer firing turns at them), stopped first in `AppState.shutdown()`.

**Known gap:** `thinking_text` and `response_text` on `/rooms/{id}/chatting-agents` are
always empty, and the SSE stream does not replay catch-up events on connect. Both need a
per-room registry of partially-streamed responses; the turn keeps that state instead. The
same gap is documented in `routes/game/polling.ts`.

## Filesystem-Primary Architecture

Agent configs, the system prompt and tool configuration use the filesystem as the single
source of truth:

- Agent configs: `../agents/{name}/*.md` (the DB is a cache only) — see
  [`../agents/CLAUDE.md`](../agents/CLAUDE.md)
- System prompt: `sdk/config/guidelines_3rd.yaml` (`system_prompt` field), read by
  `src/sdk/loaders/guidelines.ts`
- Tool definitions: `src/sdk/tools/` (TypeScript modules)

Changes apply immediately on the next agent response (mtime-based hot-reload). File locking
(`proper-lockfile`) guards read-modify-write; atomic rename and `O_APPEND` carry the real
durability guarantee.

`src/config/paths.ts` resolves all of this. It discovers the project root by walking up for
a directory holding both `agents/` and `backend/`, or takes `CLAUDEWORLD_ROOT` as an
override — which is what makes `bun test` work from any cwd and what a relocated install
uses.

## Tool Configuration

Tool declarations are Zod-schema modules in `src/sdk/tools/`:

- **`definitions.ts`** — base `ToolDefinition` type
- **`registry.ts`** — assembles the declared tool set
- **`action.ts`** — common action tools (skip, memorize, recall)
- **`guideline.ts`** — guideline tools (read, anthropic)
- **`gameplay.ts`** — Action Manager tools (narration, suggest_options, travel, …)
- **`onboarding.ts`** — onboarding phase tools (draft_world, persist_world, complete)
- **`item.ts` / `location.ts` / `character-design.ts` / `subagent.ts`** — sub-agent persist tools

Implementations live in `src/sdk/handlers/`, grouped into five MCP servers selected by a
`ServerRole` and assembled by `handlers/servers.ts`.

**Adding a game tool:** declare it in `src/sdk/tools/gameplay.ts` (Zod schema +
description), implement the handler in `src/sdk/handlers/`, attach it to a server in
`handlers/servers.ts`. Then `bun run smoke` for the HTTP surface, `bun run pilot` for a
real scripted turn.

**Adding an endpoint:** Zod schema in `src/schemas/`, CRUD in `src/crud/`, route in
`src/http/routes/` (registered in `routes/game/index.ts` or `http/app.ts`), and add the
prefix to `API_PREFIXES` in `http/static.ts` if it is a new top-level router.

## Testing

Suites live in `src/tests/` — unit tests plus integration tests that stand up the real Hono
app over a temp database. Fixtures (including a checked-in world) are in
`src/tests/fixtures/`.

`bunfig.toml` preloads `src/tests/setup/env.ts`, which pins `CLAUDEWORLD_ROOT`, neutralises
the developer's `.env` (through both doors — `loadDotEnv` and Bun's own auto-load), points
`os.tmpdir()` at tmpfs, and discards log output. A run launched from the repo root gets the
root `bunfig.toml` instead, which preloads the same file — keep the two in step.

`seed-pilot.ts` builds a throwaway root under the scratch directory: `agents/` and
`backend/` are symlinked to this repo so agent configs and guidelines resolve exactly as in
production, while the world data and database are fresh copies. It never writes to the
repository.
