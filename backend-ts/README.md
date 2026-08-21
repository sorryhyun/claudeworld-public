# ClaudeWorld — TypeScript backend (Phases 0–1)

The in-progress TypeScript/Bun port of `../backend`. See
[`../docs/ts-migration-plan.md`](../docs/ts-migration-plan.md) for the plan and the
phase status.

The Python backend on `master` is untouched and still serves the whole game.

`make dev` on this branch runs **this** backend plus the frontend, so only
`/auth/*` answers — enough to log in, then 404s. `make dev-python` is the Python
backend and the playable game.

## What exists

**Phase 0** delivered enough of the SDK, tool, orchestration and persistence layers
to drive **one complete gameplay turn** — NPCs at the player's location react, then
the Action Manager interprets the action and narrates — with no HTTP server.

**Phase 1** added the foundation the rest hangs off: a Hono server that boots,
authenticates and serves; Drizzle migrations with a drift gate; and the logging,
cache and file-locking infrastructure.

```
src/
  auth/          bcrypt password verification, JWT issue/verify, roles
  config/        settings + path resolution (reads the Python tree's YAML)
  db/            Drizzle mirror of the live SQLite schema, byte-compatible,
                 plus migrations, schema introspection and the drift diff
  crud/          the DB operations one turn needs
  http/          Hono app, auth middleware, rate limiting, auth routes
  infrastructure/
    cache.ts     TTL + LRU + single-flight request cache
    locking.ts   atomic writes, appends, advisory file locks
    logging/     application logger, latency.log, agent debug log
  services/      filesystem-primary world/player/location/room-mapping readers
  sdk/
    client/      persistent session, session pool, stream parser, narration extractor
    agent/       options builder, hooks, turn runner
    tools/       tool declarations (zod schemas + descriptions)
    handlers/    tool implementations and MCP server assembly
    loaders/     YAML config with mtime hot-reload
    parsing/     agent config + long-term memory
  orchestration/ tape model, executor, gameplay tape, context builders, turn
  scripts/       spike / seed / pilot / schema verification / drift gate
drizzle/         the SQL baseline and its snapshot, both committed
```

The server currently serves `/auth/login`, `/auth/verify` and `/auth/health`. Every
other route arrives with Phases 2 and 3. `/auth/health/pool` is deliberately absent
until the session pool is owned by the app rather than by a script.

## Running things

```bash
bun install
bun run typecheck
bun run lint
bun test

# Start the server (needs API_KEY_HASH and JWT_SECRET in the project-root .env)
bun run dev

# Drift gate: build a database from the migrations alone and check it against
# src/db/schema.ts. Runs in CI.
bun run migration-check

# The same, additionally diffed against a real Python-created database.
bun run migration-check -- --against /path/to/claudeworld.db

# After editing src/db/schema.ts
bun run migration-new -- --name=<description>

# Check the Drizzle schema can read a real database
bun run verify-schema /path/to/claudeworld.db

# Prove the SDK can do what the port needs (hits a live CLI, ~40s)
bun src/scripts/spike-session.ts

# The Phase 0 exit criteria: two full gameplay turns (hits a live CLI, ~2min)
bun src/scripts/seed-pilot.ts /tmp/cw-pilot /path/to/claudeworld.db
bun src/scripts/pilot-turn.ts /tmp/cw-pilot/pilot-manifest.json
```

`seed-pilot` builds a throwaway root under the scratch directory: `agents/` and
`backend/` are symlinked to this repo so agent configs and guidelines resolve exactly
as in production, while the world data and database are fresh copies. It never writes
to the repository.

## Things worth knowing before editing

- **`query()` with an async-iterable prompt is the persistent session.** Never call
  `Query.streamInput()` (it ends the CLI's stdin), never `for await` with a `break`
  (it tears the generator down), and keep the background pump — sub-agents call MCP
  tools after the parent turn's `result`.
- **Datetimes are text, not integers.** SQLAlchemy's SQLite format is part of the
  parity contract; see `src/db/columns.ts`.
- **`env` replaces the subprocess environment, it does not merge.** Everything goes
  through `src/sdk/client/env.ts`, which also strips the parent harness's auth
  variables so this works when launched from inside Claude Code.
- **Options are built in exactly one place** (`src/sdk/agent/options-builder.ts`).
  Python's snake_case names camelCase differently enough that an inline options
  object drops fields silently.
- **Alembic's history is not replayed; databases are adopted.** An existing
  `claudeworld.db` is verified against `schema.ts` and then stamped, never migrated
  — nothing here writes DDL to a populated database. A fresh install goes the other
  way and stamps `alembic_version` with the Alembic head, so the database it creates
  still opens in the Python backend. Both directions are covered by
  `src/tests/migrate.test.ts`.
- **`.default()` on a Drizzle column emits DDL; SQLAlchemy's `default=` does not.**
  Only `rooms.is_paused`, `rooms.is_finished` and `messages.timestamp` have real
  server defaults. Everything else uses `$defaultFn`, which fills the value into the
  INSERT the way the ORM does without adding a `DEFAULT` clause no existing database
  has. `bun run migration-check --against <db>` is what catches getting this wrong.
- **Auth functions take a config object, not the environment.** `resolveAuthConfig()`
  does the env-over-`.env` layering once, so the rest of `src/auth/` is pure and
  testable without `monkeypatch.setenv` equivalents.
