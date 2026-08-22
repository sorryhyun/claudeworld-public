# Deployment Guide

Building and shipping ClaudeWorld as a standalone executable.

> This replaces the PyInstaller build. `ClaudeWorld.exe` used to be a PyInstaller
> bundle of the Python/FastAPI backend, and that backend no longer exists — the whole
> tree was deleted once the TypeScript port reached parity. The executable is now
> `bun build --compile` output, which changes three user-visible things:
>
> - **No native window.** PyInstaller shipped pywebview (Edge WebView2); Bun has no
>   equivalent. The binary serves the app on localhost and opens the system browser.
>   There is no `--browser` flag any more because there is nothing else to be.
> - **No Python, no runtime.** One file, nothing to install alongside it.
> - **The `claude` CLI still has to be on the machine.** See below.

## What the binary is

One file that contains:

| Inside the exe | Why |
|---|---|
| The backend (Hono, Drizzle, the SDK layer, orchestration) | it *is* the program |
| `frontend/dist` | served from `Bun.embeddedFiles`, never written to disk |
| `agents/`, `backend/sdk/config/`, `backend/drizzle/`, the readme files | unpacked beside the exe on launch — see [Seed data](#seed-data) |

and, deliberately, does **not** contain the `claude` CLI. The Agent SDK ships that as a
platform-specific native binary of roughly 330MB — three times the size of everything
else here, per platform — so the exe uses whatever Claude Code the user already has.
`backend/src/sdk/client/cli-path.ts` looks for it beside the executable, then in
`~/.local/bin`, then on `PATH`, with `CLAUDE_CODE_PATH` overriding all three. Both
installers check for it and say so if it is missing.

## Building

```bash
bun install
bun run build:exe              # linux-x64  → dist/claudeworld
bun run build:exe:windows      # windows-x64 → dist/ClaudeWorld.exe
```

Both are `bun run build` (the frontend) followed by `scripts/build/exe-bundle.ts`, which
takes `--target windows|linux|macos` and `--arch x64|arm64`. **Cross-compilation works**:
the Windows binary is built on the Linux CI runner. There are no native dependencies left
to block it — the last one, `sharp`, was replaced by `Bun.Image`.

The build script's real job is staging. `bun build --compile --asset <dir>` keys every
embedded file on its path *under that directory's basename*, so the source trees have to
be presented under the names the runtime looks for (`frontend/`, `seed/`). It builds a
staging directory under `dist/.exe-assets/` and deletes it afterwards.
`backend/src/exe/assets.ts` is the other half of that contract.

## Seed data

`agents/` and `backend/sdk/config/` are read at runtime, hot-reloaded on mtime, and
written to — agent memory is a file. They cannot be served from inside the binary, so the
exe unpacks them next to itself on every launch, guided by a `.claudeworld-seed.json`
manifest recording what it wrote and what was in it:

| On disk | Result |
|---|---|
| absent | written |
| identical to what a previous release wrote | replaced with this release's copy |
| anything else (you edited it, or it predates the manifest) | left alone |

So a new release can ship a better prompt without silently reverting the prompt you
tuned. `decideSeedAction` in `backend/src/exe/assets.ts` is that rule, and it is unit
tested.

## What lives beside the executable

```
ClaudeWorld.exe
.env                       written by the first-launch wizard
claudeworld.db             SQLite, created on first boot
.claudeworld-seed.json     what the binary unpacked, and its hashes
agents/                    yours to edit
backend/sdk/config/        prompt YAML, yours to edit
backend/drizzle/           migrations (read by the migrator, not interesting)
worlds/                    your saved worlds
```

The executable's own directory *is* the project root — `resolveProjectRoot()` returns
`dirname(process.execPath)` in a bundled run — which is what makes the install portable
and an upgrade a matter of replacing one file. `CLAUDEWORLD_ROOT` still overrides.

## First launch

1. Unpacks the seed data.
2. If `.env` is not configured, runs the same wizard `make setup` does: password (bcrypt,
   cost 12) and a generated `JWT_SECRET`. With no console to ask on, it prints where to
   write `.env` by hand and exits rather than starting a server that would 401 every
   login.
3. Starts on `PORT` (default 8000, falling back to an OS-assigned port if it is taken)
   and opens the browser at the port it actually won.

> **A `.env` in the process's own working directory is a hazard**, and this is where it
> bites. Bun auto-loads `.env` from the current directory *and expands `$VAR` in it*, so a
> bcrypt hash — `$2b$12$…` — arrives in `process.env` with its salt eaten, and every login
> fails with "Invalid password". `restoreExpandedDotEnv` in `config/settings.ts` puts back
> any value that is exactly what Bun's expansion would have produced. `make dev` never hit
> this because it runs from `backend/`, which has no `.env`.

## Releasing

`gh release create <tag> --target master --generate-notes`, then
`.github/workflows/release.yml` (on `published`) builds both binaries, boots the Linux one
in a scratch directory to prove the embedded frontend and the seed trees survived
bundling, and attaches:

| Asset | Notes |
|---|---|
| `ClaudeWorld.exe` | windows-x64 |
| `claudeworld-linux-x64` | also what the smoke test runs |
| `SHA256SUMS` | checked by `install.ps1` |
| `install.sh`, `install.ps1` | so the `latest/download/` one-liners resolve |

**macOS is deliberately absent.** `bun build --compile --target=bun-darwin-arm64` works,
but an unsigned binary downloaded from GitHub arrives quarantined and needs a Gatekeeper
override to run at all. Until there is a signing identity, `install.sh` (source install)
is the honest macOS story.

`.gitattributes` pins `*.sh` to LF because the release runner may check out with
`core.autocrlf=true`.

## Installing

**Windows** — `install.ps1` downloads `ClaudeWorld.exe` into `%LOCALAPPDATA%\ClaudeWorld`,
verifies it against `SHA256SUMS`, creates Start Menu and Desktop shortcuts and adds the
directory to the user `PATH`. It refuses to overwrite a running instance. Because user
data sits next to the exe, replacing the exe *is* the upgrade.

```powershell
irm https://github.com/sorryhyun/claudeworld-public/releases/latest/download/install.ps1 | iex
```

**macOS / Linux / WSL** — `install.sh` does a source install to `~/.claudeworld` plus a
`claudeworld` launcher, preserving `.env`, `claudeworld.db`, `worlds/` and edited agents
across upgrades.

```bash
curl -fsSL https://github.com/sorryhyun/claudeworld-public/releases/latest/download/install.sh | bash
```

## Troubleshooting

**"Invalid password" right after setting one.** See the dotenv note above; if it survives
that, check whether `API_KEY_HASH` is exported in the environment, since a real
environment variable still wins over the file.

**A turn fails immediately with nothing useful.** The `claude` CLI is missing or not where
the resolver looks. `CLAUDE_CODE_PATH=<abs path>` in `.env` settles it. An override that
points at nothing resolves to *nothing* rather than falling back, on purpose: a wrong
override should fail loudly instead of quietly running a different binary.

**The port in the log is not 8000.** `PORT` is a preference. A taken port falls back to an
OS-assigned one, and the startup log names the URL that actually won — that printed URL is
the authoritative one.

**The binary is ~105MB.** About 60MB of that is the Bun runtime and 13MB the frontend
(fonts included). `--minify` is deliberately not passed: it saves a couple of MB against a
risk this build has no reason to take.
