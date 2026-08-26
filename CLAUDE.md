# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

This file covers the repo as a whole. Each workspace carries its own, loaded
automatically when you touch files there:

| File | Covers |
|---|---|
| [`backend/CLAUDE.md`](backend/CLAUDE.md) | Hono/Drizzle server, the Claude Agent SDK layer, orchestration, the game system |
| [`frontend/CLAUDE.md`](frontend/CLAUDE.md) | React app, the Bun bundler, Tailwind, the SSE/polling client |
| [`agents/CLAUDE.md`](agents/CLAUDE.md) | Agent config format, memory, group overrides |

## Project Overview

**ClaudeWorld** is a turn-based text adventure (TRPG) where AI agents collaborate to
create and run interactive worlds:

- **Onboarding**: Interview → World generation → Character creation
- **Gameplay**: User action → NPC reactions *and* interpretation/resolution/narration,
  run side by side, with the Action Manager voicing what the NPCs said

It also has a chat-room mode (`/rooms`, `/agents`) that predates the TRPG mode and is
still fully supported.

**Tech stack — TypeScript end to end:**

- Runtime: **Bun** (≥1.4, pinned in `.bun-version`) — one workspace at the repo root
  over `backend/` and `frontend/`
- Backend: **Hono** + **Drizzle ORM** + `bun:sqlite`
- Validation: **Zod 4**
- Auth: `Bun.password` (bcrypt-compatible) + **jose** (HS256 JWT)
- AI integration: **`@anthropic-ai/claude-agent-sdk`**, with game tools served over a
  stateless **MCP** endpoint
- Frontend: React 19 + TypeScript + Tailwind CSS, bundled by **Bun's own bundler**
- Real-time: SSE for streaming, HTTP polling as the safety net
- Tests: `bun test --parallel` for both workspaces

## Repository Layout

```
agents/        Agent definition folders (markdown, hot-reloaded)   → agents/CLAUDE.md
config/        Prompt YAML — user-editable data, not code
backend/       The server: HTTP, DB, SDK, orchestration            → backend/CLAUDE.md
frontend/      The React app                                       → frontend/CLAUDE.md
worlds/        User-created world data (gitignored)
docs/          Architecture notes and historical plans
scripts/       Release installers, the deploy shell script, Makefile helpers
```

`agents/`, `config/` and `worlds/` are **data**, not code: they are read at
runtime, hot-reloaded on mtime, and written to while the app runs. They sit at
the top level *because* of that: `backend/` and `frontend/` hold only code, and
the installer can merge the data trees across an upgrade instead of replacing
them with whatever the release shipped.

## Development Commands

```bash
# One install for the whole repo (root package.json is a Bun workspace)
bun install

# Run the app -- either way, it lives on ONE origin
make dev                 # One process, one URL: http://localhost:8000
                         # The backend bundles frontend/ in-process, with HMR
make serve               # Same, from a prebuilt frontend/dist (no HMR)
make stop                # Stop all servers
make clean               # Clean build artifacts (including the SQLite database)

# Backend only
bun run dev:backend                                # bun --watch src/main.ts
make run-backend                                   # same, with host/port/DB env set
make dev-perf                                      # dev + latency.log
make dev-trace                                     # dev + traces.jsonl (patched CLI)

# Checks -- run these from the repo root; each fans out to both workspaces
bun run test             # Every test in the repo, per-workspace (~4s)
bun test --parallel      # Same files in one runner
bun run typecheck        # tsc in both workspaces
bun run lint             # eslint in both workspaces

# One workspace only
bun run --filter '@claudeworld/backend' test
bun run --filter '@claudeworld/frontend' test

# Frontend build
bun run build                                      # → frontend/dist
```

See [`backend/CLAUDE.md`](backend/CLAUDE.md) for the backend's own tooling
(`pilot`, `spike`, `smoke`, `migration-check`, `verify-schema`).

### The Makefile runs on Windows too — keep it shell-free

Every target except `make prod` works from a PowerShell prompt, from cmd and from
Git Bash, as well as from a Unix shell. That is not free: GNU Make on Windows hands
recipes to `sh.exe` when one is on PATH and to **`cmd.exe`** when none is, and cmd
has no `mkdir -p`, no `rm`, no `pkill`, no `VAR=value cmd` prefix, and does not strip
the quotes off `echo "text"`. So no recipe in the Makefile uses shell syntax at all:

- **Messages go through `$(info ...)`,** which make prints itself with no shell
  involved — spacing, quotes and emoji come out identical everywhere. Two
  consequences: `$(info   x)` *trims* its argument, so anything indented or longer
  than a line lives in a `define` block; and make expands a whole recipe before
  running any of it, so all of a target's messages print **before** its first
  command. Write them as an announcement, never as step-by-step narration.
- **Values reach the backend as exported make variables** (`export PORT`,
  `run-backend-perf: export PERF_LOG := true`), never as a bash-only
  `VAR=value cmd` prefix.
- **`$(CURDIR)`, not `$(PWD)`** — make defines the first itself; the second is
  inherited from the shell and is empty when make was started from PowerShell.
- **Anything that needs a real shell goes to Bun**, whose own shell is
  cross-platform: `clean` is a root `package.json` script (`rm -rf` and friends),
  `stop` is `scripts/dev/stop.ts` (`pkill -f` on POSIX, a `Win32_Process` command-line
  filter on Windows), and the perf target's `tee` is `scripts/dev/tee.ts`.

What is left per recipe line is one command plus `|`, `2>` and `||`, which cmd and sh
spell the same way. `make prod` is the documented exception: it backgrounds a server
with `&` and calls a `.sh` script, so it needs WSL or Git Bash.

## Single-Port Serving

The frontend and the API share one origin in both run modes, so the app only ever
issues **relative** URLs (`/worlds/...`) and never has to know a backend host:

| Mode | Port | Who serves the HTML | Who serves the API |
|---|---|---|---|
| `make dev` | 8000 | the backend, bundling `frontend/` live (HMR) | the backend |
| `make serve` | 8000 | the backend, from `frontend/dist` | the backend |

There is one process and one port in **both** modes. Vite is gone, and with it the
dev proxy, the second port and the duplicated API-prefix list.

- **The port is negotiable.** `PORT` (default 8000) is a preference: if it is taken,
  `http/serve.ts` falls back to an OS-assigned ephemeral port and logs which one it
  got. That is only safe because the page is same-origin — nothing has to be told the
  port. It was *not* safe while Vite proxied to a hardcoded `127.0.0.1:8000`, which is
  why the port was fixed before.
- **`make dev` passes `FRONTEND_DEV=true`** (and `SERVE_FRONTEND=false`, so a stale
  `dist/` cannot shadow the live bundle). `main.ts` then dynamically imports
  `frontend/index.html` and hands it to `Bun.serve`'s `routes`. The import is dynamic
  so that backend-only entry points — the test suite, `bun run smoke`, the pilot —
  never bundle React just to reach `main.ts`.
- **A bare `/*` route would shadow `fetch` entirely.** Bun's router always beats the
  `fetch` fallback, so `buildDevRoutes` registers every entry of `API_PREFIXES` as its
  own route (twice — `/auth/*` does not match `/auth`) and gives `/*` to the SPA. Bun's
  matcher is segment-aware, so `/mcp-tools` misses `/mcp/*` without the anchored
  regexes the Vite proxy needed.
- **`backend/src/http/static.ts` serves `frontend/dist`** with an SPA fallback.
  `main.ts` decides *whether* to (`resolveFrontendDir`); `createApp()` with no
  `frontendDir` is API-only, which is what keeps the test suite independent of whether
  anyone has run `bun run build`.
- **The static middleware runs before `authMiddleware`, deliberately.** A deep link
  like `/game/abc` carries no `X-API-Key` — the page it wants is the one that will do
  the logging in — so auth cannot run first. The cost is that `API_PREFIXES` in
  `static.ts` has to name every top-level router explicitly; a new router missing from
  that list gets HTML back instead of a JSON 404. `API_PREFIXES` is the *single* copy —
  `buildDevRoutes` in `http/serve.ts` reads the same list, so dev and `make serve`
  cannot drift apart the way `static.ts` and `vite.config.ts` could.

**Two things about the Bun bundler are cwd-sensitive and fail silently** — see
[`frontend/CLAUDE.md`](frontend/CLAUDE.md) for both (`[serve.static]` in *both*
`bunfig.toml` files, and `@source` in `src/index.css`).

## Testing

Both workspaces run on `bun test`. `bun run test` is the entry point; from the repo
root a bare `bun test` also collects everything. Current state: 1608 backend tests
across 65 files (~3.8s), 13 frontend tests across 2 files.

**`--parallel` (Bun 1.4) is in both `test` scripts.** It runs the files across N worker
processes (N = core count) and implies `--isolate`, so each file gets a fresh global.
The suite is safe under it by construction — no test binds a port (the Hono app is
driven through `app.fetch`) and every fixture database lives in its own `mkdtemp`
directory — and it stays green under `--randomize`. Drop the flag to debug a suspected
cross-file interaction.

**The root `bunfig.toml` is load-bearing.** Bun picks `bunfig.toml` by *current
directory*, so a run launched from the repo root does not see `backend/bunfig.toml`.
Without a root file, such a run got no preload — and the backend preload is what points
`os.tmpdir()` at tmpfs. Every fixture database fsynced to real disk instead: 79s for the
files that take under 4s from `backend/`, with the output buried under the ERROR lines
the preload's log sink discards.

CI (`.github/workflows/tests.yml`) runs typecheck, lint, both test suites, and the
schema drift gate.

## Quick Start

1. **Setup:**
   ```bash
   make install     # Claude Code CLI + bun install, then the .env wizard if needed
   ```

2. **Configure authentication:**
   ```bash
   make setup       # Prompts for a password, writes .env with API_KEY_HASH + JWT_SECRET
   ```

   Re-run `make setup` to change the password later — only `API_KEY_HASH` is rewritten,
   every other `.env` setting is preserved. The wizard is
   `backend/src/scripts/setup-env.ts`.

3. **Run:**
   ```bash
   make dev
   ```

4. **Open** http://localhost:8000 — or whichever port the startup log names, if 8000
   was taken. **That printed URL is the authoritative one.** Log in with the password
   you gave `make setup`.

## Configuration

Environment variables are read by `backend/src/config/settings.ts` from `<projectRoot>/.env`.

**Required:**

- `API_KEY_HASH` — bcrypt hash of your password (generate with `make setup`)
- `JWT_SECRET` — secret key for signing JWT tokens

**Optional:**

- `DATABASE_URL` — SQLite URL; unset resolves to `<projectRoot>/claudeworld.db`
- `USER_NAME` — display name for user messages in chat (default: "User")
- `DEBUG_AGENTS` — "true" for verbose agent logging
- `USE_SONNET` — "true" to use Sonnet instead of Opus (default: false)
- `ENABLE_GUEST_LOGIN` / `GUEST_PASSWORD_HASH` — guest login (default: enabled)
- `GUIDELINES_FILE` — override the guidelines YAML basename
- `PRIORITY_AGENTS`, `MAX_CONCURRENT_ROOMS` — orchestration tuning
- `IMAGE_WEBP_QUALITY` (1–100, default 85), `IMAGE_CONVERT_TO_WEBP` (default true)
- `FRONTEND_URL`, `VERCEL_URL` — CORS origins (only for a split deployment)
- `FRONTEND_DIST` — directory of a built frontend to serve on the API's port
  (default: `<projectRoot>/frontend/dist` when it exists)
- `SERVE_FRONTEND` — "false" to serve the API only, ignoring `frontend/dist`
- `FRONTEND_DEV` — "true" to bundle and serve `frontend/` in-process with HMR
- `PORT` — preferred port (default 8000); a taken port falls back to an OS-assigned one
- `PERF_LOG` — "true" to append latency metrics to `latency.log`
- `ENABLE_CLI_TRACING`, `CLI_TRACE_OUTPUT` — CLI tracing (requires a patched CLI)
- `CLAUDEWORLD_ROOT` — pin the project root, bypassing directory discovery

**Claude API:**

- `CLAUDE_API_KEY` — direct API key for production deployments
  (from console.anthropic.com)
- If unset, uses Claude Code web authentication (requires an active Claude Code session)

## LSP Support

Claude Code can use the LSP tool for code intelligence (TypeScript LSP across both
workspaces): `documentSymbol`, `hover`, `goToDefinition`, `findReferences`,
`incomingCalls` / `outgoingCalls`.

## Distribution

End users install via release-hosted scripts in `scripts/install/`, attached to every
GitHub release so the `latest/download/` URLs resolve:

- `install.sh` — macOS/Linux/WSL; source install to `~/.claudeworld` plus a
  `claudeworld` launcher. Upgrades in place, preserving `.env`, `claudeworld.db`,
  `worlds/` and edited agents.
- `install.ps1` — Windows; downloads a prebuilt `ClaudeWorld.exe`.

`.gitattributes` pins `*.sh` to LF because the Windows release runner checks out with
`core.autocrlf=true`.

Releases are cut with `gh release create <tag> --target master --generate-notes`;
`.github/workflows/release.yml` builds the binaries on `published`, smoke-tests the Linux
one, and attaches them with the installers and a `SHA256SUMS`.

```bash
bun run build:exe            # dist/claudeworld      (linux-x64)
bun run build:exe:windows    # dist/ClaudeWorld.exe  (windows-x64, cross-compiled)
```

**The Windows executable is `bun build --compile` output**, not the PyInstaller bundle it
was in the Python era. `scripts/build/exe-bundle.ts` stages the two embedded trees and
`backend/src/exe/` is the runtime half. Three things are load-bearing:

- **The frontend rides inside the binary; the data trees do not.** `agents/` and
  `config/` are hot-reloaded, user-edited and *written to*, so the exe unpacks them
  beside itself and never overwrites a file the user changed — see
  `backend/src/exe/assets.ts` and the seed manifest it keeps. `relocateSeed` there
  carries a user's edits across when a seed path is renamed between releases.
- **The `claude` CLI is not in there.** The SDK ships it as a ~330MB native binary per
  platform, so the exe resolves whatever Claude Code the user has installed
  (`backend/src/sdk/client/cli-path.ts`). Both installers check for it.
- **There is no native window.** PyInstaller shipped pywebview; Bun has no equivalent, so
  the binary opens the system browser at the port it won. macOS binaries are not published
  because an unsigned download is quarantined on arrival.

[`docs/deployment.md`](docs/deployment.md) has the details.

## History

ClaudeWorld evolved from ChitChats, a multi-agent chat room application where Claude
agents with different personalities interacted in real time.

The backend was a Python/FastAPI application until the TypeScript port landed; the
Python tree was deleted once the port reached parity, and `backend/` is now the only
backend. [`docs/ts-migration-plan.md`](docs/ts-migration-plan.md) records what that
involved and is kept for its gotchas table, not as a live plan. Comments across
`backend/src/` still cite Python filenames as the source of a port — those are
provenance notes; the files they name are gone.
