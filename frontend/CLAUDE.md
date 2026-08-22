# frontend/CLAUDE.md

The ClaudeWorld React app. React 19 + TypeScript + Tailwind CSS 4, bundled by Bun's own
bundler — there is no Vite.

Repo-wide context — dev commands, single-port serving, env vars — is in the root
[`CLAUDE.md`](../CLAUDE.md).

## Layout

```
frontend/
├── build.ts               Production build (Bun.build) → dist/
├── index.html             Entry; `make dev` imports this and hands it to Bun.serve
├── bunfig.toml            (repo root and backend/ carry the load-bearing copies)
└── src/
    ├── main.tsx           React root
    ├── App.tsx            Router / mode switch
    ├── index.css          Tailwind entry — the @source line matters, see below
    ├── components/
    │   ├── game/          TRPG mode: GameApp, GameRoom, GameSidebar,
    │   │                  GameStatePanel, LocationListPanel, Minimap,
    │   │                  InventoryList, StatsDisplay, ActionInput,
    │   │                  SuggestedActions, TurnIndicator, WorldListPanel, …
    │   ├── onboarding/    OnboardingPage, OnboardingChat, WorldReadyBanner
    │   ├── chat-room/     ChatRoom, ChatHeader, MessageInput, message-list/
    │   ├── sidebar/       MainSidebar, RoomListPanel, AgentListPanel, forms
    │   ├── shared/  ui/   Radix-based primitives and shared pieces
    │   └── Login · LandingPage · AgentManager · AgentProfileModal · ErrorBoundary
    ├── contexts/          Auth, Session, Worlds, Game, Room, Agent, Toast
    ├── hooks/             useSSE, usePolling, useAgents, useRooms, useMention, …
    ├── services/          apiClient + agent/game/message/room services
    ├── i18n/              i18next setup and locales
    └── test/setup.ts      happy-dom registration — see Testing
```

## Commands

```bash
bun run build        # Bun.build → dist/   (root `bun run build` calls this)
bun run typecheck    # tsc --noEmit
bun run lint         # eslint .
bun run test         # bun test src --parallel
bun run test:watch
```

There is no `bun run dev` here. The app is served by the backend in both modes —
`make dev` bundles this directory in-process with HMR, `make serve` serves `dist/`.

## Real-time

- `useSSE` streams agent thinking/response deltas; `usePolling` layers message polling on
  top (5s, or 30s as a safety net while SSE is connected)
- Typing indicators and agent thinking display
- SSE connects with a short-lived ticket, not the JWT — `EventSource` cannot send a header.
  The client POSTs for a 60-second single-use ticket bound to one room.

## API client

`src/services/apiClient.ts` issues **relative** URLs (`/worlds/...`). The backend serves
this app and the API from one origin, so the app never needs to know a host and CORS never
enters the picture.

`VITE_API_BASE_URL` overrides that default, and exists only for the split deployment
(frontend on Vercel, backend behind a tunnel) — the one case where the two origins genuinely
differ. The name kept its `VITE_` prefix deliberately: it is baked into the Vercel project's
settings, and renaming it would break that deployment silently.

Two mechanics keep that variable working with no Vite in the picture, and both fail loudly
in the same way if broken — a TypeError on the first line of `apiClient.ts` and a white page:

- **`build.ts` must `define` it.** Bun leaves an unmatched `process.env.X` in the output
  verbatim. Dropping the define does not fall back to the relative default; it throws.
- **`apiClient.ts` reads `process.env.VITE_API_BASE_URL`, not `import.meta.env.*`.**
  `Bun.serve` takes no `define`, so the dev server substitutes through `env = "VITE_*"` in
  `bunfig.toml`, and it rewrites `import.meta` to an HMR shim whose `.env` is undefined.

## Two silent bundler traps

Both are cwd-sensitive, and both fail with nothing logged.

- **`[serve.static]` must exist in both `bunfig.toml` files** (repo root and `backend/`).
  `Bun.serve` has no in-code `plugins` option (unlike `Bun.build`), so the dev server can
  only get the Tailwind plugin from `bunfig.toml` — and Bun picks that file by *current
  directory*, exactly as it does for `[test] preload`. Without the right one, the CSS is
  served with `@import "tailwindcss"` unexpanded: every utility class is missing and the
  page renders unstyled.
- **`@source` in `src/index.css` pins what Tailwind scans.** Left implicit the scan root
  follows the cwd, and the bundle is produced from three of them (`frontend/` by `build.ts`,
  `backend/` by `make dev`, the repo root by a bare `bun backend/src/main.ts`). The
  `backend/` case emitted 48 fewer classes than the production build — `bg-green-600`,
  `animate-in`, `from-emerald-600`, all used only by lazily-imported panels — so those
  components rendered unstyled in dev and fine in the build. The `@source` line makes all
  three emit the same stylesheet.

  When checking this, compare **class sets, not file sizes**: dev CSS is unminified and uses
  modern media-range syntax (`width >= 480px`) where the build downlevels it.

## Testing

Suites are colocated `*.test.ts(x)` under `src/`, run by `bun test` — not vitest, so there
is no second test toolchain in the repo.

**A DOM test must `import "../test/setup"` as its first import.** That module registers
happy-dom globally, and React and Testing Library capture `document` at import time; a
preload cannot be made to win that race from a file the test imports later.

Coverage here is thin — 13 tests across 2 files (`src/test/setup.test.ts`,
`src/hooks/usePolling.test.ts`). Adding tests alongside a change is worth more here than in
the backend.

## Lint

`bun run lint` currently exits 0 with 20 warnings, mostly `react-refresh/only-export-components`
on the context modules (they export a hook next to the provider) and a few
`react-hooks/exhaustive-deps`. They are pre-existing; don't add more, and don't treat a
clean run as the baseline.
