# Backend Documentation

ClaudeWorld backend: FastAPI application with SQLAlchemy (async) + SQLite/PostgreSQL for TRPG game orchestration using the Anthropic Claude Agent SDK.

## Quick Start

```bash
# From project root
make install  # Install dependencies with uv
make dev      # Run both backend and frontend

# Backend only
cd backend && uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Run tests
uv run pytest --cov=backend --cov-report=term-missing
```

See [../SETUP.md](../SETUP.md) for authentication setup.

## Architecture Overview

**Core Stack:**
- FastAPI + SQLAlchemy (async) + PostgreSQL (asyncpg)
- Claude Agent SDK for AI interactions
- HTTP polling for real-time updates

**Key Features:**
- Turn-based TRPG with sequential agent execution
- Filesystem-primary configuration with hot-reloading
- World/Location/PlayerState management
- In-memory caching (70-90% performance improvement)

**For caching details**, see [CACHING.md](CACHING.md).

## Directory Structure

```
backend/
├── main.py                # FastAPI entry point
├── database.py            # SQLAlchemy async setup
├── models.py              # ORM models (Room, Agent, Message, World, Location, PlayerState)
├── schemas.py             # Pydantic request/response models
├── auth.py                # JWT authentication
│
├── core/                  # App factory, settings, logging
├── crud/                  # Database operations (pure CRUD, no business logic)
├── domain/                # Domain models and enums
├── infrastructure/        # Cache, file locking, migrations
├── orchestration/         # Multi-agent orchestration and tape execution
├── routers/               # REST API endpoints (auth, rooms, agents, game/)
├── sdk/                   # Claude SDK integration (see sdk/README.md)
├── services/              # Business logic (agent factory, persistence, world/location/player)
├── i18n/                  # Internationalization
├── utils/                 # Utilities
└── tests/                 # Test suite
```

## Core Components

### Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        API Layer                             │
│  routers/agents.py, routers/game/locations.py, etc.         │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────────┐  ┌───────────────────┐
│ AgentFactory  │  │ActionManagerTools │  │PersistenceManager │
│ (orchestrator)│  │ (gameplay tools)  │  │ (init + export)   │
└───────┬───────┘  └────────┬──────────┘  └────────┬──────────┘
        │                   │                      │
        ▼                   ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│                       crud/ Layer                            │
│  agents.py, game.py, rooms.py, messages.py (pure DB ops)    │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Database   │
                    └─────────────┘
```

**Key Design Principles:**

- **`crud/`**: Pure database operations only (no business logic, no file I/O)
- **`AgentFactory`**: Orchestrates config loading → prompt building → CRUD
- **`ActionManagerTools`**: Gameplay tools for sub-agent invocation and state changes
- **`PersistenceManager`**: Initialization (FS→DB) and export (DB→FS) only

### 1. FastAPI Application (`main.py`)

**Middleware:**
- JWT authentication via `X-API-Key` header
- Rate limiting: login 20/min, polling 60-120/min, send 30/min
- Dynamic CORS from env vars (`FRONTEND_URL`, `VERCEL_URL`)

**Startup:**
- Auto-seeds agents from `agents/` directory
- Registers game router for TRPG endpoints

### 2. Database Layer

**Database:** SQLite (default) or PostgreSQL with asyncpg, async sessions, connection pooling

**Automatic Migrations:** Schema changes handled automatically via `infrastructure/database/migrations.py`

**Models (`models.py`):**
- `Room`: Chat rooms with agent associations, world linkage
- `Agent`: AI personalities with filesystem-primary config
- `Message`: Chat messages with thinking text, image support
- `World`: Game worlds with phase (onboarding/active), genre, language
- `Location`: Places in worlds with room associations, position for map
- `PlayerState`: Stats, inventory, current location, turn count, chat mode state
- `RoomAgentSession`: Agent session tracking per room

### 3. Game Router (`routers/game/`)

TRPG-specific endpoints under `/api/worlds` (modular structure):

```
POST   /worlds                         # Create new world
GET    /worlds                         # List user's worlds
GET    /worlds/{id}                    # Get world details
DELETE /worlds/{id}                    # Delete world

POST   /worlds/{id}/action             # Submit player action
GET    /worlds/{id}/action/suggestions # Get Action Manager's suggestions

GET    /worlds/{id}/locations          # List discovered locations
GET    /worlds/{id}/locations/current  # Get current location
POST   /worlds/{id}/locations/{loc}/travel  # Travel to location
PATCH  /worlds/{id}/locations/{loc}    # Update location label
GET    /worlds/{id}/locations/{loc}/messages  # Get location messages

GET    /worlds/{id}/state              # Get player state
GET    /worlds/{id}/state/stats        # Get stats with definitions
GET    /worlds/{id}/state/inventory    # Get inventory

# Chat Mode (free-form NPC conversations)
POST   /worlds/{id}/chat-mode/start    # Start chat mode with NPC
POST   /worlds/{id}/chat-mode/end      # End chat mode
GET    /worlds/{id}/chat-mode/status   # Get chat mode status

GET    /worlds/{id}/poll               # Poll for updates
```

### 4. World Service (`services/world_service.py`)

Manages filesystem storage for worlds:

```
worlds/
  {user_id}/
    {world_name}/
      ├── lore.md              # World lore and background
      └── player_state.yaml    # Player state snapshot
```

### 5. TRPG Orchestration

**Turn Flow (1-Agent Tape):**
```
User Action → Action_Manager (hidden) → narration + suggest_options
                    │
                    ├── Task(stat_calculator) → persist_stat_changes
                    ├── Task(character_designer) → persist_character_design
                    └── Task(location_designer) → persist_location_design
```

**TRPGTapeGenerator (`orchestration/tape/trpg_generator.py`):**
- Generates single-agent tape (Action_Manager, hidden from frontend)
- Onboarding round: Onboarding_Manager → World_Seed_Generator (via Task tool)
- Action round: Action_Manager invokes sub-agents via Task tool, outputs via `narration`/`suggest_options`

**ChatOrchestrator:**
- Executes tapes with strict sequential ordering
- Handles world phase transitions (onboarding → active)
- Supports agent skipping via `skip` tool

### 6. Claude SDK Integration (`sdk/`)

**AgentManager (`sdk/agent/agent_manager.py`):**
- Client management via ClientPool with TaskIdentifier keys
- Response generation with stream parsing
- Model: `claude-opus-4-5-20251101` (or Haiku with `USE_HAIKU=true`)

**MCP Tools:**
- **Action Tools:** `skip`, `memorize`, `recall`
- **Config Tools:** `guidelines`
- **Onboarding Tools:** `complete` (triggers World_Seed_Generator via Task tool)
- **Gameplay Tools:** `narration`, `suggest_options`, `travel`, `remove_character`, `move_character`, `inject_memory`
- **Persist Tools (sub-agents):** `persist_stat_changes`, `persist_character_design`, `persist_location_design`

## API Endpoints

### Authentication
```
POST   /auth/login                 # Login with password, returns JWT
GET    /auth/verify                # Verify JWT token
GET    /health                     # Health check (no auth)
```

### Game (TRPG)
```
POST   /api/worlds                 # Create world
GET    /api/worlds                 # List worlds
GET    /api/worlds/{id}            # Get world
DELETE /api/worlds/{id}            # Delete world
POST   /api/worlds/{id}/action     # Submit action
GET    /api/worlds/{id}/poll       # Poll for updates
GET    /api/worlds/{id}/state      # Get player state
GET    /api/worlds/{id}/locations  # List locations
POST   /api/worlds/{id}/locations/{loc}/travel  # Travel
```

### Rooms
```
GET    /rooms                      # List all rooms
POST   /rooms                      # Create room
GET    /rooms/{id}                 # Get room with agents and messages
DELETE /rooms/{id}                 # Delete room
POST   /rooms/{id}/mark-read       # Mark room as read
PATCH  /rooms/{id}/pause           # Toggle room pause
```

### Agents
```
GET    /agents                     # List all agents
GET    /agents/{id}                # Get agent
GET    /agents/{name}/profile-pic  # Serve profile picture
```

### Messages
```
POST   /rooms/{id}/messages        # Send message
GET    /rooms/{id}/poll            # Poll for new messages
DELETE /rooms/{id}/messages        # Clear room messages
```

## Configuration

### Environment Variables (`.env`)

**Required:**
- `API_KEY_HASH` - Bcrypt hash of admin password
- `JWT_SECRET` - Secret for JWT signing

**Optional:**
- `DATABASE_URL` - Database connection (default: PostgreSQL; `make dev` uses SQLite at project root)
- `CLAUDE_API_KEY` - Direct API key for production (uses Claude Code auth if not set)
- `USER_NAME` - Display name for user messages (default: "User")
- `DEBUG_AGENTS` - "true" for verbose logging
- `RECALL_MEMORY_FILE` - Memory file: `consolidated_memory` (default) or `long_term_memory`
- `USE_HAIKU` - "true" to use Haiku model instead of Opus
- `FRONTEND_URL` - CORS allowed origin
- `ENABLE_GUEST_LOGIN` - "true"/"false" (default: true)
- `SAMPLE_SYSTEM_PROMPT` - "true" to use sampled system prompts (experimental)

### Database

**Connection:** Configure via `DATABASE_URL` environment variable

**Formats:**
- SQLite: `sqlite+aiosqlite:///../claudeworld.db` (relative to backend/)
- PostgreSQL: `postgresql+asyncpg://user:password@host:port/database`

**Complete Reset:**
- SQLite: Delete `claudeworld.db` file and restart
- PostgreSQL: `dropdb claudeworld && createdb claudeworld`, restart backend
- Agents re-seeded from `agents/` directory on startup

## Development Patterns

### Adding Game Features

**Add game tool:**
1. Define tool in `sdk/tools/gameplay_tools/`
2. Add config to `sdk/config/gameplay_tools.yaml`
3. Register in MCP registry (`sdk/mcp_registry.py`)

**Add game state field:**
1. Update `models.py` (World, Location, or PlayerState)
2. Add migration in `infrastructure/database/migrations.py`
3. Update `schemas.py` and `crud/game.py`
4. Restart

**Add TRPG endpoint:**
1. Define schema in `schemas.py`
2. Add CRUD to `crud/game.py`
3. Add endpoint to `routers/game.py`

### Architecture Patterns

**Filesystem-Primary:**
- Agent configs, YAML settings loaded from filesystem
- World lore stored in `worlds/` directory
- Hot-reloading: changes apply immediately

**1-Agent Tape Execution:**
- TRPG uses single hidden agent (Action_Manager) with Task-based sub-agents
- Action Manager outputs via `narration` and `suggest_options` tools
- Sub-agents persist results directly via MCP tools

## Debugging

### Debug Logging

**Enable:** `DEBUG_AGENTS=true` in `.env`

**Output Includes:**
- System prompt, tools, messages, responses
- Session IDs, tool calls
- Turn execution sequence

### Common Issues

**Agent not responding:**
- Check if agent used `skip` tool
- Verify TRPG tape is executing correctly
- Check world phase (onboarding vs active)

**World not creating:**
- Check filesystem permissions for `worlds/` directory
- Verify World_Seed_Generator completed onboarding

**Stats not updating:**
- Verify Action_Manager called Task(stat_calculator)
- Check if persist_stat_changes tool was called in debug output

## Dependencies

**Package Manager:** uv (Python 3.11+)

**Core:** FastAPI, uvicorn, SQLAlchemy, asyncpg

**AI:** claude-agent-sdk

**Security:** bcrypt, PyJWT, slowapi

**Utils:** python-dotenv, pydantic, ruamel.yaml

---
