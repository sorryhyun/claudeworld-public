.PHONY: help install setup dev serve exe exe-windows run-backend run-backend-perf run-backend-trace dev-perf dev-trace run-tunnel-backend prod stop clean

# Every target here has to run from a PowerShell prompt as well as from bash.
#
# GNU Make on Windows hands each recipe line to `sh.exe` when one is on PATH (so
# a Git Bash prompt behaves like Linux) and to `cmd.exe` when none is -- which
# is what PowerShell gets. cmd shares almost nothing with sh: no `mkdir -p`, no
# `rm`, no `pkill`, no `VAR=value cmd` prefix, and `echo "text"` keeps its
# quotes. Rather than fork this file per platform, no recipe below uses shell
# syntax at all:
#
#   * everything printed to a human goes through `$(info ...)`, which make
#     writes itself without a shell, so spacing, quotes and emoji come out
#     identical everywhere;
#   * everything the backend needs to be told travels as an exported make
#     variable instead of a bash-only `VAR=value cmd` prefix;
#   * the two targets that shuffle files or processes (`clean`, `stop`) call
#     Bun, which brings its own cross-platform shell.
#
# What is left per line is a single command plus the `|`, `2>` and `||`
# operators cmd and sh happen to spell the same way. `make prod` is the one
# exception -- see the note there.
ifneq ($(OS),Windows_NT)
SHELL := /bin/bash
endif

# Whether the backend serves frontend/dist on its own port. On by default, so
# `make run-backend` after a build is a working single-port app. `make dev`
# overrides it to false and sets FRONTEND_DEV=true instead: there the backend
# bundles frontend/ in-process with HMR, and a dist/ left over from an earlier
# build must not shadow it with a stale bundle.
SERVE_FRONTEND ?= true
FRONTEND_DEV ?= false
export SERVE_FRONTEND FRONTEND_DEV

# Whether the backend opens a browser once it knows which port it got. Left
# unset the backend follows FRONTEND_DEV, so `make dev` opens a tab and
# `make run-backend` does not. `OPEN_BROWSER=false make dev` opts out.
# The backend has to be the one to launch it: with a negotiable port, this
# file no longer knows the URL the tab should land on.
OPEN_BROWSER ?=
HOST ?= 127.0.0.1
export OPEN_BROWSER HOST

# The port every target prefers, and the URL built from it. One definition
# rather than the sixteen literal 8000s this file used to carry -- they drifted
# in the obvious way, with help text naming a port the recipe below it no longer
# used. `PORT=9000 make dev` now moves the whole file at once.
#
# It is only a *preference*: a taken port falls back to an OS-assigned one
# (backend/src/http/serve.ts), which is safe because the frontend is served from
# the API's own origin and issues relative URLs.
PORT ?= 8000
URL := http://localhost:$(PORT)
export PORT

# The single SQLite database the whole repo shares. The `sqlite+aiosqlite://`
# spelling is a leftover of the SQLAlchemy era that `sqlitePathFromUrl` still
# accepts; it is kept because existing `.env` files carry it. `DATABASE_URL`
# must be set for every target -- the built-in default is Postgres, which this
# backend cannot open.
#
# `$(CURDIR)`, not `$(PWD)`: make defines CURDIR itself, while PWD is inherited
# from the shell and is simply empty when make was started from PowerShell.
DATABASE_URL := sqlite+aiosqlite:///$(CURDIR)/claudeworld.db
export DATABASE_URL

# `sudo npm -g` is how a Unix box installs a global CLI and is exactly wrong on
# Windows, where npm writes to a per-user prefix and there is no sudo.
ifeq ($(OS),Windows_NT)
SUDO :=
else
SUDO := sudo
endif

define HELP_TEXT
ClaudeWorld - Available commands:

Development:
  make dev               - Run backend + frontend, ONE process  [DEFAULT]
                           One port: $(URL) (frontend has HMR).
                           A taken port falls back to a free one, and a
                           browser opens on whichever port was won.
                           OPEN_BROWSER=false skips the browser.
  make serve             - Same, but from a built frontend/dist (no HMR)
                           One process, one port: $(URL)
  make install           - Install all dependencies (backend + frontend)
  make run-backend       - Run the API only, no frontend bundling
  make dev-perf          - make dev with performance logging (./latency.log)
  make dev-trace         - make dev with CLI tracing  (./traces.jsonl)
                           Tracing needs a CLI patched for observability.

Setup:
  make setup             - Set up .env: prompts for your password (re-run to change it)

Packaging:
  make exe               - Build the standalone binary for this platform
  make exe-windows       - Cross-compile dist/ClaudeWorld.exe
                           One file; it unpacks agents/ and the prompt
                           config beside itself and needs the claude CLI.

Deployment (Cloudflare tunnels for remote access):
  make prod              - Start tunnel + auto-update Vercel env + redeploy
                           POSIX shell only (WSL, or Git Bash on Windows).
  make run-tunnel-backend - Run Cloudflare tunnel for backend

Maintenance:
  make stop              - Stop all running servers
  make clean             - Clean build artifacts and caches

Windows: every target above except `make prod` runs from PowerShell, cmd or
Git Bash. GNU Make (winget install ezwinports.make) and Bun both have to be
on PATH.
endef

# Indentation has to survive, and `$(info   text)` trims its argument -- so
# every message with leading spaces, and every message longer than a line,
# lives in a variable. They are all printed before the recipe's first command
# runs (make expands a whole recipe up front), so each one announces what is
# about to happen rather than narrating it step by step.
define DEV_BANNER
Starting the backend with the frontend bundled in-process...

ℹ️  One process serves everything: /auth/*, the full /worlds/* game surface
   (onboarding, turns, travel, chat mode, state, polling) and the whole
   /rooms/* + /agents/* chat surface including SSE streaming.

A browser opens on the port the server wins -- OPEN_BROWSER=false skips it.
For remote access, run 'make run-tunnel-backend' in a separate terminal
Press Ctrl+C to stop.
endef

define PERF_BANNER
Starting dev mode with PERFORMANCE LOGGING...

   Performance metrics: ./latency.log
   Terminal output:     ./run.log
   Monitor with: tail -f latency.log run.log
endef

define TRACE_BANNER
Starting dev mode with CLI TRACING...

🔍 Requires a CLI patched with the observability patches.
   Trace output: ./traces.jsonl   (tail -f traces.jsonl)
endef

define EXE_BANNER
Building the standalone binary for this platform...

👉 dist/claudeworld — copy it anywhere; it unpacks agents/ and the
   prompt config beside itself on first launch.
endef

define INSTALL_BANNER
Installing the Claude Code CLI globally, then the backend and frontend
dependencies with bun, then checking .env (the setup wizard runs if it
is missing anything).

If the bun step fails, install Bun first: https://bun.sh
endef

define PROD_BANNER
Starting production deployment. This will:
  1. Start backend server
  2. Start cloudflared tunnel
  3. Auto-update VITE_API_BASE_URL on Vercel
  4. Trigger Vercel redeploy

Prerequisites: vercel CLI logged in (run 'vercel login' first)
endef

# `$(info)` alone is a recipe make considers empty, so it would report the
# target as up to date; `cd .` is the shortest no-op both cmd and sh accept.
help:
	$(info $(HELP_TEXT))
	@cd .

install:
	$(info $(INSTALL_BANNER))
	-$(SUDO) npm install -g @anthropic-ai/claude-code
	@bun install
	@bun run setup --check || bun run setup

setup:
	$(info Running .env setup wizard...)
	@bun run setup

run-backend:
	$(info Starting backend server (SQLite)...)
	@bun run dev:backend

run-backend-perf: export PERF_LOG := true
run-backend-perf:
	$(info Performance metrics will be written to ./latency.log)
	$(info Terminal output will be written to ./run.log)
	@bun run dev:backend 2>&1 | bun scripts/dev/tee.ts run.log

run-backend-trace: export ENABLE_CLI_TRACING := true
run-backend-trace:
	$(info Traces will be written to ./traces.jsonl)
	@bun run dev:backend 2>traces.jsonl

run-tunnel-backend:
	$(info Starting Cloudflare tunnel for backend...)
	@cloudflared tunnel --url $(URL)

dev:
	$(info $(DEV_BANNER))
	@$(MAKE) --no-print-directory SERVE_FRONTEND=false FRONTEND_DEV=true run-backend

dev-perf:
	$(info $(PERF_BANNER))
	@$(MAKE) --no-print-directory SERVE_FRONTEND=false FRONTEND_DEV=true run-backend-perf

dev-trace:
	$(info $(TRACE_BANNER))
	@$(MAKE) --no-print-directory SERVE_FRONTEND=false FRONTEND_DEV=true run-backend-trace

serve:
	$(info Building the frontend, then serving it and the API on ONE port...)
	$(info 👉 Open $(URL) — frontend and API share the origin.)
	$(info Press Ctrl+C to stop.)
	@bun run serve

exe:
	$(info $(EXE_BANNER))
	@bun run build:exe

exe-windows:
	$(info Cross-compiling the Windows executable... 👉 dist/ClaudeWorld.exe)
	@bun run build:exe:windows

# The one target that needs a POSIX shell: it backgrounds the server with `&`
# and then hands off to a shell script. On Windows, run it from Git Bash or WSL.
prod:
	$(info $(PROD_BANNER))
	@bun run --filter '@claudeworld/backend' start &
	@sleep 2
	@./scripts/deploy/update_vercel_backend_url.sh

stop:
	$(info Stopping servers...)
	@bun scripts/dev/stop.ts

clean:
	$(info Cleaning build artifacts (including the SQLite database)...)
	@bun run clean
