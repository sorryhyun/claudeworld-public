.PHONY: help install setup run-backend run-backend-sqlite run-backend-ts run-backend-perf run-backend-trace run-tunnel-backend dev dev-python dev-postgresql dev-perf dev-trace diagnose-traces serve prod stop clean generate-icon build-exe

# Use bash for all commands
SHELL := /bin/bash

# Whether the backend serves frontend/dist on its own port. On by default, so
# `make run-backend-ts` after a build is a working single-port app. `make dev`
# overrides it to false and sets FRONTEND_DEV=true instead: there the backend
# bundles frontend/ in-process with HMR, and a dist/ left over from an earlier
# build must not shadow it with a stale bundle.
SERVE_FRONTEND ?= true
FRONTEND_DEV ?= false

help:
	@echo "ClaudeWorld - Available commands:"
	@echo ""
	@echo "Development:"
	@echo "  make dev               - Run TypeScript backend + frontend, ONE process  [DEFAULT]"
	@echo "                           One port: http://localhost:8000 (frontend has HMR)."
	@echo "                           Falls back to a free port if 8000 is taken -- the URL"
	@echo "                           it prints is authoritative."
	@echo "  make serve             - Same, but from a built frontend/dist (no HMR)"
	@echo "                           One process, one port: http://localhost:8000"
	@echo "  make dev-python        - Run Python backend (SQLite) + frontend (legacy, being retired)"
	@echo "  make dev-postgresql    - Run Python backend (PostgreSQL) + frontend (requires PostgreSQL)"
	@echo "  make dev-perf          - Run Python backend (SQLite) + frontend with performance logging"
	@echo "  make install           - Install all dependencies (backend + backend-ts + frontend)"
	@echo "  make run-backend-ts    - Run TypeScript backend server only (SQLite)"
	@echo "  make run-backend       - Run Python backend server only (PostgreSQL)"
	@echo "  make run-backend-sqlite- Run Python backend server only (SQLite)"
	@echo "  make run-backend-perf  - Run backend server only (SQLite) with performance logging"
	@echo "  make run-backend-trace - Run backend server only (SQLite) with CLI tracing"
	@echo ""
	@echo "CLI Tracing (requires patched CLI with observability patches):"
	@echo "  make dev-trace         - Run dev mode with CLI tracing (outputs to traces.jsonl)"
	@echo "  make diagnose-traces   - Analyze trace file for bottlenecks (FILE=traces.jsonl)"
	@echo ""
	@echo "Setup:"
	@echo "  make setup             - Set up .env: prompts for your password (re-run to change it)"
	@echo ""
	@echo "Deployment (Cloudflare tunnels for remote access):"
	@echo "  make prod              - Start tunnel + auto-update Vercel env + redeploy"
	@echo "  make run-tunnel-backend - Run Cloudflare tunnel for backend"
	@echo ""
	@echo "Build:"
	@echo "  make generate-icon     - Regenerate application icon (assets/icon.ico + frontend favicon)"
	@echo "  make build-exe         - Build standalone executable with native window (requires frontend build first)"
	@echo ""
	@echo "Maintenance:"
	@echo "  make stop              - Stop all running servers"
	@echo "  make clean             - Clean build artifacts and caches"

install:
	@echo "Installing Claude Code CLI globally..."
	sudo npm install -g @anthropic-ai/claude-code || echo "Warning: Failed to install Claude Code CLI globally. You may need to run with sudo."
	@echo "Installing backend dependencies with uv..."
	uv sync
	@echo "Installing JS dependencies (backend-ts + frontend) with bun..."
	@if command -v bun >/dev/null 2>&1; then \
		bun install; \
	else \
		echo "Error: bun not found. Install it: curl -fsSL https://bun.sh/install | bash"; \
		exit 1; \
	fi
	@echo ""
	@echo "Checking .env configuration..."
	@if uv run python backend/scripts/setup_env.py --check 2>/dev/null; then \
		echo ""; \
	else \
		echo ""; \
		echo "Running first-time setup wizard..."; \
		uv run python backend/scripts/setup_env.py; \
	fi
	@echo "Done!"

setup:
	@echo "Running .env setup wizard..."
	uv run python backend/scripts/setup_env.py

run-backend:
	@echo "Starting backend server (PostgreSQL)..."
	cd backend && uv run uvicorn main:app --host 127.0.0.1 --port 8000

run-backend-sqlite:
	@echo "Starting backend server (SQLite)..."
	cd backend && DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db uv run uvicorn main:app --host 127.0.0.1 --port 8000

run-backend-ts:
	@echo "Starting TypeScript backend server (SQLite)..."
	HOST=127.0.0.1 PORT=8000 SERVE_FRONTEND=$(SERVE_FRONTEND) FRONTEND_DEV=$(FRONTEND_DEV) DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db bun run dev:backend

run-backend-perf:
	@echo "Starting backend server (SQLite) with performance logging..."
	@echo "Performance metrics will be written to ./latency.log"
	@echo "Terminal output will be written to ./run.log"
	cd backend && DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db PERF_LOG=true uv run uvicorn main:app --host 127.0.0.1 --port 8000 2>&1 | tee $(PWD)/run.log

run-tunnel-backend:
	@echo "Starting Cloudflare tunnel for backend..."
	cloudflared tunnel --url http://localhost:8000

dev:
	@mkdir -p /tmp/claude-empty
	@echo "Starting the TypeScript backend with the frontend bundled in-process..."
	@echo ""
	@echo "👉 Open http://localhost:8000 — frontend and API share the origin."
	@echo "   If 8000 is taken the server picks a free port instead and prints it;"
	@echo "   that printed URL is the authoritative one."
	@echo "   (SQLite: ./claudeworld.db, frontend has hot module replacement)"
	@echo ""
	@echo "ℹ️  One process serves everything: /auth/*, the full /worlds/* game surface"
	@echo "   (onboarding, turns, travel, chat mode, state, polling) and the whole"
	@echo "   /rooms/* + /agents/* chat surface including SSE streaming."
	@echo ""
	@echo "For remote access, run 'make run-tunnel-backend' in a separate terminal"
	@echo "Press Ctrl+C to stop."
	@$(MAKE) SERVE_FRONTEND=false FRONTEND_DEV=true run-backend-ts

dev-python:
	@mkdir -p /tmp/claude-empty
	@echo "Starting Python backend (SQLite) and frontend..."
	@echo "Backend will run on http://localhost:8000 (SQLite: ./claudeworld.db)"
	@echo "For remote access, run 'make run-tunnel-backend' in a separate terminal"
	@echo "Press Ctrl+C to stop all servers"
	@echo ""
	@echo "⚠️  API only — there is no dev frontend for the Python backend any more."
	@echo "   The Vite proxy that used to serve one was removed with Vite; the"
	@echo "   TypeScript backend now bundles the frontend itself. Use 'make dev'"
	@echo "   for a browsable app, and this target to exercise the Python API."
	@echo ""
	@$(MAKE) run-backend-sqlite

dev-postgresql:
	@mkdir -p /tmp/claude-empty
	@echo "Starting backend (PostgreSQL) and frontend..."
	@echo "Backend will run on http://localhost:8000"
	@echo "For remote access, run 'make run-tunnel-backend' in a separate terminal"
	@echo "Press Ctrl+C to stop all servers"
	@echo ""
	@echo "⚠️  API only — there is no dev frontend for the Python backend any more."
	@echo "   The Vite proxy that used to serve one was removed with Vite; the"
	@echo "   TypeScript backend now bundles the frontend itself. Use 'make dev'"
	@echo "   for a browsable app, and this target to exercise the Python API."
	@echo ""
	@$(MAKE) run-backend

dev-perf:
	@mkdir -p /tmp/claude-empty
	@echo "Starting backend (SQLite) and frontend with PERFORMANCE LOGGING..."
	@echo "Backend will run on http://localhost:8000 (SQLite: ./claudeworld.db)"
	@echo ""
	@echo "📊 PERFORMANCE LOGGING ENABLED"
	@echo "   Performance metrics: ./latency.log"
	@echo "   Terminal output:     ./run.log"
	@echo ""
	@echo "   Monitor with: tail -f latency.log"
	@echo "   Or both:      tail -f latency.log run.log"
	@echo ""
	@echo "Press Ctrl+C to stop all servers"
	@echo ""
	@echo "⚠️  API only — there is no dev frontend for the Python backend any more."
	@echo "   The Vite proxy that used to serve one was removed with Vite; the"
	@echo "   TypeScript backend now bundles the frontend itself. Use 'make dev'"
	@echo "   for a browsable app, and this target to exercise the Python API."
	@echo ""
	@$(MAKE) run-backend-perf

run-backend-trace:
	@echo "Starting backend server (SQLite) with CLI tracing..."
	@echo "Traces will be written to ./traces.jsonl"
	@echo "Analyze with: make diagnose-traces FILE=traces.jsonl"
	cd backend && DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db ENABLE_CLI_TRACING=true uv run uvicorn main:app --host 127.0.0.1 --port 8000 2>$(PWD)/traces.jsonl

dev-trace:
	@mkdir -p /tmp/claude-empty
	@echo "Starting backend (SQLite) and frontend with CLI TRACING..."
	@echo "Backend will run on http://localhost:8000 (SQLite: ./claudeworld.db)"
	@echo ""
	@echo "🔍 CLI TRACING ENABLED (requires patched CLI with observability patches)"
	@echo "   Trace output: ./traces.jsonl"
	@echo ""
	@echo "   Monitor with: tail -f traces.jsonl"
	@echo "   Analyze with: make diagnose-traces FILE=traces.jsonl"
	@echo ""
	@echo "Press Ctrl+C to stop all servers"
	@echo ""
	@echo "⚠️  API only — there is no dev frontend for the Python backend any more."
	@echo "   The Vite proxy that used to serve one was removed with Vite; the"
	@echo "   TypeScript backend now bundles the frontend itself. Use 'make dev'"
	@echo "   for a browsable app, and this target to exercise the Python API."
	@echo ""
	@$(MAKE) run-backend-trace

diagnose-traces:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make diagnose-traces FILE=traces.jsonl [THRESHOLD=100]"; \
		echo ""; \
		echo "Analyzes CLI traces to identify performance bottlenecks."; \
		echo ""; \
		echo "Arguments:"; \
		echo "  FILE      - Path to trace file (JSONL format)"; \
		echo "  THRESHOLD - Bottleneck threshold in ms (default: 100)"; \
		echo "  FORMAT    - Output format: text or json (default: text)"; \
	else \
		THRESHOLD=$${THRESHOLD:-100}; \
		FORMAT=$${FORMAT:-text}; \
		uv run python backend/scripts/diagnose_traces.py "$(FILE)" --threshold $$THRESHOLD --format $$FORMAT; \
	fi

serve:
	@mkdir -p /tmp/claude-empty
	@echo "Building frontend..."
	bun run build
	@echo ""
	@echo "Starting TypeScript backend with the built frontend on ONE port..."
	@echo "👉 Open http://localhost:8000 — frontend and API share the origin."
	@echo "Press Ctrl+C to stop."
	HOST=127.0.0.1 PORT=8000 DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db bun run --filter '@claudeworld/backend' start

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
	@cd backend && uv run uvicorn main:app --host 127.0.0.1 --port 8000 &
	@sleep 2
	@# Run tunnel script (handles URL detection, Vercel update, and redeploy)
	@./scripts/deploy/update_vercel_backend_url.sh

stop:
	@echo "Stopping servers..."
	@pkill -f "uvicorn main:app" || true
	@pkill -f "bun.*src/main.ts" || true
	@pkill -f "cloudflared" || true
	@echo "Servers stopped."

clean:
	@echo "Cleaning build artifacts..."
	rm -rf backend/__pycache__
	rm -rf backend/**/__pycache__
	rm -rf backend/*.db
	rm -f claudeworld.db
	rm -f latency.log
	rm -f traces.jsonl
	rm -rf frontend/dist
	rm -rf frontend/node_modules/.vite
	rm -rf backend-ts/dist
	@echo "Clean complete!"

generate-icon:
	@echo "Generating application icon..."
	uv run python backend/scripts/generate_icon.py
	@echo "Done! Generated assets/icon.ico and frontend/public/favicon.svg"

build-exe:
	@echo "Building standalone executable..."
	@echo "Step 1: Generating application icon..."
	uv run python backend/scripts/generate_icon.py
	@echo "Step 2: Building frontend..."
	bun run build
	@echo "Step 3: Building executable with PyInstaller..."
	uv run pyinstaller ClaudeWorld.spec --noconfirm
	@# Rename to add .exe suffix if not present (for cross-platform builds)
	@if [ -f "dist/ClaudeWorld" ] && [ ! -f "dist/ClaudeWorld.exe" ]; then \
		mv dist/ClaudeWorld dist/ClaudeWorld.exe; \
	fi
	@echo ""
	@echo "Build complete! Executable is in dist/ClaudeWorld.exe"
	@echo "The application opens in a native window (use --browser flag for browser mode)"
