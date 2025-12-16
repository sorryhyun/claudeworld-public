.PHONY: help install run-backend run-backend-sqlite run-backend-perf run-frontend run-tunnel-backend run-tunnel-frontend dev dev-postgresql dev-perf prod stop clean generate-hash simulate test-agents evaluate-agents evaluate-agents-cross load-test build-exe

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
	@echo "  make run-frontend      - Run frontend server only"
	@echo ""
	@echo "Setup:"
	@echo "  make generate-hash     - Generate password hash for authentication"
	@echo ""
	@echo "Testing & Simulation:"
	@echo "  make simulate          - Run chatroom simulation (requires args)"
	@echo "  make test-agents       - Test agent capabilities (THINKING=1 to show thinking, CHECK_ANT=1 to show model)"
	@echo "  make evaluate-agents   - Evaluate agent authenticity (sequential)"
	@echo "  make evaluate-agents-cross - Cross-evaluate two agents (SLOWER=1, SPEAKER=user|{char})"
	@echo "  make load-test         - Run network load test (requires args)"
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
	@echo "Done!"

run-backend:
	@echo "Starting backend server (PostgreSQL)..."
	cd backend && uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000

run-backend-sqlite:
	@echo "Starting backend server (SQLite)..."
	cd backend && DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000

run-backend-perf:
	@echo "Starting backend server (SQLite) with performance logging..."
	@echo "Performance metrics will be written to ./latency.log"
	cd backend && DATABASE_URL=sqlite+aiosqlite:///$(PWD)/claudeworld.db PERF_LOG=true uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000

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
	@echo "   Metrics will be written to: ./latency.log"
	@echo "   Monitor with: tail -f latency.log"
	@echo ""
	@echo "Press Ctrl+C to stop all servers"
	@$(MAKE) -j2 run-backend-perf run-frontend

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
	@cd backend && uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000 &
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
	rm -rf frontend/dist
	rm -rf frontend/node_modules/.vite
	@echo "Clean complete!"

generate-hash:
	@echo "Generating password hash..."
	uv run python scripts/setup/generate_hash.py

simulate:
	@echo "Running chatroom simulation..."
	@echo "Usage: make simulate ARGS='--password \"yourpass\" --scenario \"text\" --agents \"agent1,agent2\"'"
	@if [ -z "$(ARGS)" ]; then \
		./scripts/simulation/simulate_chatroom.sh --help; \
	else \
		./scripts/simulation/simulate_chatroom.sh $(ARGS); \
	fi

test-agents:
	@echo "Testing agent capabilities..."
	@if [ -n "$(THINKING)" ]; then \
		CHECK_ANT=$(CHECK_ANT) ./scripts/testing/test_agent_questions.sh --quiet --thinking; \
	else \
		CHECK_ANT=$(CHECK_ANT) ./scripts/testing/test_agent_questions.sh --quiet; \
	fi

evaluate-agents:
	@echo "Evaluating agent authenticity..."
	@echo "Usage: make evaluate-agents ARGS='--target-agent \"프리렌\" --evaluator \"페른\" --questions 3'"
	@if [ -z "$(ARGS)" ]; then \
		./scripts/evaluation/evaluate_authenticity.sh --help; \
	else \
		./scripts/evaluation/evaluate_authenticity.sh $(ARGS); \
	fi

evaluate-agents-cross:
	@echo "Cross-evaluating agents (both directions)..."
	@echo "Usage: make evaluate-agents-cross AGENT1=\"프리렌\" AGENT2=\"페른\" QUESTIONS=7 [SLOWER=1] [PARALLEL=5] [SPEAKER=user|{character}]"
	@if [ -z "$(AGENT1)" ] || [ -z "$(AGENT2)" ]; then \
		echo "Error: Both AGENT1 and AGENT2 must be specified."; \
		echo "Example: make evaluate-agents-cross AGENT1=\"프리렌\" AGENT2=\"페른\" QUESTIONS=7"; \
		exit 1; \
	fi; \
	QUESTIONS=$${QUESTIONS:-7}; \
	PARALLEL_LIMIT=$${PARALLEL:-7}; \
	SPEAKER_ARG=""; \
	if [ -n "$(SPEAKER)" ]; then \
		SPEAKER_ARG="--speaker $(SPEAKER)"; \
	fi; \
	if [ -n "$(SLOWER)" ]; then \
		echo "Running $(AGENT1) → $(AGENT2) and $(AGENT2) → $(AGENT1) evaluations sequentially..."; \
		./scripts/evaluation/evaluate_parallel.sh --target-agent "$(AGENT2)" --evaluator "$(AGENT1)" --questions $$QUESTIONS --parallel-limit $$PARALLEL_LIMIT $$SPEAKER_ARG; \
		./scripts/evaluation/evaluate_parallel.sh --target-agent "$(AGENT1)" --evaluator "$(AGENT2)" --questions $$QUESTIONS --parallel-limit $$PARALLEL_LIMIT $$SPEAKER_ARG; \
	else \
		echo "Running $(AGENT1) → $(AGENT2) and $(AGENT2) → $(AGENT1) evaluations in parallel..."; \
		./scripts/evaluation/evaluate_parallel.sh --target-agent "$(AGENT2)" --evaluator "$(AGENT1)" --questions $$QUESTIONS --parallel-limit $$PARALLEL_LIMIT $$SPEAKER_ARG & \
		PID1=$$!; \
		./scripts/evaluation/evaluate_parallel.sh --target-agent "$(AGENT1)" --evaluator "$(AGENT2)" --questions $$QUESTIONS --parallel-limit $$PARALLEL_LIMIT $$SPEAKER_ARG & \
		PID2=$$!; \
		wait $$PID1 $$PID2; \
	fi; \
	echo "Both evaluations completed!"

load-test:
	@echo "Running network load test..."
	@echo "Usage: make load-test ARGS='--password \"yourpass\" --users 10 --rooms 2 --duration 60'"
	@if [ -z "$(ARGS)" ]; then \
		uv run python scripts/testing/load_test_network.py --help; \
	else \
		uv run python scripts/testing/load_test_network.py $(ARGS); \
	fi

build-exe:
	@echo "Building Windows executable..."
	@echo "Step 1: Building frontend..."
	cd frontend && npm run build
	@echo "Step 2: Building executable with PyInstaller..."
	uv run pyinstaller ClaudeWorld.spec --noconfirm
	@echo ""
	@echo "Build complete! Executable is in dist/ClaudeWorld.exe"
