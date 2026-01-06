# Backend Architecture

## Layer Structure

```
backend/
├── main.py                 # FastAPI app entry point
├── routers/                # HTTP endpoints (thin controllers)
│   ├── game/               # Game-related endpoints
│   └── auth.py             # Authentication endpoints
├── orchestration/          # Multi-agent coordination
│   ├── orchestrator.py     # Main orchestration flow
│   ├── response_generator.py  # Agent response generation
│   └── tape/               # Turn scheduling (tape executor)
├── sdk/                    # Claude Agent SDK integration
│   ├── agent/              # AgentManager, agent_definitions
│   ├── client/             # ClientPool, StreamParser
│   ├── tools/              # MCP tool implementations
│   └── loaders/            # Config file loading
├── services/               # Business logic
├── domain/                 # Domain models, value objects, entities
├── infrastructure/         # Cross-cutting concerns
│   ├── database/           # SQLAlchemy setup, migrations
│   ├── logging/            # PerfLogger, debug logging
│   ├── auth.py             # Authentication middleware, JWT utilities
│   ├── cache.py            # In-memory caching
│   └── locking.py          # File locking
├── crud/                   # Database operations
├── core/                   # Settings, constants, logging setup
│   ├── dependencies.py     # FastAPI dependency injection
│   └── app_factory.py      # Application factory
├── tests/                  # Test suite
│   ├── conftest.py         # Pytest configuration and fixtures
│   └── testing.py          # Test utilities
└── utils/                  # General utilities
```

## Allowed Dependencies

Layers should only import from layers below them:

- `routers` -> `orchestration`, `services`, `crud`, `domain`, `schemas`, `core`, `infrastructure`
- `orchestration` -> `sdk`, `services`, `crud`, `domain`, `infrastructure`
- `sdk` -> `infrastructure`, `domain`, `core`
- `services` -> `domain`, `crud`, `infrastructure`
- `crud` -> `models`, `domain`
- `infrastructure` -> (external libs only)
- `domain` -> (no internal deps)
- `core` -> (no internal deps, except `core.dependencies` which imports from `services`, `crud`)
- `utils` -> `core`, `infrastructure`
- `tests` -> (can import from any layer)

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
