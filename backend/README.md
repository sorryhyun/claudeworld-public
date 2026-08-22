# ClaudeWorld — backend

The ClaudeWorld server. Bun + Hono + Drizzle ORM over `bun:sqlite`, with the game driven
through the Claude Agent SDK and game tools served over a stateless MCP endpoint.

This is the only backend. It replaced a Python/FastAPI implementation, which was deleted
once the port reached parity — comments across `src/` still cite Python filenames as the
source of a port, and those files no longer exist.

For working on this code, read [`CLAUDE.md`](CLAUDE.md): layout, the SDK layer's
load-bearing details, the chat-room scheduler, database rules, and how to add tools and
endpoints.

## Layout

```
sdk/config/                Prompt YAML (hot-reloaded data, not code)
infrastructure/logging/    debug.yaml
src/
  main.ts                  Entrypoint: logging → config checks → DB → listen
  auth/                    bcrypt password verification, JWT issue/verify, roles
  config/                  settings (env) + project-root/path resolution
  crud/                    Database operations, no business logic
  db/                      Drizzle schema, migrations, introspection, drift diff
  domain/                  Enums, errors, player rules, serializers, slash commands
  http/                    Hono app, middleware, routes/, state.ts
  infrastructure/          cache, locking, background, scheduler, SSE, logging
  lib/                     Async queue, Korean particles, WebP compression
  orchestration/           Room orchestrator, turn, context builders, tape/
  schemas/                 Zod request/response models
  sdk/                     Claude Agent SDK integration
  services/                Filesystem-primary world/player/location services
  scripts/                 pilot · spike · smoke · seed · setup-env · schema tools
  tests/                   bun test suites + fixtures
drizzle/                   Committed SQL baseline and snapshot
```

## Running things

```bash
# Dependencies install from the repo root -- it is a Bun workspace over this
# package (`@claudeworld/backend`) and `../frontend`, with one shared lockfile.
cd .. && bun install && cd backend

bun run typecheck
bun run lint
bun run test                      # 1589 tests, ~3.8s

# Start the server (needs API_KEY_HASH and JWT_SECRET in the project-root .env;
# `make setup` from the repo root writes them)
bun run dev

# Boot the assembled app against a throwaway database and hit the real routes
bun run smoke

# Drift gate: build a database from the migrations alone and check it against
# src/db/schema.ts. Runs in CI.
bun run migration-check
bun run migration-check -- --against /path/to/claudeworld.db
bun run verify-schema /path/to/claudeworld.db

# After editing src/db/schema.ts
bun run migration-new -- --name=<description>

# Prove the SDK can still do what this backend needs (live CLI, real tokens, ~40s).
# Run it on every SDK version bump -- it is the only place CLI behaviour is
# asserted against a real subprocess.
bun run spike

# Three real gameplay turns with no HTTP (live CLI, ~2min)
bun src/scripts/seed-pilot.ts /tmp/cw-pilot /path/to/claudeworld.db
bun src/scripts/pilot-turn.ts /tmp/cw-pilot/pilot-manifest.json
```

`seed-pilot` builds a throwaway root under the scratch directory: `agents/` and `backend/`
are symlinked to this repo so agent configs and guidelines resolve exactly as in production,
while the world data and database are fresh copies. It never writes to the repository.
