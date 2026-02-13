# Backend Architecture

## Directory Structure

```
backend/
├── main.py                    # FastAPI app entry point
├── launcher.py                # Windows .exe launcher (PyInstaller)
│
├── core/                      # App configuration and bootstrap
│   ├── app_factory.py         # Application factory (lifespan, middleware)
│   ├── dependencies.py        # FastAPI dependency injection
│   ├── logging.py             # Logging configuration
│   └── settings.py            # Pydantic settings (env vars)
│
├── routers/                   # HTTP endpoints (thin controllers)
│   ├── auth.py                # Login, JWT verification
│   ├── agents.py              # Agent listing, profile pictures
│   ├── agent_management.py    # Agent CRUD management
│   ├── rooms.py               # Room listing, creation, deletion
│   ├── room_agents.py         # Room-agent associations
│   ├── messages.py            # Message send, poll, clear
│   ├── sse.py                 # SSE streaming endpoint
│   ├── debug.py               # Debug endpoints
│   ├── mcp_tools.py           # MCP tool listing endpoint
│   ├── readme.py              # Serve README as HTML
│   └── game/                  # TRPG game endpoints
│       ├── actions.py         # Submit player action
│       ├── chat_mode.py       # Start/end chat mode
│       ├── locations.py       # Location listing, travel, labels
│       ├── polling.py         # Poll for game updates
│       ├── state.py           # Player state, stats, inventory
│       └── worlds.py          # World CRUD, listing
│
├── orchestration/             # Multi-agent coordination
│   ├── orchestrator.py        # ChatOrchestrator (base tape runner)
│   ├── trpg_orchestrator.py   # TRPGOrchestrator (game-specific flow)
│   ├── response_generator.py  # Agent response generation loop
│   ├── context.py             # OrchestrationContext dataclass
│   ├── gameplay_context.py    # GameplayContext (world/player state)
│   ├── agent_ordering.py      # Agent ordering logic for tape cells
│   ├── chat_mode_orchestrator.py  # Chat mode conversation handling
│   ├── whiteboard.py          # Shared state between tape cells
│   └── tape/                  # Turn scheduling
│       ├── models.py          # TapeCell, AgentSchedule dataclasses
│       ├── generator.py       # Base tape generator
│       ├── trpg_generator.py  # TRPG 2-cell tape (NPC reactions + Action Manager)
│       └── executor.py        # Sequential tape cell executor
│
├── sdk/                       # Claude Agent SDK integration
│   ├── agent/                 # High-level agent orchestration
│   │   ├── agent_manager.py   # Response generation, client lifecycle
│   │   ├── hooks.py           # SDK hook factories (prompt, subagent, tool capture)
│   │   ├── options_builder.py # ClaudeAgentOptions builder
│   │   ├── streaming_state.py # Thread-safe partial response tracking
│   │   └── task_subagent_definitions.py  # AgentDefinition builders for sub-agents
│   ├── client/                # Claude SDK client infrastructure
│   │   ├── client_pool.py     # Client pooling with config hash tracking
│   │   ├── mcp_registry.py    # MCP server registry (tool routing per agent)
│   │   ├── stream_parser.py   # Response stream parsing
│   │   └── transports.py      # Custom transport implementations
│   ├── config/                # Tool definitions and system prompt
│   │   ├── tool_definitions.py              # Base ToolDefinition dataclass
│   │   ├── action_tool_definitions.py       # skip, memorize, recall
│   │   ├── guideline_tool_definitions.py    # guidelines reader
│   │   ├── gameplay_tool_definitions.py     # narration, suggest_options, travel, etc.
│   │   ├── onboarding_tool_definitions.py   # draft_world, persist_world, complete
│   │   ├── subagent_tool_definitions.py     # Shared sub-agent persist tools
│   │   ├── character_design_tool_definitions.py  # Character creation tools
│   │   ├── item_tool_definitions.py         # Item persist tool
│   │   ├── location_tool_definitions.py     # Location persist tool
│   │   ├── guidelines_3rd.yaml              # System prompt template
│   │   ├── conversation_context.yaml        # Context formatting
│   │   └── localization.yaml                # Localized messages (en, ko)
│   ├── loaders/               # Configuration loaders
│   │   ├── tools.py           # Tool config loading with group overrides
│   │   ├── guidelines.py      # System prompt loading
│   │   ├── yaml_loaders.py    # YAML parsing utilities
│   │   ├── cache.py           # Loader caching
│   │   └── validation.py      # Config validation
│   ├── parsing/               # Parsing utilities
│   │   ├── agent_parser.py    # Parse agent config from markdown files
│   │   └── memory_parser.py   # Parse long-term memory files
│   └── tools/                 # MCP tool implementations
│       ├── servers.py         # MCP server factories
│       ├── context.py         # ToolContext for tool handlers
│       ├── common.py          # Shared tool utilities
│       ├── action_tools.py    # skip, memorize, recall
│       ├── guidelines_tools.py    # guidelines reader
│       ├── narrative_tools.py     # narration, suggest_options
│       ├── location_tools.py      # travel, list_locations, persist_location_design
│       ├── character_tools.py     # remove_character, move_character, list_characters
│       ├── character_design_tools.py  # Comprehensive character creation
│       ├── mechanics_tools.py     # inject_memory, change_stat
│       ├── item_tools.py          # persist_item
│       ├── equipment_tools.py     # Equipment handling
│       ├── history_tools.py       # History compression
│       └── onboarding_tools.py    # draft_world, persist_world, complete
│
├── services/                  # Business logic
│   ├── agent_factory.py       # Orchestrates config loading → prompt building → CRUD
│   ├── agent_service.py       # Agent lifecycle management
│   ├── agent_config_service.py    # Agent config reading/writing
│   ├── agent_filesystem_service.py # Agent filesystem operations
│   ├── persistence_manager.py # Initialization (FS→DB) and export (DB→FS)
│   ├── prompt_builder.py      # System prompt assembly
│   ├── world_service.py       # World filesystem storage
│   ├── world_reset_service.py # World reset operations
│   ├── location_service.py    # Location management
│   ├── location_storage.py    # Location filesystem storage
│   ├── player_service.py      # Player state management
│   ├── item_service.py        # Item template management
│   ├── room_mapping_service.py    # Room-location mapping
│   ├── cache_service.py       # Cache warming and invalidation
│   ├── catalog_service.py     # World catalog management
│   ├── history_compression_service.py  # Turn history compression
│   ├── transient_state_service.py  # Transient runtime state
│   └── facades/               # FS↔DB sync facades
│       ├── player_facade.py   # Player state sync (filesystem ↔ database)
│       └── world_facade.py    # World state sync (filesystem ↔ database)
│
├── domain/                    # Domain models (no internal dependencies)
│   ├── exceptions.py          # Domain-specific exceptions
│   ├── entities/              # Core domain entities
│   │   ├── agent.py           # Agent entity
│   │   ├── agent_config.py    # AgentConfig value object
│   │   ├── gameplay_models.py # Gameplay-related models
│   │   └── world_models.py    # World, Location, PlayerState models
│   ├── services/              # Domain services (pure logic, no I/O)
│   │   ├── access_control.py  # Ownership/permission checks
│   │   ├── item_validation.py # Item constraint validation
│   │   ├── localization.py    # Language-aware formatting
│   │   ├── memory.py          # Memory parsing/formatting
│   │   ├── player_rules.py    # Stat clamping, inventory rules
│   │   └── player_state_serializer.py  # State serialization
│   └── value_objects/         # Immutable value types
│       ├── enums.py           # WorldPhase, AgentGroup, etc.
│       ├── contexts.py        # AgentContext, GameContext
│       ├── action_models.py   # StatChange, ItemChange
│       ├── slash_commands.py  # Slash command parsing
│       └── task_identifier.py # TaskIdentifier for client pooling
│
├── crud/                      # Database operations (pure CRUD, no business logic)
│   ├── agents.py              # Agent CRUD
│   ├── rooms.py               # Room CRUD
│   ├── room_agents.py         # Room-agent association CRUD
│   ├── messages.py            # Message CRUD
│   ├── worlds.py              # World CRUD
│   ├── locations.py           # Location CRUD
│   ├── player_state.py        # PlayerState CRUD
│   ├── cached.py              # Cache-backed CRUD operations
│   └── helpers.py             # Shared CRUD helpers
│
├── infrastructure/            # Cross-cutting concerns
│   ├── auth.py                # JWT authentication, middleware
│   ├── cache.py               # In-memory caching (TTL-based)
│   ├── locking.py             # File-based locking
│   ├── scheduler.py           # APScheduler for background tasks
│   ├── sse.py                 # Server-Sent Events infrastructure
│   ├── sse_ticket.py          # SSE ticket-based authentication
│   ├── database/              # Database infrastructure
│   │   ├── connection.py      # Engine, session maker, Base
│   │   ├── models.py          # ORM models (Room, Agent, Message, World, etc.)
│   │   ├── migrations.py      # Automatic schema migrations
│   │   └── write_queue.py     # Single-writer SQLite queue
│   └── logging/               # Logging infrastructure
│       ├── agent_logger.py    # Agent debug logger
│       ├── formatters.py      # Log formatters
│       └── perf_logger.py     # Performance timing logger
│
├── schemas/                   # Pydantic request/response models
│   ├── agents.py              # Agent schemas
│   ├── rooms.py               # Room schemas
│   ├── messages.py            # Message schemas
│   ├── game.py                # Game-specific schemas
│   └── common.py              # Shared schema types
│
├── i18n/                      # Internationalization
│   ├── korean.py              # Korean particle handling
│   ├── serializers.py         # Localized serializers
│   └── timezone.py            # Timezone utilities
│
├── utils/                     # General utilities
│   ├── helpers.py             # Misc helpers
│   └── images.py              # Image processing (WebP conversion)
│
└── tests/                     # Test suite
    ├── conftest.py            # Pytest configuration and fixtures
    ├── testing.py             # Test utilities
    ├── fixtures/              # Shared test fixtures
    ├── unit/                  # Unit tests
    └── integration/           # Integration tests
```

## Layer Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         Routers (API Layer)                       │
│  auth, agents, rooms, messages, sse, game/{actions,locations,..} │
└────────────────────┬────────────────────┬────────────────────────┘
                     │                    │
        ┌────────────▼──────────┐  ┌──────▼──────────────────────┐
        │     Orchestration     │  │        Services              │
        │  orchestrator,        │  │  agent_factory, world_svc,   │
        │  trpg_orchestrator,   │  │  player_svc, persistence,   │
        │  tape executor        │  │  facades/{player, world}     │
        └────────────┬──────────┘  └──────┬──────────────────────┘
                     │                    │
              ┌──────▼──────────┐         │
              │      SDK        │         │
              │  agent_manager, │         │
              │  client_pool,   │         │
              │  mcp_registry,  │         │
              │  tools/*        │         │
              └──────┬──────────┘         │
                     │                    │
        ┌────────────▼────────────────────▼─────────────────────┐
        │                   CRUD Layer                          │
        │  agents, rooms, messages, worlds, locations,          │
        │  player_state, cached                                 │
        └────────────────────────┬──────────────────────────────┘
                                 │
        ┌────────────────────────▼──────────────────────────────┐
        │               Infrastructure                          │
        │  database/{connection, models, migrations, write_queue}│
        │  auth, cache, locking, scheduler, sse, sse_ticket     │
        └───────────────────────────────────────────────────────┘
                                 │
        ┌────────────────────────▼──────────────────────────────┐
        │                  Domain Layer                         │
        │  entities/ (agent, world_models, gameplay_models)     │
        │  services/ (access_control, player_rules, memory)     │
        │  value_objects/ (enums, contexts, task_identifier)     │
        │  exceptions                                           │
        └───────────────────────────────────────────────────────┘
```

## Allowed Dependencies

Layers should only import from layers below them:

- `routers` → `orchestration`, `services`, `crud`, `domain`, `schemas`, `core`, `infrastructure`
- `orchestration` → `sdk`, `services`, `crud`, `domain`, `infrastructure`
- `sdk` → `infrastructure`, `domain`, `core`
- `services` → `domain`, `crud`, `infrastructure`
- `services/facades` → `services`, `crud`, `domain`, `infrastructure`
- `crud` → `infrastructure/database/models`, `domain`
- `infrastructure` → (external libs only)
- `domain` → (no internal deps)
- `core` → (no internal deps, except `core.dependencies` which imports from `services`, `crud`)
- `utils` → `core`, `infrastructure`
- `schemas` → `domain`
- `tests` → (can import from any layer)

## Architectural Patterns

### Filesystem-Primary with FS↔DB Sync

The filesystem is the source of truth; the database is a cache for fast queries:
- **Agent configs**: `agents/{name}/*.md` files → synced to `Agent` DB model on startup
- **World data**: `worlds/{name}/` directory → synced to `World`, `Location`, `PlayerState` models
- **Facades** (`services/facades/`): Coordinate reads/writes between filesystem and database
- **Hot-reloading**: Config changes apply immediately on next agent response

### Single-Writer SQLite Pattern

SQLite doesn't support concurrent writes. The `write_queue` module serializes all writes:
- All DB writes go through `infrastructure/database/write_queue.py`
- Reads happen directly via async sessions
- Ensures no `database is locked` errors under concurrent agent processing

### Tape-Based Turn Scheduling

TRPG turns use a 2-cell tape:
- **Cell 1** (NPC Reactions): All NPCs at player's location react concurrently (hidden)
- **Cell 2** (Action Manager): Receives reactions, coordinates sub-agents, generates narration
- `tape/models.py` defines `TapeCell` and `AgentSchedule`
- `tape/trpg_generator.py` builds the tape; `tape/executor.py` runs it

### Domain-Driven Design

The `domain/` layer is split into three sublayers:
- **`entities/`**: Core business objects (Agent, World, PlayerState)
- **`services/`**: Pure domain logic (validation, rules, formatting)—no I/O
- **`value_objects/`**: Immutable types (enums, contexts, identifiers)

### Client Pooling with Config Hash Tracking

`sdk/client/client_pool.py` pools Claude SDK clients keyed by `TaskIdentifier`:
- Clients are reused when agent config hasn't changed
- Config hash tracks agent prompt/tool changes; stale clients are replaced
- Prevents unnecessary client creation during rapid turn processing

### SSE + Ticket Auth for Real-Time Streaming

`infrastructure/sse.py` and `infrastructure/sse_ticket.py` enable server-sent events:
- SSE endpoint at `/sse` for real-time message streaming
- Ticket-based auth (short-lived tokens) since SSE can't send custom headers
- Falls back to HTTP polling (2-second intervals) when SSE is unavailable

## Logger Naming Convention

Use module-level `__name__` pattern for consistent logger hierarchy:

```python
import logging

logger = logging.getLogger(__name__)
```

This ensures logger names match Python module paths (e.g., `orchestration.response_generator`),
making it easy to configure log levels per module and trace log sources.

## Performance Logging

Use `PerfLogger` from `infrastructure.logging.perf_logger` for timing instrumentation:

```python
from infrastructure.logging.perf_logger import get_perf_logger

perf = get_perf_logger()

# Async context manager (preferred for wrapping async operations)
async with perf.track("phase_name", agent_name="...", room_id=123):
    await some_operation()

# Sync logging (when you've measured duration yourself)
start = time.perf_counter()
result = some_sync_operation()
duration_ms = (time.perf_counter() - start) * 1000
perf.log_sync("phase_name", duration_ms, agent_name="...", room_id=123, **extra_metadata)

# Async logging (when you've measured duration yourself in async context)
await perf.log_async("phase_name", duration_ms, agent_name="...", room_id=123, **extra_metadata)
```

Enable with `PERF_LOG=true` environment variable. Output: `latency.log` in project root.

## Debug Logging

Enable agent debug logging via `DEBUG_AGENTS=true` environment variable.

Debug logs include:
- System prompts
- Tool configurations
- Messages sent to agents
- Agent responses
