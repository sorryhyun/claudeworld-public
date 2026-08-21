# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ClaudeWorld** is a turn-based text adventure (TRPG) where AI agents collaborate to create and run interactive worlds:
- **Onboarding**: Interview → World generation → Character creation
- **Gameplay**: User action → NPC reactions → Interpretation → Resolution → Narration

**Tech Stack (TypeScript end to end):**
- Runtime: **Bun** (≥1.4, pinned in `.bun-version`) — one workspace at the repo root over
  `backend-ts/` and `frontend/`
- Backend: **Hono** + **Drizzle ORM** + `bun:sqlite`
- Validation: **Zod 4**
- Auth: `Bun.password` (bcrypt-compatible) + **jose** (HS256 JWT)
- AI Integration: **`@anthropic-ai/claude-agent-sdk`**, with game tools served over a stateless **MCP** endpoint
- Frontend: React + TypeScript + Vite + Tailwind CSS
- Real-time: SSE for streaming, HTTP polling as the safety net
- Tests: `bun test --parallel` for both workspaces

The Python/FastAPI backend in `backend/` is the **legacy tree being retired**. See
[Legacy Python backend](#legacy-python-backend) — do not add features there.

## Development Commands

```bash
# One install for the whole repo (root package.json is a Bun workspace)
bun install

# Run backend + frontend
make dev                 # TypeScript backend (SQLite) + frontend
make stop                # Stop all servers
make clean               # Clean build artifacts (including SQLite database)

# Backend only
bun run dev:backend                                # bun --watch src/main.ts
make run-backend-ts                                # same, with host/port/DB env set

# Frontend only
bun run dev:frontend

# Checks -- run these from the repo root; each fans out to both workspaces
bun run test             # Every test in the repo, per-workspace via package scripts (~3s)
bun test --parallel      # Same files in one runner; `--parallel` is what makes it ~3s not ~7s
bun run typecheck        # tsc in both workspaces
bun run lint             # eslint in both workspaces

# One workspace only
bun run --filter '@claudeworld/backend' test
bun run --filter '@claudeworld/frontend' test
cd backend-ts && bun test src/tests/tape.test.ts   # Single test file
cd backend-ts && bun test -t "narration"           # Tests matching a pattern

# Backend tooling
bun run migration-check                            # Schema drift gate (runs in CI)
bun run smoke                                      # Boot the app against a throwaway DB
cd backend-ts && bun run pilot                     # Drive one real game turn, no HTTP
cd backend-ts && bun run verify-schema             # Diff schema.ts against a real .db
cd backend-ts && bun run migration-new             # drizzle-kit generate

# Frontend build
bun run build                                      # vite build
```

## LSP Support

Claude Code can use the LSP tool for code intelligence (TypeScript LSP across both workspaces):

- `documentSymbol` - List all classes, functions, variables in a file
- `hover` - Get type info and docstrings
- `goToDefinition` - Jump to symbol definition
- `findReferences` - Find all usages across the codebase
- `incomingCalls` / `outgoingCalls` - Analyze call hierarchy

## Architecture Overview

### Backend (`backend-ts/`)

```
backend-ts/
├── src/
│   ├── main.ts            # Server entrypoint (logging → config checks → DB → listen)
│   ├── auth/              # Password verification, JWT issue/verify, roles
│   ├── config/            # settings.ts (env) + paths.ts (project root discovery)
│   ├── crud/              # Database operations (pure CRUD, no business logic)
│   ├── db/                # Drizzle schema, migrations, introspection, drift diff
│   ├── domain/            # Enums, errors, player rules, serializers, slash commands
│   ├── http/              # Hono app, middleware (auth, rate limit), routes/, state.ts
│   ├── infrastructure/    # cache.ts, locking.ts, background.ts, logging/
│   ├── lib/               # Shared helpers (async queue, Korean particle agreement)
│   ├── orchestration/     # Room orchestrator, turn, context builders, tape/
│   ├── schemas/           # Zod request/response models
│   ├── sdk/               # Claude Agent SDK integration (see below)
│   ├── services/          # Business logic + filesystem-primary world/player services
│   ├── scripts/           # pilot, smoke, seed, verify-schema, check-migrations
│   └── tests/             # bun test suites + fixtures
└── drizzle/               # Committed SQL baseline + snapshot
```

**`src/sdk/` layout** (the largest subsystem):

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

- **Sessions are streaming-input `query()` calls.** `query()` accepts an async iterable as its
  prompt; given one, the CLI runs one subprocess with an open control channel serving N turns.
  Read it with manual `stream.next()` — a `for await` that `break`s calls `.return()` and tears the
  session down. Never call `Query.streamInput()`; despite the name it ends the CLI's stdin.
  Keep the background pump running between turns, or late sub-agent `tools/call` requests hang.
- **Interrupt before abort.** `SessionPool.interruptRoom` only reaches *busy* sessions, and an
  `AbortSignal` makes a session idle instantly. Aborting first leaves subprocesses generating
  responses nobody awaits. This is the reverse of the Python ordering.
- **The SDK layer never imports orchestration.** Tools report progress and fire turn side effects
  through callbacks on `ServerDeps`, wired in `src/http/state.ts`. The dependency runs one way.
- **Per-world services are factories, not instances.** `PersistenceManager` and `PlayerFacade` each
  write one world's row; a long-lived instance silently mirrors state onto the wrong record.
  `buildServers` binds them per turn.
- **`bun:sqlite` is synchronous.** A statement runs to completion before any other code does, so
  there is no retry-on-lock or serialized-write layer. An `async` function handed to a "background"
  helper runs synchronously to its first `await`; use `startBackground` (microtask) or
  `deferBackground` (macrotask) from `routes/game/shared.ts`.
- **SQLite `DateTime` columns are text, not integers** (`2026-08-06 04:14:54.931812`).
  `src/db/columns.ts` reproduces the format; Drizzle's default timestamp mode would not.

### Frontend (`frontend/`)
- **React + TypeScript + Vite** with Tailwind CSS
- **Key components:**
  - GameApp - TRPG mode entry point
  - WorldSelector - Create/select game worlds
  - GameRoom - Main game interface with action input
  - GameStatePanel - Stats, inventory, minimap (right sidebar)
  - LocationListPanel - Location navigation (left sidebar)
  - MessageList - Display messages with thinking text
- **Real-time features:**
  - `useSSE` streams agent thinking/response deltas; `usePolling` layers message polling on top
    (5s, or 30s as a safety net while SSE is connected)
  - Typing indicators
  - Agent thinking process display
- **Tests** run under `bun test`, not vitest. DOM tests import `src/test/setup.ts` **first** —
  it registers happy-dom globally, and React and Testing Library capture `document` at import time.

## Game System

Seven specialized agents collaborate in two phases: **Onboarding** (interview → world generation) and **Gameplay** (2-cell tape where NPCs react first, then Action Manager coordinates sub-agents via SDK Task tool and handles narration).

**Gameplay tape flow:**
1. **Cell 1 (NPC Reactions)**: NPCs at player's location react concurrently (hidden), responses collected
2. **Cell 2 (Action Manager)**: Receives NPC reactions, interprets action, invokes sub-agents, generates narration

Implemented in `backend-ts/src/orchestration/tape/` (`gameplay-tape.ts`, `chat-tape.ts`,
`executor.ts`), driven by `room-orchestrator.ts`.

**See [docs/how_it_works.md](docs/how_it_works.md) for detailed architecture:** agent roles, turn flow diagrams, sub-agent invocation, data storage, and API endpoints. (Its code references still point at the Python tree; the design is unchanged.)

## Agent Configuration

Agent folder structure:
```
agents/
  agent_name/
    ├── in_a_nutshell.md      # Brief identity summary (third-person)
    ├── characteristics.md     # Personality traits (third-person)
    ├── recent_events.md      # Auto-updated from platform conversations (not for character backstory)
    ├── consolidated_memory.md # Long-term memories with subtitles (optional)
    └── profile.png           # Optional profile picture (png, jpg, jpeg, gif, webp, svg)
```

**IMPORTANT:** Agent configuration files must use **third-person perspective**:
- ✅ Correct: "Dr. Chen is a seasoned data scientist..." or "프리렌은 엘프 마법사로..."
- ❌ Wrong: "You are Dr. Chen..." or "당신은 엘프 마법사로..."

**Profile Pictures:** Add image files (png/jpg/jpeg/gif/webp/svg) to agent folders. Common names: `profile.*`, `avatar.*`, `picture.*`, `photo.*`. Changes apply immediately.

### Memory System

ClaudeWorld uses **on-demand memory retrieval** via the `recall` tool:

- **On-demand memory retrieval** - Agents actively call the `recall` tool to fetch specific memories
- **Lower baseline token cost** - Only memory subtitles are shown in context, full content loaded on request
- **Agent-controlled** - Agents decide when and which memories to retrieve
- **Memory file:** `consolidated_memory.md`
- **Format:** Memories organized with `## [subtitle]` headers
- **Context injection:** Memory subtitles list shown in `<long_term_memory_index>`

Parsing lives in `backend-ts/src/sdk/parsing/memory.ts`.

### Filesystem-Primary Architecture

**Agent configs**, **system prompt**, and **tool configurations** use filesystem as single source of truth:
- Agent configs: `agents/{name}/*.md` files (DB is cache only)
- System prompt: `backend/sdk/config/guidelines_3rd.yaml` (`system_prompt` field) — the YAML still
  lives in the Python tree and is read from there by `src/sdk/loaders/guidelines.ts`
- Tool definitions: `backend-ts/src/sdk/tools/` (TypeScript modules)
- Changes apply immediately on next agent response (mtime-based hot-reload)
- File locking (`proper-lockfile`) guards read-modify-write; atomic rename and `O_APPEND` carry the
  real durability guarantee

### Tool Configuration (TypeScript)

Tool declarations are Zod-schema modules in `backend-ts/src/sdk/tools/`:

- **`definitions.ts`** - Base `ToolDefinition` type
- **`registry.ts`** - Assembles the declared tool set
- **`action.ts`** - Common action tools (skip, memorize, recall)
- **`guideline.ts`** - Guideline tools (read, anthropic)
- **`gameplay.ts`** - Action Manager tools (narration, suggest_options, travel, etc.)
- **`onboarding.ts`** - Onboarding phase tools (draft_world, persist_world, complete)
- **`item.ts` / `location.ts` / `character-design.ts` / `subagent.ts`** - Sub-agent persist tools

Implementations live in `backend-ts/src/sdk/handlers/`, grouped into five MCP servers selected by a
`ServerRole` and assembled by `handlers/servers.ts`.

### Group-Specific Tool Overrides

Override tool configurations for all agents in a group using `group_config.yaml`:

```
agents/
  group_슈타게/
    ├── group_config.yaml  # Group-wide tool overrides
    └── 크리스/
        ├── in_a_nutshell.md
        └── ...
```

Example `group_config.yaml`:
```yaml
tools:
  recall:
    response: "{memory_content}"  # Return memories verbatim
  skip:
    response: "This character chooses to remain silent."

# Behavior settings
interrupt_every_turn: true
priority: 5
transparent: true
can_see_system_messages: true
```

See `agents/group_config.yaml.example` for more examples. Loaded by
`backend-ts/src/sdk/loaders/group-config.ts`.

### Third-Person Perspective

Agent files use **third-person** descriptions (e.g., "프리렌은 엘프 마법사로...") because Claude Agent SDK inherits an immutable "You are Claude Code" prompt. Third-person avoids conflicting "You are..." statements.

**See [docs/how_it_works.md](docs/how_it_works.md#why-third-person-perspective) for technical details.**

## Quick Start

1. **Setup environment:**
   ```bash
   # Install Bun (if not already installed)
   curl -fsSL https://bun.sh/install | bash

   # Install all dependencies
   make install
   ```

   `make install` still runs `uv sync` too: the `.env` setup wizard and the exe build are the last
   things on the Python toolchain, so `uv` remains a prerequisite until Phase 5.

   `make install` still runs `uv sync` as well: the `.env` setup wizard and the exe build are the
   last things on the Python toolchain, so `uv` remains a prerequisite until Phase 5.

2. **Configure authentication:**
   ```bash
   # Prompts for a password, then writes .env with API_KEY_HASH + JWT_SECRET
   make setup
   ```

   Re-run `make setup` to change the password later — only `API_KEY_HASH` is
   rewritten, every other `.env` setting is preserved.

3. **Run development servers:**
   ```bash
   make dev
   ```

4. **Access application:**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8000

   Login with the password you used to generate the hash.

## Distribution

End users install via release-hosted scripts in `scripts/install/`, attached to every GitHub release so the `latest/download/` URLs resolve:

- `install.ps1` — Windows; downloads `ClaudeWorld.exe` to `%LOCALAPPDATA%\ClaudeWorld` with shortcuts
- `install.sh` — macOS/Linux/WSL; source install to `~/.claudeworld` plus a `claudeworld` launcher

Both upgrade in place and preserve `.env`, `claudeworld.db`, `worlds/` and edited agents. `.gitattributes` pins `*.sh` to LF because the Windows release runner checks out with `core.autocrlf=true`.

Releases are cut with `gh release create <tag> --target master --generate-notes`; `.github/workflows/release.yml` builds on `published` and attaches all four assets.

**Packaging is still on the Python toolchain** (`make build-exe` → PyInstaller + pywebview). The
`bun build --compile` replacement is Phase 5 of the migration; see
[docs/ts-migration-plan.md](docs/ts-migration-plan.md) for the open decision on the native window.

## Configuration

### Backend Environment Variables (`.env`)

Read by `backend-ts/src/config/settings.ts`. All names are unchanged from the Python backend.

**Required:**
- `API_KEY_HASH` - Bcrypt hash of your password (generate with `make setup`)
- `JWT_SECRET` - Secret key for signing JWT tokens

**Optional:**
- `DATABASE_URL` - SQLite URL; unset resolves to `<projectRoot>/claudeworld.db`
- `USER_NAME` - Display name for user messages in chat (default: "User")
- `DEBUG_AGENTS` - Set to "true" for verbose agent logging
- `USE_SONNET` - Set to "true" to use Sonnet model instead of Opus (default: false)
- `ENABLE_GUEST_LOGIN` / `GUEST_PASSWORD_HASH` - Guest login (default: enabled)
- `GUIDELINES_FILE` - Override the guidelines YAML path
- `PRIORITY_AGENTS`, `MAX_CONCURRENT_ROOMS` - Orchestration tuning
- `IMAGE_WEBP_QUALITY` - WebP compression quality 1-100 (default: 85)
- `IMAGE_CONVERT_TO_WEBP` - Convert images to WebP format (default: true)
- `FRONTEND_URL`, `VERCEL_URL` - CORS origins
- `ENABLE_CLI_TRACING`, `CLI_TRACE_OUTPUT` - CLI tracing (requires a patched CLI)

**Claude API:**
- `CLAUDE_API_KEY` - Direct API key for production deployments (get from console.anthropic.com)
- If not set, uses Claude Code web authentication (requires active Claude Code session)

## Common Tasks

### Agent Configuration

**Create agent:** Add folder in `agents/` with required `.md` files using third-person perspective, restart backend

**Update agent:** Edit `.md` files directly (changes apply immediately)

**Update system agent:** Edit files in `agents/group_gameplay/{agent_name}/` or `agents/group_subagent/{agent_name}/`

**Enable debug logging:** Set `DEBUG_AGENTS=true` in `.env`

### Game Tools

**Add game tool:** Declare it in `backend-ts/src/sdk/tools/gameplay.ts` (Zod schema + description),
implement the handler in `backend-ts/src/sdk/handlers/`, and attach it to a server in
`handlers/servers.ts`

**Test game flow:** `bun run smoke` for the HTTP surface, `bun run pilot` for a real scripted turn

### General Tasks

**Add database field:**
1. Update `backend-ts/src/db/schema.ts`
2. Generate a migration: `cd backend-ts && bun run migration-new`
3. Review the generated file in `backend-ts/drizzle/`
4. Update `src/schemas/` and `src/crud/`, restart (migrations apply on startup)

`bun run migration-check` builds a database from the migrations alone and diffs it against
`schema.ts` — it fails if the two have drifted, and it runs in CI. From `backend-ts/`,
`bun run migration-check --against <db>` diffs against a real database file instead.

Note: Drizzle's `.default()` emits a SQL `DEFAULT` clause; use `$defaultFn` for client-side
defaults unless the column genuinely carries a server default in existing databases.

**Add endpoint:** Define the Zod schema in `src/schemas/`, add CRUD in `src/crud/`, add the route
in `src/http/routes/` (register it in `routes/game/index.ts` or `http/app.ts`)

## Testing

Both workspaces run on `bun test`. `bun run test` is the entry point; from the repo root a bare
`bun test` also collects everything.

**`--parallel` (Bun 1.4) is in both `test` scripts.** It runs the files across N worker processes
(N = core count) and implies `--isolate`, so each file gets a fresh global. Backend: 6.6s → 2.6s.
The suite is safe under it by construction — no test binds a port (the Hono app is driven through
`app.fetch`) and every fixture database lives in its own `mkdtemp` directory — and it stays green
under `--randomize`. Drop the flag to debug a suspected cross-file interaction.

**The root `bunfig.toml` is load-bearing.** Bun picks `bunfig.toml` by *current directory*, so a
run launched from the repo root does not see `backend-ts/bunfig.toml`. Without a root file, such a
run got no preload — and the backend preload is what points `os.tmpdir()` at tmpfs. Every fixture
database fsynced to real disk instead: 79s for the files that take 6.6s from `backend-ts/`, with
the output buried under the ERROR lines the preload's log sink discards.

- Backend suites: `backend-ts/src/tests/` — unit tests plus integration tests that stand up the
  real Hono app over a temp database. Fixtures (including a checked-in world) are in
  `src/tests/fixtures/`.
- Frontend suites: colocated `*.test.ts(x)` under `frontend/src/`. A DOM test must
  `import "../test/setup"` as its **first** import.

CI (`.github/workflows/tests.yml`) runs typecheck, lint, the test suites, and the schema drift gate.

## Legacy Python backend

`backend/` still holds the FastAPI implementation, and CI still runs its suite, because the
migration's rollback story depends on it staying green until cutover. Treat it as frozen:

- New work goes in `backend-ts/`. Do not add features or endpoints to `backend/`.
- `make dev-python` runs it if you need to compare behaviour.
- The SQLite schema is shared and byte-compatible in both directions — one `claudeworld.db` opens
  under either backend, and a fresh TypeScript install stamps the Alembic head so Python can adopt it.
- The REST contract is frozen: the React app ships unchanged across the cutover.
- Phase 3 routers not yet ported (`agents`, `rooms`, `messages`, `sse`, `debug`, `readme`), the
  background scheduler, the agent-file watcher, i18n and image/WebP conversion still live only in
  the Python tree.

[docs/ts-migration-plan.md](docs/ts-migration-plan.md) tracks phase status, the parity contract,
the known gotchas table, and the open decisions — including five live Python bugs that were
reproduced rather than fixed so the parity harness can diff the two backends honestly.

## History

ClaudeWorld evolved from ChitChats, a multi-agent chat room application where Claude AI agents with different personalities could interact in real-time.
