# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ClaudeWorld** is a turn-based text adventure (TRPG) where AI agents collaborate to create and run interactive worlds:
- **Onboarding**: Interview → World generation → Character creation
- **Gameplay**: User action → NPC reactions → Interpretation → Resolution → Narration

**Tech Stack:**
- Backend: FastAPI + SQLAlchemy (async) + SQLite
- Frontend: React + TypeScript + Vite + Tailwind CSS
- AI Integration: Anthropic Claude Agent SDK
- Real-time Communication: HTTP Polling (2-second intervals)
- Background Processing: APScheduler for autonomous agent interactions

## Development Commands

```bash
make dev                 # Run backend + frontend
make install             # Install all dependencies
make stop                # Stop all servers
make clean               # Clean build artifacts (including SQLite database)

# Backend only
cd backend && DATABASE_URL=sqlite+aiosqlite:///../claudeworld.db uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Frontend only
cd frontend && npm run dev

# Testing
uv run poe test                                    # Run all tests (fast, no coverage)
uv run poe test-cov                                # Run tests with coverage
uv run pytest backend/tests/unit/test_auth.py     # Run single test file
uv run pytest -k "test_login"                     # Run tests matching pattern

# Linting
uv run ruff check backend/                         # Check for linting issues
uv run ruff check backend/ --fix                   # Auto-fix linting issues

# Performance profiling
make dev-perf                                      # Run with performance logging to ./latency.log

# Agent evaluation
make test-agents                                   # Test agent capabilities
make evaluate-agents ARGS='--target-agent "프리렌" --evaluator "페른" --questions 3'

# Windows executable deployment
make build-exe                                     # Build standalone Windows .exe
```

## LSP Support

Claude Code can use the LSP tool for code intelligence (via Pyright for Python, TypeScript LSP for frontend):

- `documentSymbol` - List all classes, functions, variables in a file
- `hover` - Get type info and docstrings
- `goToDefinition` - Jump to symbol definition
- `findReferences` - Find all usages across the codebase
- `incomingCalls` / `outgoingCalls` - Analyze call hierarchy

Note: `goToImplementation` is not supported by Pyright (available only in Pylance/VS Code).

## Architecture Overview

### Backend

**Directory Structure:**
```
backend/
├── main.py                # FastAPI entry point
├── crud/                  # Database operations (pure CRUD, no business logic)
├── domain/                # Domain models, enums, and exceptions
├── orchestration/         # Multi-agent orchestration and tape execution
├── routers/               # REST API endpoints (auth, rooms, agents, game/)
├── schemas/               # Pydantic request/response models
├── sdk/                   # Claude SDK integration (manager, tools, config)
├── services/              # Business logic (agent factory, persistence, world/location/player)
└── infrastructure/        # Cross-cutting infrastructure concerns
    ├── cache.py           # In-memory caching
    ├── locking.py         # File-based locking
    ├── scheduler.py       # Background scheduler for autonomous agent rounds
    ├── database/          # Database infrastructure
    │   ├── connection.py  # Engine, session maker, Base, utilities
    │   ├── models.py      # ORM models (Room, Agent, Message, World, etc.)
    │   ├── migrations.py  # Schema migrations
    │   └── write_queue.py # SQLite write queue
    └── logging/           # Logging infrastructure
```

**Key Features:**
- FastAPI + SQLAlchemy (async) + SQLite
- Multi-agent orchestration with Claude SDK
- Filesystem-primary config with hot-reloading
- In-memory caching (70-90% performance improvement)
- Sub-agent invocation via Claude Agent SDK native Task tool
- Chat mode for free-form NPC conversations

**For detailed backend documentation**, see [backend/README.md](backend/README.md).

**For caching system details**, see [backend/CACHING.md](backend/CACHING.md).

### Frontend
- **React + TypeScript + Vite** with Tailwind CSS
- **Key components:**
  - GameApp - TRPG mode entry point
  - WorldSelector - Create/select game worlds
  - GameRoom - Main game interface with action input
  - GameStatePanel - Stats, inventory, minimap (right sidebar)
  - LocationListPanel - Location navigation (left sidebar)
  - MessageList - Display messages with thinking text
- **Real-time features:**
  - HTTP polling for live message updates (2-second intervals)
  - Typing indicators
  - Agent thinking process display

## Game System

Seven specialized agents collaborate in two phases: **Onboarding** (interview → world generation) and **Gameplay** (2-cell tape where NPCs react first, then Action Manager coordinates sub-agents via SDK Task tool and handles narration).

**Gameplay tape flow:**
1. **Cell 1 (NPC Reactions)**: NPCs at player's location react concurrently (hidden), responses collected
2. **Cell 2 (Action Manager)**: Receives NPC reactions, interprets action, invokes sub-agents, generates narration

**See [how_it_works.md](how_it_works.md) for detailed architecture:** agent roles, turn flow diagrams, sub-agent invocation, data storage, and API endpoints.

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

### Filesystem-Primary Architecture

**Agent configs**, **system prompt**, and **tool configurations** use filesystem as single source of truth:
- Agent configs: `agents/{name}/*.md` files (DB is cache only)
- System prompt: `backend/sdk/config/guidelines_3rd.yaml` (`system_prompt` field)
- Tool configurations: `backend/sdk/config/*_tool_definitions.py` files
- Changes apply immediately on next agent response (hot-reloading)
- File locking prevents concurrent write conflicts

### Tool Configuration (Python-Based)

Tool definitions are defined in Python modules in `backend/sdk/config/`:

- **`tool_definitions.py`** - Base `ToolDefinition` dataclass
- **`action_tool_definitions.py`** - Common action tools (skip, memorize, recall)
- **`guideline_tool_definitions.py`** - Guideline tools (read, anthropic)
- **`gameplay_tool_definitions.py`** - Action Manager tools (narration, suggest_options, travel, etc.)
- **`onboarding_tool_definitions.py`** - Onboarding phase tools (draft_world, persist_world, complete)
- **`subagent_tool_definitions.py`** - Sub-agent persist tools (persist_item, persist_character_design, persist_location_design)

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

See `agents/group_config.yaml.example` for more examples.

### Third-Person Perspective

Agent files use **third-person** descriptions (e.g., "프리렌은 엘프 마법사로...") because Claude Agent SDK inherits an immutable "You are Claude Code" prompt. Third-person avoids conflicting "You are..." statements.

**See [how_it_works.md](how_it_works.md#why-third-person-perspective) for technical details.**

## Quick Start

1. **Setup environment:**
   ```bash
   # Install uv (if not already installed)
   curl -LsSf https://astral.sh/uv/install.sh | sh

   # Install all dependencies
   make install
   ```

2. **Configure authentication:**
   ```bash
   # Generate password hash
   make generate-hash
   # Enter your desired password when prompted

   # Generate JWT secret
   python -c "import secrets; print(secrets.token_hex(32))"

   # Copy and configure .env in project root
   cp .env.example .env
   # Edit .env and add API_KEY_HASH and JWT_SECRET
   ```

   See [SETUP.md](SETUP.md) for detailed instructions.

3. **Run development servers:**
   ```bash
   make dev
   ```

4. **Access application:**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8000
   - API Docs: http://localhost:8000/docs

   Login with the password you used to generate the hash.

## Windows Deployment

ClaudeWorld can be packaged as a standalone Windows executable:

```bash
make build-exe
```

Creates `dist/ClaudeWorld.exe` with bundled backend/frontend, setup wizard, and SQLite database support.

**For detailed deployment instructions**, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Configuration

### Backend Environment Variables (`.env`)

**Required:**
- `API_KEY_HASH` - Bcrypt hash of your password (generate with `make generate-hash`)
- `JWT_SECRET` - Secret key for signing JWT tokens

**Optional:**
- `USER_NAME` - Display name for user messages in chat (default: "User")
- `DEBUG_AGENTS` - Set to "true" for verbose agent logging
- `USE_SONNET` - Set to "true" to use Sonnet model instead of Opus (default: false)
- `ENABLE_GUEST_LOGIN` - Enable/disable guest login (default: true)
- `IMAGE_WEBP_QUALITY` - WebP compression quality 1-100 (default: 85)
- `IMAGE_CONVERT_TO_WEBP` - Convert images to WebP format (default: true)

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

**Add game tool:** Add tool definition in `backend/sdk/config/gameplay_tool_definitions.py`, implement handler in `backend/sdk/tools/`

**Test game flow:** Create world via API, submit actions, poll for responses

### General Tasks

**Add database field:** Update `models.py`, add migration in `backend/infrastructure/database/migrations.py`, update `schemas.py` and `crud.py`, restart

**Add endpoint:** Define schema in `schemas.py`, add CRUD in `crud.py` or `crud/game.py`, add endpoint in `main.py` or `routers/game.py`

## History

ClaudeWorld evolved from ChitChats, a multi-agent chat room application where Claude AI agents with different personalities could interact in real-time.
