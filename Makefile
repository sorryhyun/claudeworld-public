.PHONY: help install setup run-backend run-backend-sqlite run-backend-perf run-backend-trace run-frontend run-tunnel-backend run-tunnel-frontend dev dev-postgresql dev-perf dev-trace diagnose-traces prod stop clean generate-hash build-exe

# Use bash for all commands
SHELL := /bin/bash

help:
	@echo "ClaudeWorld - Available commands:"
	@echo ""
	@echo "Development:"
	@echo "  make dev               - Run backend (SQLite) + frontend (default, no PostgreSQL needed)"
	@echo "  make dev-postgresql    - Run backend (PostgreSQL) + frontend (requires PostgreSQL installed)"
	@echo "  make dev-perf          - Run backend (SQLite) + frontend with performance logging (outputs to latency.log)"
	@echo "  make install           - Install all dependencies (backend + frontend)"
	@echo "  make run-backend       - Run backend server only (PostgreSQL)"
	@echo "  make run-backend-sqlite- Run backend server only (SQLite)"
	@echo "  make run-backend-perf  - Run backend server only (SQLite) with performance logging"
	@echo "  make run-backend-trace - Run backend server only (SQLite) with CLI tracing"
	@echo "  make run-frontend      - Run frontend server only"
	@echo ""
	@echo "CLI Tracing (requires patched CLI with observability patches):"
	@echo "  make dev-trace         - Run dev mode with CLI tracing (outputs to traces.jsonl)"
	@echo "  make diagnose-traces   - Analyze trace file for bottlenecks (FILE=traces.jsonl)"
	@echo ""
	@echo "Setup:"
	@echo "  make setup             - Run .env setup wizard (or re-run with --force)"
	@echo "  make generate-hash     - Generate password hash for authentication"
	@echo ""
	@echo "Deployment (Cloudflare tunnels for remote access):"
	@echo "  make prod              - Start tunnel + auto-update Vercel env + redeploy"
	@echo "  make run-tunnel-backend - Run Cloudflare tunnel for backend"
	@echo "  make run-tunnel-frontend- Run Cloudflare tunnel for frontend"
	@echo ""
	@echo "Build:"
	@echo "  make build-exe         - Build Windows executable (requires frontend build first)"
	@echo ""
	@echo "Maintenance:"
	@echo "  make stop              - Stop all running servers"
	@echo "  make clean             - Clean build artifacts and caches"

install:
	@echo "Installing Claude Code CLI globally..."
	sudo npm install -g @anthropic-ai/claude-code || echo "Warning: Failed to install Claude Code CLI globally. You may need to run with sudo."
	@echo "Installing backend dependencies with uv..."
	uv sync
	@echo "Installing frontend dependencies..."
	cd frontend && npm install
	@echo ""
	@echo "Checking .env configuration..."
	@if uv run python scripts/setup/setup_env.py --check 2>/dev/null; then \
		echo ""; \
	else \
		echo ""; \
		echo "Running first-time setup wizard..."; \
		uv run python scripts/setup/setup_env.py; \
	fi
	@echo "Done!"

setup:
	@echo "Running .env setup wizard..."
	@if [ "$(FORCE)" = "1" ]; then \
		uv run python scripts/setup/setup_env.py --force; \
	else \
		uv run python scripts/setup/setup_env.py; \
	fi

run-backend:
	@echo "Starting backend server (PostgreSQL)..."
	cd backend && uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000

run-backend-sqlite:
	@echo "Starting backend server (SQLite)..."
	cd backend && DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000

run-backend-perf:
	@echo "Starting backend server (SQLite) with performance logging..."
	@echo "Performance metrics will be written to ./latency.log"
	@echo "Terminal output will be written to ./run.log"
	cd backend && DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db PERF_LOG=true uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000 2>&1 | tee $(PWD)/run.log

run-frontend:
	@echo "Starting frontend server..."
	cd frontend && npm run dev

run-tunnel-backend:
	@echo "Starting Cloudflare tunnel for backend..."
	cloudflared tunnel --url http://localhost:8000

run-tunnel-frontend:
	@echo "Starting Cloudflare tunnel for frontend..."
	cloudflared tunnel --url http://localhost:5173

dev:
	@mkdir -p /tmp/claude-empty
	@echo "Starting backend (SQLite) and frontend..."
	@echo "Backend will run on http://localhost:8000 (SQLite: ./claudeworld.db)"
	@echo "Frontend will run on http://localhost:5173"
	@echo "For remote access, run 'make run-tunnel-backend' and 'make run-tunnel-frontend' in separate terminals"
	@echo "Press Ctrl+C to stop all servers"
	@$(MAKE) -j2 run-backend-sqlite run-frontend

dev-postgresql:
	@mkdir -p /tmp/claude-empty
	@echo "Starting backend (PostgreSQL) and frontend..."
	@echo "Backend will run on http://localhost:8000"
	@echo "Frontend will run on http://localhost:5173"
	@echo "For remote access, run 'make run-tunnel-backend' and 'make run-tunnel-frontend' in separate terminals"
	@echo "Press Ctrl+C to stop all servers"
	@$(MAKE) -j2 run-backend run-frontend

dev-perf:
	@mkdir -p /tmp/claude-empty
	@echo "Starting backend (SQLite) and frontend with PERFORMANCE LOGGING..."
	@echo "Backend will run on http://localhost:8000 (SQLite: ./claudeworld.db)"
	@echo "Frontend will run on http://localhost:5173"
	@echo ""
	@echo "📊 PERFORMANCE LOGGING ENABLED"
	@echo "   Performance metrics: ./latency.log"
	@echo "   Terminal output:     ./run.log"
	@echo ""
	@echo "   Monitor with: tail -f latency.log"
	@echo "   Or both:      tail -f latency.log run.log"
	@echo ""
	@echo "Press Ctrl+C to stop all servers"
	@$(MAKE) -j2 run-backend-perf run-frontend

run-backend-trace:
	@echo "Starting backend server (SQLite) with CLI tracing..."
	@echo "Traces will be written to ./traces.jsonl"
	@echo "Analyze with: make diagnose-traces FILE=traces.jsonl"
	cd backend && DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db ENABLE_CLI_TRACING=true uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000 2>$(PWD)/traces.jsonl

dev-trace:
	@mkdir -p /tmp/claude-empty
	@echo "Starting backend (SQLite) and frontend with CLI TRACING..."
	@echo "Backend will run on http://localhost:8000 (SQLite: ./claudeworld.db)"
	@echo "Frontend will run on http://localhost:5173"
	@echo ""
	@echo "🔍 CLI TRACING ENABLED (requires patched CLI with observability patches)"
	@echo "   Trace output: ./traces.jsonl"
	@echo ""
	@echo "   Monitor with: tail -f traces.jsonl"
	@echo "   Analyze with: make diagnose-traces FILE=traces.jsonl"
	@echo ""
	@echo "Press Ctrl+C to stop all servers"
	@$(MAKE) -j2 run-backend-trace run-frontend

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
		uv run python scripts/diagnose_traces.py "$(FILE)" --threshold $$THRESHOLD --format $$FORMAT; \
	fi

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
	@cd backend && uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000 &
	@sleep 2
	@# Run tunnel script (handles URL detection, Vercel update, and redeploy)
	@./scripts/deploy/update_vercel_backend_url.sh

stop:
	@echo "Stopping servers..."
	@pkill -f "uvicorn main:app" || true
	@pkill -f "vite" || true
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
	@echo "Clean complete!"

generate-hash:
	@echo "Generating password hash..."
	uv run python scripts/setup/generate_hash.py

build-exe:
	@echo "Building executable..."
	@echo "Step 1: Building frontend..."
	cd frontend && npm run build
	@echo "Step 2: Building executable with PyInstaller..."
	uv run pyinstaller ClaudeWorld.spec --noconfirm
	@# Rename to add .exe suffix if not present (for cross-platform builds)
	@if [ -f "dist/ClaudeWorld" ] && [ ! -f "dist/ClaudeWorld.exe" ]; then \
		mv dist/ClaudeWorld dist/ClaudeWorld.exe; \
	fi
	@echo ""
	@echo "Build complete! Executable is in dist/ClaudeWorld.exe"
