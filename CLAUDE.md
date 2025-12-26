# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ClaudeWorld** is a turn-based text adventure (TRPG) where AI agents collaborate to create and run interactive worlds:
- **Onboarding**: Interview → World generation → Character creation
- **Gameplay**: User action → Interpretation → Resolution → Narration

**Tech Stack:**
- Backend: FastAPI + SQLAlchemy (async) + SQLite (dev) / PostgreSQL (prod)
- Frontend: React + TypeScript + Vite + Tailwind CSS
- AI Integration: Anthropic Claude Agent SDK
- Real-time Communication: HTTP Polling (2-second intervals)
- Background Processing: APScheduler for autonomous agent interactions

## Development Commands

```bash
make dev                 # Run backend (SQLite) + frontend (default, no PostgreSQL needed)
make dev-postgresql      # Run backend (PostgreSQL) + frontend (requires PostgreSQL)
make install             # Install all dependencies
make stop                # Stop all servers
make clean               # Clean build artifacts (including SQLite database)

# Backend only
cd backend && uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000  # PostgreSQL
cd backend && DATABASE_URL=sqlite+aiosqlite:///../claudeworld.db uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000  # SQLite

# Frontend only
cd frontend && npm run dev

# Testing
uv run poe test                                    # Run all tests with coverage
uv run pytest backend/tests/unit/test_auth.py     # Run single test file
uv run pytest -k "test_login"                     # Run tests matching pattern
uv run pytest -m unit                             # Run only unit tests
uv run pytest -m integration                      # Run only integration tests
uv run pytest --lf                                # Re-run failed tests only

# Linting
uv run ruff check backend/                         # Check for linting issues
uv run ruff check backend/ --fix                   # Auto-fix linting issues

# Performance profiling
make dev-perf                                      # Run with performance logging to ./latency.log

# Agent evaluation (for testing agent authenticity)
make test-agents                                   # Test agent capabilities
make evaluate-agents ARGS='--target-agent "프리렌" --evaluator "페른" --questions 3'

# Windows executable deployment
make build-exe                                     # Build standalone Windows .exe

# Load testing
make load-test ARGS='--password "pass" --users 10 --rooms 2 --duration 60'
```

## Architecture Overview

### Backend

**Directory Structure:**
```
backend/
├── main.py                # FastAPI entry point
├── models.py              # ORM models (Room, Agent, Message, World, Location, PlayerState)
├── schemas.py             # Pydantic request/response models
├── crud/                  # Database operations (pure CRUD, no business logic)
├── domain/                # Domain models and enums
├── orchestration/         # Multi-agent orchestration and tape execution
├── routers/               # REST API endpoints (auth, rooms, agents, game/)
├── sdk/                   # Claude SDK integration (manager, tools, config)
├── services/              # Business logic (agent factory, persistence, world/location/player)
└── infrastructure/        # Cache, file locking, migrations
```

**Key Features:**
- FastAPI + SQLAlchemy (async) + SQLite/PostgreSQL
- Multi-agent orchestration with Claude SDK
- Filesystem-primary config with hot-reloading
- In-memory caching (70-90% performance improvement)
- Sub-agent invocation via Claude Agent SDK native Task tool
- Chat mode for free-form NPC conversations

**For detailed backend documentation**, see [backend/README.md](backend/README.md) which includes:
- Complete API reference
- Database schema details
- Agent configuration system
- Chat orchestration logic
- Session management
- SDK integration (AgentManager, ClientPool, StreamParser)
- Debugging guides

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

Seven specialized agents collaborate in two phases: **Onboarding** (interview → world generation) and **Gameplay** (1-agent tape where Action Manager coordinates sub-agents via SDK Task tool and handles narration directly).

**See [how_it_works.md](how_it_works.md) for detailed architecture:** agent roles, turn flow diagrams, sub-agent invocation, data storage, and API endpoints.

## Agent Configuration

Agents can be configured using folder-based structure (new) or single file (legacy):

**New Format (Preferred):**
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
- Tool configurations: `backend/sdk/config/*.yaml` files
- Changes apply immediately on next agent response (hot-reloading)
- File locking prevents concurrent write conflicts
- See `backend/infrastructure/locking.py` for implementation

### Tool Configuration (YAML-Based)

Tool descriptions and debug settings are configured via YAML files in `backend/sdk/config/`:

**`tools.yaml`** - Common tool definitions (skip, memorize, recall, etc.)
- Defines base tools available to all agents
- Tool descriptions support template variables (`{agent_name}`, `{config_sections}`)
- Enable/disable tools individually
- Changes apply immediately (no restart required)

**`gameplay_tools.yaml`** - Gameplay phase tools
- Action Manager tools: `narration`, `suggest_options`, `travel`, `remove_character`, `move_character`, `inject_memory`, `change_stat`
- Sub-agent persist tools: `persist_item`, `persist_character_design`, `persist_location_design`
- Sub-agents (item_designer, character_designer, location_designer) invoked via SDK native Task tool with AgentDefinitions

**`onboarding_tools.yaml`** - Onboarding phase tools
- `complete` tool for completing onboarding
- World generation tools (stats, locations, inventory)

### Group-Specific Tool Overrides

You can override tool configurations for all agents in a group using `group_config.yaml`:

**Structure:**
```
agents/
  group_슈타게/
    ├── group_config.yaml  # Group-wide tool overrides
    └── 크리스/
        ├── in_a_nutshell.md
        └── ...
```

**Example `group_config.yaml`:**
```yaml
# Override tool responses/descriptions for all agents in this group
tools:
  recall:
    # Return memories verbatim without AI rephrasing
    response: "{memory_content}"

  skip:
    # Custom skip message for this group
    response: "This character chooses to remain silent."
```

**Features:**
- **Follows `tools.yaml` structure** - Any field from `tools.yaml` can be overridden (response, description, etc.)
- **Group-wide application** - Applies to all agents in `group_*` folder
- **Hot-reloaded** - Changes apply immediately on next agent response
- **Selective overrides** - Only override what you need, inherit the rest from global config

**Use Cases:**
- **No rephrasing for technical content** - Scientific/technical characters (e.g., Steins;Gate group) recall memories exactly as written
- **Group-specific response styles** - Different personality groups can have customized tool responses
- **Context-specific behaviors** - Anime groups can have culturally appropriate tool messages

See `agents/group_config.yaml.example` for more examples.

### Group Behavior Settings

In addition to tool overrides, `group_config.yaml` supports behavior settings that affect how agents interact:

```yaml
# group_config.yaml
interrupt_every_turn: true       # Agent responds after every message
priority: 5                      # Higher priority = responds before others
transparent: true                # Agent's responses don't trigger others to reply
can_see_system_messages: true    # Agents can see system-type messages in context
```

**Available Settings:**
- **`interrupt_every_turn`** - When `true`, agents in this group always get a turn after any message
- **`priority`** - Integer value (default: 0). Higher values mean agent responds before lower priority agents
- **`transparent`** - When `true`, other agents won't be triggered to respond after this agent speaks. Useful for utility agents whose messages shouldn't prompt NPC replies. Messages are still visible to all agents.
- **`can_see_system_messages`** - When `true`, agents in this group can see messages with `participant_type="system"` in their conversation context. By default, system messages (like "X joined the chat") are filtered out. Useful for onboarding agents that need to see system triggers.

**Example: System Agent Group**
```yaml
# agents/group_gameplay/group_config.yaml
interrupt_every_turn: false  # Controlled by TRPGTapeGenerator
priority: 5                  # Higher priority for system agents
transparent: false           # System messages trigger normal flow
```

**`guidelines_3rd.yaml`** - Role guidelines for agent behavior (in `backend/sdk/config/`)
- Defines system prompt template and behavioral guidelines
- Uses third-person perspective in agent configurations (explained below)
- Guidelines are injected via tool descriptions
- Supports situation builder notes

**`conversation_context.yaml`** - Conversation context templates (in `backend/sdk/config/`)
- Defines how conversation history is formatted
- Configures message grouping and context window

**`localization.yaml`** - Localized message templates (in `backend/sdk/config/`)
- Defines messages for different languages (en, ko)
- Supports variable substitution with `{variable_name}`
- Korean particle formatting with `{name:이가}` syntax

**Debug Logging:**
- Enable with `DEBUG_AGENTS=true` in `.env`
- Logs system prompt, tools, messages, responses

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

2. **Setup Database (Choose one):**

   **Option A: SQLite (Recommended for development)**
   ```bash
   # No setup needed! Database file created automatically.
   # Simply run: make dev
   ```

   **Option B: PostgreSQL (For production-like testing)**
   ```bash
   # Install PostgreSQL (if not already installed)
   # macOS: brew install postgresql@15
   # Ubuntu: sudo apt install postgresql

   # Create database
   createdb claudeworld

   # Or with custom credentials:
   # psql -c "CREATE DATABASE claudeworld;"

   # Run with PostgreSQL
   # make dev-postgresql
   ```

3. **Configure authentication:**
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

4. **Run development servers:**
   ```bash
   make dev
   ```

5. **Access application:**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8000
   - API Docs: http://localhost:8000/docs

   Login with the password you used to generate the hash.

## Windows Deployment

ClaudeWorld can be packaged as a standalone Windows executable for easy distribution:

```bash
make build-exe
```

This creates `dist/ClaudeWorld.exe` with:
- All backend/frontend code bundled
- First-time setup wizard
- Auto-start server and browser
- SQLite database support

**For detailed deployment instructions**, see [DEPLOYMENT.md](DEPLOYMENT.md) which covers:
- Build configuration
- Distribution packaging
- User setup experience
- Troubleshooting
- Advanced customization

## Configuration

### Backend Environment Variables (`.env`)

**Required:**
- `DATABASE_URL` - Database connection string
  - Default: `postgresql+asyncpg://postgres:postgres@localhost:5432/claudeworld`
  - SQLite: `sqlite+aiosqlite:///./claudeworld.db`
  - PostgreSQL: `postgresql+asyncpg://user:password@host:port/database`
- `API_KEY_HASH` - Bcrypt hash of your password (generate with `make generate-hash`)
- `JWT_SECRET` - Secret key for signing JWT tokens (generate with `python -c "import secrets; print(secrets.token_hex(32))"`)

**Optional:**
- `USER_NAME` - Display name for user messages in chat (default: "User")
- `DEBUG_AGENTS` - Set to "true" for verbose agent logging
- `USE_SONNET` - Set to "true" to use Sonnet model instead of Opus (default: false)
- `PRIORITY_AGENTS` - Comma-separated agent names for priority responding
- `MAX_CONCURRENT_ROOMS` - Max rooms for background scheduler (default: 5)
- `ENABLE_GUEST_LOGIN` - Enable/disable guest login (default: true)
- `FRONTEND_URL` - CORS allowed origin for production (e.g., `https://your-app.vercel.app`)
- `VERCEL_URL` - Auto-detected on Vercel deployments

**Image Processing:**
- `IMAGE_WEBP_QUALITY` - WebP compression quality 1-100 (default: 85)
- `IMAGE_CONVERT_TO_WEBP` - Convert images to WebP format (default: true)

**Claude API:**
- `CLAUDE_API_KEY` - Direct API key for production deployments (get from console.anthropic.com)
- If not set, uses Claude Code web authentication (requires active Claude Code session)
- `CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK` - Skip SDK version check (default: true)

### Database (SQLite or PostgreSQL)

ClaudeWorld supports both SQLite and PostgreSQL:

- **SQLite (default)**: File-based database at `./claudeworld.db`
  - No installation required
  - Perfect for local development
  - Use: `make dev`
  - Connection string: `sqlite+aiosqlite:///./claudeworld.db`

- **PostgreSQL**: Production-grade database
  - Requires PostgreSQL installation
  - Better for concurrent access and large datasets
  - Configure via `DATABASE_URL` in `.env`
  - Default: `postgresql+asyncpg://postgres:postgres@localhost:5432/claudeworld`
  - Use: `make dev-postgresql`
  - Setup: Create database with `createdb claudeworld` before first run

**Switching databases**: Simply use the appropriate make command. Data is not shared between databases.

**Migrations**: Automatic schema updates via `backend/infrastructure/database/migrations.py` support both database types

### CORS Configuration
- CORS is configured in `main.py` using environment variables
- Default allowed origins: `localhost:5173`, `localhost:5174`, and local network IPs
- Add custom origins via `FRONTEND_URL` or `VERCEL_URL` environment variables
- Backend logs CORS configuration on startup for visibility

## Common Tasks

### Agent Configuration

**Create agent:** Add folder in `agents/` with required `.md` files using third-person perspective (e.g., "Alice is..." not "You are..."), restart backend

**Update agent:** Edit `.md` files directly (changes apply immediately)

**Update system agent:** Edit files in `agents/group_gameplay/{agent_name}/` or `agents/group_subagent/{agent_name}/` (changes apply immediately)

**Update system prompt:** Edit `system_prompt` section in `backend/sdk/config/guidelines_3rd.yaml` (changes apply immediately)

**Update tool descriptions:** Edit YAML files in `backend/sdk/config/` (changes apply immediately)

**Update guidelines:** Edit template section in `backend/sdk/config/guidelines_3rd.yaml` (changes apply immediately)

**Enable debug logging:** Set `DEBUG_AGENTS=true` in `.env` or edit `backend/sdk/config/debug.yaml`

### Game Tools

**Add game tool:** Add tool config in `backend/sdk/config/gameplay_tools.yaml`, implement handler in `backend/sdk/tools/`

**Test game flow:** Create world via API, submit actions, poll for responses

### General Tasks

**Add database field:** Update `models.py`, add migration in `backend/infrastructure/database/migrations.py`, update `schemas.py` and `crud.py`, restart

**Add endpoint:** Define schema in `schemas.py`, add CRUD in `crud.py` or `crud/game.py`, add endpoint in `main.py` or `routers/game.py`

## Automated Simulations

ClaudeWorld includes bash scripts for running automated multi-agent simulations via curl API calls. This is useful for testing agent behaviors, creating conversation datasets, or running batch simulations.

**Quick Example:**
```bash
make simulate ARGS='--password "your_password" --scenario "Discuss the ethics of AI development" --agents "alice,bob,charlie"'
```

Or use the script directly:
```bash
./scripts/simulation/simulate_chatroom.sh \
  --password "your_password" \
  --scenario "Discuss the ethics of AI development" \
  --agents "alice,bob,charlie"
```

**Output:** Generates `chatroom_1.txt`, `chatroom_2.txt`, etc. with formatted conversation transcripts.

**Features:**
- Authenticates and creates rooms via API
- Sends scenarios as user messages
- Polls for messages and saves formatted transcripts
- Auto-detects conversation completion
- Supports custom room names, max interactions, and output files

**Scripts Location:** `scripts/simulation/` and `scripts/testing/`

**See [SIMULATIONS.md](SIMULATIONS.md) for complete guide.**

## History

ClaudeWorld evolved from ChitChats, a multi-agent chat room application where Claude AI agents with different personalities could interact in real-time.
