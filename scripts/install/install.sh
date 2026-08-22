#!/usr/bin/env bash
#
# ClaudeWorld installer for macOS / Linux / WSL.
#
#   curl -fsSL https://github.com/sorryhyun/claudeworld-public/releases/latest/download/install.sh | bash
#
# Downloads the latest GitHub release, installs dependencies and drops a
# `claudeworld` launcher into ~/.local/bin. Re-running it upgrades in place and
# keeps your .env, database and worlds.
#
set -euo pipefail

REPO="${CLAUDEWORLD_REPO:-sorryhyun/claudeworld-public}"
INSTALL_DIR="${CLAUDEWORLD_HOME:-$HOME/.claudeworld}"
BIN_DIR="${CLAUDEWORLD_BIN_DIR:-$HOME/.local/bin}"
VERSION="latest"
INSTALL_BUN=1
CREATE_ENV=1
CREATE_LAUNCHER=1

# User data that survives an upgrade, replacing what the release ships.
PRESERVE=(.env .env.bak claudeworld.db worlds)
# Data trees merged instead of replaced: user edits to shipped files win, files
# new in this release still land, and anything the user added is kept.
MERGE=(agents config)
# Expensive to rebuild, so carried over instead of re-downloaded. JS deps
# live in one root node_modules now -- the repo is a single Bun workspace.
CARRY_OVER=(.venv node_modules)

usage() {
    cat <<'EOF'
ClaudeWorld installer

Usage: install.sh [options]

Options:
  --dir <path>      Install location (default: ~/.claudeworld, or $CLAUDEWORLD_HOME)
  --version <tag>   Release tag to install (default: latest)
  --repo <owner/repo>
                    Source repository (default: sorryhyun/claudeworld-public)
  --bin-dir <path>  Where to put the `claudeworld` launcher (default: ~/.local/bin)
  --no-bun          Fail instead of installing bun when it is missing
  --no-env          Skip the interactive .env setup
  --no-launcher     Skip creating the `claudeworld` launcher
  -h, --help        Show this help

Environment: CLAUDEWORLD_HOME, CLAUDEWORLD_BIN_DIR, CLAUDEWORLD_REPO
EOF
}

log()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m  x %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)         INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
        --version)     VERSION="${2:?--version needs a tag}"; shift 2 ;;
        --repo)        REPO="${2:?--repo needs owner/repo}"; shift 2 ;;
        --bin-dir)     BIN_DIR="${2:?--bin-dir needs a path}"; shift 2 ;;
        --no-bun)      INSTALL_BUN=0; shift ;;
        --no-env)      CREATE_ENV=0; shift ;;
        --no-launcher) CREATE_LAUNCHER=0; shift ;;
        -h|--help)     usage; exit 0 ;;
        *)             die "Unknown option: $1 (try --help)" ;;
    esac
done

# ---------------------------------------------------------------- prerequisites

need() { command -v "$1" >/dev/null 2>&1; }

step "Checking prerequisites"

need curl || die "curl is required."
need tar  || die "tar is required."

case "$(uname -s)" in
    Darwin) PLATFORM="macOS" ;;
    Linux)  PLATFORM="Linux"; grep -qi microsoft /proc/version 2>/dev/null && PLATFORM="WSL" ;;
    *)      die "Unsupported platform: $(uname -s). On Windows use install.ps1." ;;
esac
log "Platform: $PLATFORM"

if ! need bun; then
    [ "$INSTALL_BUN" -eq 1 ] || die "bun is required but --no-bun was passed. See https://bun.sh/"
    log "bun not found - installing from https://bun.sh/install"
    curl -fsSL https://bun.sh/install | bash
    # The installer drops bun here; pick it up for this session. Written as an
    # `if` rather than `[ ... ] && ...` because under `set -e` a false test on
    # the last command of the list would abort the installer.
    if [ -x "$HOME/.bun/bin/bun" ]; then
        PATH="$HOME/.bun/bin:$PATH"
    fi
    need bun || die "bun installed but not on PATH. Open a new shell and re-run this installer."
fi
log "bun: $(bun --version)"

if ! need claude; then
    warn "The 'claude' CLI was not found. ClaudeWorld drives agents through it."
    warn "Install it before creating a world:"
    warn "  bun add -g @anthropic-ai/claude-code"
    warn "Or set CLAUDE_API_KEY in .env to use the API directly."
fi

# ------------------------------------------------------------------- download

step "Resolving release"

if [ "$VERSION" = "latest" ]; then
    # Follow the /releases/latest redirect - no API token, no rate limit.
    resolved_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
        "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
    case "$resolved_url" in
        */releases/tag/*) VERSION="${resolved_url##*/tag/}" ;;
        *)
            warn "No published release found for $REPO - falling back to the master branch."
            VERSION="master"
            ;;
    esac
fi

if [ "$VERSION" = "master" ] || [ "$VERSION" = "main" ]; then
    TARBALL_URL="https://github.com/$REPO/archive/refs/heads/$VERSION.tar.gz"
else
    TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz"
fi
log "Version: $VERSION"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claudeworld-install.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

STAGE="$TMP_DIR/stage"
mkdir -p "$STAGE"

step "Downloading $TARBALL_URL"
curl -fsSL "$TARBALL_URL" | tar -xz --strip-components=1 -C "$STAGE" \
    || die "Download failed. Check the version tag and your network."
[ -f "$STAGE/package.json" ] || die "Downloaded archive does not look like ClaudeWorld."
printf '%s\n' "$VERSION" > "$STAGE/.claudeworld-version"

# --------------------------------------------------------------------- install

step "Installing to $INSTALL_DIR"

if [ -d "$INSTALL_DIR" ]; then
    log "Existing install found - keeping your data"

    for item in "${PRESERVE[@]}"; do
        if [ -e "$INSTALL_DIR/$item" ]; then
            rm -rf "${STAGE:?}/$item"
            cp -R "$INSTALL_DIR/$item" "$STAGE/$item"
            log "kept $item"
        fi
    done

    # config/ moved out of backend/ in this release. An install predating the
    # move keeps the user's prompt edits in the old place, where no loader
    # reads them and where the wholesale tree replacement below would drop
    # them. Stage them under the new name; the merge then finds nothing to
    # override them with.
    if [ ! -d "$INSTALL_DIR/config" ]; then
        if [ -d "$INSTALL_DIR/backend/sdk/config" ]; then
            mkdir -p "$STAGE/config"
            cp -R "$INSTALL_DIR/backend/sdk/config/." "$STAGE/config/"
            log "moved backend/sdk/config/ -> config/"
        fi
        if [ -f "$INSTALL_DIR/backend/infrastructure/logging/debug.yaml" ]; then
            mkdir -p "$STAGE/config"
            cp "$INSTALL_DIR/backend/infrastructure/logging/debug.yaml" "$STAGE/config/debug.yaml"
            log "moved debug.yaml -> config/"
        fi
    fi

    for item in "${MERGE[@]}"; do
        if [ -d "$INSTALL_DIR/$item" ]; then
            mkdir -p "$STAGE/$item"
            cp -R "$INSTALL_DIR/$item/." "$STAGE/$item/"
            log "merged $item/"
        fi
    done

    for item in "${CARRY_OVER[@]}"; do
        if [ -d "$INSTALL_DIR/$item" ] && [ ! -e "$STAGE/$item" ]; then
            mkdir -p "$(dirname "$STAGE/$item")"
            mv "$INSTALL_DIR/$item" "$STAGE/$item"
        fi
    done

    BACKUP_DIR="$INSTALL_DIR.old.$$"
    mv "$INSTALL_DIR" "$BACKUP_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    mv "$STAGE" "$INSTALL_DIR"
    rm -rf "$BACKUP_DIR"
else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    mv "$STAGE" "$INSTALL_DIR"
fi

step "Installing dependencies (bun install)"
# One Bun workspace over backend/ and frontend/, so this is the whole install.
(cd "$INSTALL_DIR" && bun install --frozen-lockfile)

# ------------------------------------------------------------------ .env setup

if [ "$CREATE_ENV" -eq 1 ] && [ ! -f "$INSTALL_DIR/.env" ]; then
    step "Configuring .env"
    # `curl | bash` leaves stdin pointing at the pipe, so borrow the terminal.
    if [ -t 0 ]; then
        (cd "$INSTALL_DIR" && bun run setup) || warn ".env setup did not complete."
    elif [ -r /dev/tty ]; then
        (cd "$INSTALL_DIR" && bun run setup < /dev/tty) || warn ".env setup did not complete."
    else
        warn "No terminal available - skipping .env setup."
        warn "Run it later with:  claudeworld setup"
    fi
fi

# ------------------------------------------------------------------- launcher

if [ "$CREATE_LAUNCHER" -eq 1 ]; then
    step "Installing launcher to $BIN_DIR/claudeworld"
    mkdir -p "$BIN_DIR"
    cat > "$BIN_DIR/claudeworld" <<EOF
#!/usr/bin/env bash
# ClaudeWorld launcher - generated by the installer.
set -euo pipefail
CLAUDEWORLD_HOME="\${CLAUDEWORLD_HOME:-$INSTALL_DIR}"
CLAUDEWORLD_REPO="\${CLAUDEWORLD_REPO:-$REPO}"
INSTALLER_URL="https://github.com/\$CLAUDEWORLD_REPO/releases/latest/download/install.sh"

[ -d "\$CLAUDEWORLD_HOME" ] || { echo "ClaudeWorld is not installed at \$CLAUDEWORLD_HOME" >&2; exit 1; }
cd "\$CLAUDEWORLD_HOME"

case "\${1:-start}" in
    start)      exec make dev ;;
    perf)       exec make dev-perf ;;
    setup)      exec bun run setup --force ;;
    stop)       exec make stop ;;
    dir)        echo "\$CLAUDEWORLD_HOME" ;;
    version)    cat .claudeworld-version 2>/dev/null || echo "unknown" ;;
    update)     exec bash -c "curl -fsSL '\$INSTALLER_URL' | bash -s -- --dir '\$CLAUDEWORLD_HOME'" ;;
    -h|--help|help)
        cat <<'USAGE'
claudeworld [command]

  start       Run backend + frontend on one port (default)
  perf        Run with performance logging to latency.log
  setup       Re-run the .env setup wizard
  stop        Stop running servers
  update      Re-run the installer to upgrade in place
  dir         Print the install directory
  version     Print the installed version
USAGE
        ;;
    *) echo "Unknown command: \$1 (try 'claudeworld help')" >&2; exit 1 ;;
esac
EOF
    chmod +x "$BIN_DIR/claudeworld"
fi

# ---------------------------------------------------------------------- done

step "Done"
log "Installed $VERSION to $INSTALL_DIR"
echo

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
        if [ "$CREATE_LAUNCHER" -eq 1 ]; then
            warn "$BIN_DIR is not on your PATH. Add this to your shell profile:"
            warn "  export PATH=\"$BIN_DIR:\$PATH\""
        fi
        ;;
esac

if [ "$CREATE_LAUNCHER" -eq 1 ]; then
    log "Start it with:   claudeworld"
else
    log "Start it with:   cd $INSTALL_DIR && make dev"
fi
log "Then open:       http://localhost:5173"
echo
