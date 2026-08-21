# ClaudeWorld — TypeScript backend (Phase 0 pilot)

The in-progress TypeScript/Bun port of `../backend`. See
[`../docs/ts-migration-plan.md`](../docs/ts-migration-plan.md) for the plan and the
phase status.

The Python backend on `master` is untouched and remains the one that runs. Nothing
here is wired into `make dev` yet.

## What exists

Phase 0 is complete: enough of the SDK, tool, orchestration and persistence layers
to drive **one complete gameplay turn** — NPCs at the player's location react, then
the Action Manager interprets the action and narrates — with no HTTP server.

```
src/
  config/        settings + path resolution (reads the Python tree's YAML)
  db/            Drizzle mirror of the live SQLite schema, byte-compatible
  crud/          the DB operations one turn needs
  services/      filesystem-primary world/player/location/room-mapping readers
  sdk/
    client/      persistent session, session pool, stream parser, narration extractor
    agent/       options builder, hooks, turn runner
    tools/       tool declarations (zod schemas + descriptions)
    handlers/    tool implementations and MCP server assembly
    loaders/     YAML config with mtime hot-reload
    parsing/     agent config + long-term memory
  orchestration/ tape model, executor, gameplay tape, context builders, turn
  scripts/       spike / seed / pilot / schema verification
```

## Running things

```bash
bun install
bun run typecheck
bun run lint
bun test src/tests

# Prove the SDK can do what the port needs (hits a live CLI, ~40s)
bun src/scripts/spike-session.ts

# Check the Drizzle schema against a real database
bun src/scripts/verify-schema.ts /path/to/claudeworld.db

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
