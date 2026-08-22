.PHONY: help install setup dev serve exe exe-windows run-backend run-backend-perf run-backend-trace dev-perf dev-trace run-tunnel-backend prod stop clean

# Use bash for all commands
SHELL := /bin/bash

# Whether the backend serves frontend/dist on its own port. On by default, so
# `make run-backend` after a build is a working single-port app. `make dev`
# overrides it to false and sets FRONTEND_DEV=true instead: there the backend
# bundles frontend/ in-process with HMR, and a dist/ left over from an earlier
# build must not shadow it with a stale bundle.
SERVE_FRONTEND ?= true
FRONTEND_DEV ?= false

# Whether the backend opens a browser once it knows which port it got. Left
# unset the backend follows FRONTEND_DEV, so `make dev` opens a tab and
# `make run-backend` does not. `OPEN_BROWSER=false make dev` opts out.
# The backend has to be the one to launch it: with a negotiable port, this
# file no longer knows the URL the tab should land on.
OPEN_BROWSER ?=

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

# The single SQLite database the whole repo shares. The `sqlite+aiosqlite://`
# spelling is a leftover of the SQLAlchemy era that `sqlitePathFromUrl` still
# accepts; it is kept because existing `.env` files carry it. `DATABASE_URL`
# must be set for every target -- the built-in default is Postgres, which this
# backend cannot open.
SQLITE_URL := sqlite+aiosqlite:///$(PWD)/claudeworld.db

# Every server target starts from this. One definition rather than one per
# target, each drifting its own way.
RUN_BACKEND = HOST=127.0.0.1 PORT=$(PORT) SERVE_FRONTEND=$(SERVE_FRONTEND) \
	FRONTEND_DEV=$(FRONTEND_DEV) OPEN_BROWSER=$(OPEN_BROWSER) \
	DATABASE_URL=$(SQLITE_URL)

help:
	@echo "ClaudeWorld - Available commands:"
	@echo ""
	@echo "Development:"
	@echo "  make dev               - Run backend + frontend, ONE process  [DEFAULT]"
	@echo "                           One port: $(URL) (frontend has HMR)."
	@echo "                           A taken port falls back to a free one, and a"
	@echo "                           browser opens on whichever port was won."
	@echo "                           OPEN_BROWSER=false skips the browser."
	@echo "  make serve             - Same, but from a built frontend/dist (no HMR)"
	@echo "                           One process, one port: $(URL)"
	@echo "  make install           - Install all dependencies (backend + frontend)"
	@echo "  make run-backend       - Run the API only, no frontend bundling"
	@echo "  make dev-perf          - make dev with performance logging (./latency.log)"
	@echo "  make dev-trace         - make dev with CLI tracing  (./traces.jsonl)"
	@echo "                           Tracing needs a CLI patched for observability."
	@echo ""
	@echo "Setup:"
	@echo "  make setup             - Set up .env: prompts for your password (re-run to change it)"
	@echo ""
	@echo "Packaging:"
	@echo "  make exe               - Build the standalone binary for this platform"
	@echo "  make exe-windows       - Cross-compile dist/ClaudeWorld.exe"
	@echo "                           One file; it unpacks agents/ and the prompt"
	@echo "                           config beside itself and needs the claude CLI."
	@echo ""
	@echo "Deployment (Cloudflare tunnels for remote access):"
	@echo "  make prod              - Start tunnel + auto-update Vercel env + redeploy"
	@echo "  make run-tunnel-backend - Run Cloudflare tunnel for backend"
	@echo ""
	@echo "Maintenance:"
	@echo "  make stop              - Stop all running servers"
	@echo "  make clean             - Clean build artifacts and caches"

install:
	@echo "Installing Claude Code CLI globally..."
	sudo npm install -g @anthropic-ai/claude-code || echo "Warning: Failed to install Claude Code CLI globally. You may need to run with sudo."
	@echo "Installing dependencies (backend + frontend) with bun..."
	@if command -v bun >/dev/null 2>&1; then \
		bun install; \
	else \
		echo "Error: bun not found. Install it: curl -fsSL https://bun.sh/install | bash"; \
		exit 1; \
	fi
	@echo ""
	@echo "Checking .env configuration..."
	@if bun run setup --check 2>/dev/null; then \
		echo ""; \
	else \
		echo ""; \
		echo "Running first-time setup wizard..."; \
		bun run setup; \
	fi
	@echo "Done!"

setup:
	@echo "Running .env setup wizard..."
	@bun run setup

run-backend:
	@echo "Starting backend server (SQLite)..."
	$(RUN_BACKEND) bun run dev:backend

run-backend-perf:
	@echo "Performance metrics will be written to ./latency.log"
	@echo "Terminal output will be written to ./run.log"
	$(RUN_BACKEND) PERF_LOG=true bun run dev:backend 2>&1 | tee $(PWD)/run.log

run-backend-trace:
	@echo "Traces will be written to ./traces.jsonl"
	$(RUN_BACKEND) ENABLE_CLI_TRACING=true bun run dev:backend 2>$(PWD)/traces.jsonl

run-tunnel-backend:
	@echo "Starting Cloudflare tunnel for backend..."
	cloudflared tunnel --url $(URL)

dev:
	@mkdir -p /tmp/claude-empty
	@echo "Starting the backend with the frontend bundled in-process..."
	@echo ""
	@echo "ℹ️  One process serves everything: /auth/*, the full /worlds/* game surface"
	@echo "   (onboarding, turns, travel, chat mode, state, polling) and the whole"
	@echo "   /rooms/* + /agents/* chat surface including SSE streaming."
	@echo ""
	@echo "A browser opens on the port the server wins -- OPEN_BROWSER=false skips it."
	@echo "For remote access, run 'make run-tunnel-backend' in a separate terminal"
	@echo "Press Ctrl+C to stop."
	@$(MAKE) SERVE_FRONTEND=false FRONTEND_DEV=true run-backend

dev-perf:
	@mkdir -p /tmp/claude-empty
	@echo "Starting dev mode with PERFORMANCE LOGGING..."
	@echo ""
	@echo "   Performance metrics: ./latency.log"
	@echo "   Terminal output:     ./run.log"
	@echo "   Monitor with: tail -f latency.log run.log"
	@echo ""
	@$(MAKE) SERVE_FRONTEND=false FRONTEND_DEV=true run-backend-perf

dev-trace:
	@mkdir -p /tmp/claude-empty
	@echo "Starting dev mode with CLI TRACING..."
	@echo ""
	@echo "🔍 Requires a CLI patched with the observability patches."
	@echo "   Trace output: ./traces.jsonl   (tail -f traces.jsonl)"
	@echo ""
	@$(MAKE) SERVE_FRONTEND=false FRONTEND_DEV=true run-backend-trace

serve:
	@mkdir -p /tmp/claude-empty
	@echo "Building frontend..."
	bun run build
	@echo ""
	@echo "Starting the backend with the built frontend on ONE port..."
	@echo "👉 Open $(URL) — frontend and API share the origin."
	@echo "Press Ctrl+C to stop."
	HOST=127.0.0.1 PORT=$(PORT) DATABASE_URL=$(SQLITE_URL) bun run --filter '@claudeworld/backend' start

exe:
	@echo "Building the standalone binary for this platform..."
	bun run build:exe
	@echo ""
	@echo "👉 dist/claudeworld — copy it anywhere; it unpacks agents/ and the"
	@echo "   prompt config beside itself on first launch."

exe-windows:
	@echo "Cross-compiling the Windows executable..."
	bun run build:exe:windows
	@echo ""
	@echo "👉 dist/ClaudeWorld.exe"

prod:
	@echo "Starting production deployment..."
	@echo "This will:"
	@echo "  1. Start backend server"
	@echo "  2. Start cloudflared tunnel"
	@echo "  3. Auto-update VITE_API_BASE_URL on Vercel"
	@echo "  4. Trigger Vercel redeploy"
	@echo ""
	@echo "Prerequisites: vercel CLI logged in (run 'vercel login' first)"
	@echo ""
	@# Start backend in background
	@$(RUN_BACKEND) bun run --filter '@claudeworld/backend' start &
	@sleep 2
	@# Run tunnel script (handles URL detection, Vercel update, and redeploy)
	@./scripts/deploy/update_vercel_backend_url.sh

stop:
	@echo "Stopping servers..."
	@pkill -f "bun.*src/main.ts" || true
	@pkill -f "cloudflared" || true
	@echo "Servers stopped."

clean:
	@echo "Cleaning build artifacts..."
	rm -f claudeworld.db claudeworld.db-shm claudeworld.db-wal
	rm -f latency.log run.log traces.jsonl
	rm -rf frontend/dist
	rm -rf backend/dist
	rm -rf dist
	@echo "Clean complete!"
