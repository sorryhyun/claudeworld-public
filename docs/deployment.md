# Deployment Guide

> **⚠️ The Windows executable half of this document is historical.**
>
> `ClaudeWorld.exe` was built by PyInstaller from the Python/FastAPI backend, and that
> tree was deleted once the TypeScript port reached parity. `make build-exe`,
> `ClaudeWorld.spec`, `backend/launcher.py` and `backend/scripts/generate_icon.py` no
> longer exist. The replacement is `bun build --compile`, and the open question is the
> native window: PyInstaller shipped pywebview, and Bun has no equivalent.
>
> The web-deployment and tunnel sections below are still accurate.

This guide explains how to build and deploy ClaudeWorld as a standalone Windows executable.

> **Just want to install it?** End users don't build anything — they run one of the release-hosted install scripts:
>
> ```powershell
> # Windows (PowerShell)
> irm https://github.com/sorryhyun/claudeworld-public/releases/latest/download/install.ps1 | iex
> ```
>
> ```bash
> # macOS / Linux / WSL
> curl -fsSL https://github.com/sorryhyun/claudeworld-public/releases/latest/download/install.sh | bash
> ```
>
> See [Install Scripts](#install-scripts) for how these are published and what they do. The rest of this guide covers building the executable they download.

## Overview

ClaudeWorld can be packaged into a single Windows `.exe` file using PyInstaller. The executable runs as a **standalone desktop application** with a native window (powered by pywebview + Edge WebView2) instead of opening in the default browser.

This executable includes:
- FastAPI backend server
- Pre-built React frontend rendered in a native window
- All agent configurations
- Configuration files
- Application icon
- SQLite database support

The packaged application includes a first-time setup wizard that guides users through password creation and configuration.

## Prerequisites

### Development Environment

1. **Python 3.11 or 3.12** (required by PyInstaller)
2. **Node.js** (for building the frontend)
3. **uv** (Python package manager)
4. **Windows** (for building Windows executables)

### Dependencies

Install all dependencies:
```bash
make install
```

This will install:
- Backend Python dependencies (including PyInstaller)
- Frontend npm dependencies

## Building the Executable

### Quick Build

```bash
make build-exe
```

This command will:
1. Build the React frontend (`bun run build`)
2. Package everything with PyInstaller
3. Create `dist/ClaudeWorld.exe`

### Manual Build Steps

If you prefer to build manually:

1. **Build the frontend:**
   ```bash
   bun run build
   ```

2. **Run PyInstaller:**
   ```bash
   uv run pyinstaller ClaudeWorld.spec --noconfirm
   ```

3. **Find the executable:**
   The executable will be in `dist/ClaudeWorld.exe`

## Build Configuration

### PyInstaller Spec File

The build is configured in `ClaudeWorld.spec`, which defines:

- **Entry point:** `backend/launcher.py`
- **Included data:**
  - Frontend static files (`frontend/dist` → `static/`)
  - Agent configurations (`agents/` → `agents/`)
  - Backend config files (`backend/config/` → `backend/config/`)
  - `.env.example` template
- **Hidden imports:** All necessary Python modules
- **Excluded modules:** Unused heavy libraries (tkinter, matplotlib, etc.)

### Launcher Script

The `backend/launcher.py` script:
- Detects if running as bundled executable or in development
- Sets up Python paths correctly
- Copies default agents to working directory
- Runs first-time setup wizard if needed
- Starts the uvicorn server
- Opens the browser automatically

## Distribution

### What to Distribute

Distribution happens through GitHub releases. A published release carries four assets:

| Asset | Purpose |
|-------|---------|
| `ClaudeWorld.exe` | The standalone executable, fetched by `install.ps1` |
| `ClaudeWorld-Windows.zip` | Same exe, zipped — kept for manual downloads and older installers |
| `install.ps1` | Windows installer |
| `install.sh` | macOS / Linux / WSL installer |

The spec file produces a single self-contained executable, so `dist/ClaudeWorld.exe` is the only build output that needs shipping.

### Install Scripts

Both installers live in `scripts/install/` and are attached to every release, which is what makes the `latest/download/` one-liners work — GitHub serves release assets at a stable URL that always points at the newest published release.

**`install.ps1`** (Windows) downloads `ClaudeWorld.exe` into `%LOCALAPPDATA%\ClaudeWorld`, creates Start Menu and Desktop shortcuts, and adds the directory to the user PATH. It refuses to overwrite a running instance. Because user data lives next to the exe, replacing the exe is a complete upgrade — nothing else is touched. If a release has no bare `.exe` asset it falls back to extracting `ClaudeWorld-Windows.zip`, so it still works against pre-`beta.5` releases.

Options (download the script first to pass them): `-Version`, `-InstallDir`, `-Repo`, `-NoShortcut`, `-NoPath`.

**`install.sh`** (macOS / Linux / WSL) does a source install, since there is no prebuilt binary for these platforms. It installs `bun` if it is missing, downloads the tagged source tarball to `~/.claudeworld`, runs `bun install`, runs the `.env` wizard, and writes a `claudeworld` launcher to `~/.local/bin`:

```bash
claudeworld              # make dev (SQLite + frontend)
claudeworld postgresql   # make dev-postgresql
claudeworld perf         # make dev-perf
claudeworld setup        # re-run the .env wizard
claudeworld stop         # stop servers
claudeworld update       # re-run the installer in place
claudeworld dir version help
```

Options: `--dir`, `--version`, `--repo`, `--bin-dir`, `--no-uv`, `--no-env`, `--no-launcher`. Environment: `CLAUDEWORLD_HOME`, `CLAUDEWORLD_BIN_DIR`, `CLAUDEWORLD_REPO`.

Re-running `install.sh` upgrades in place. It preserves `.env`, `.env.bak`, `claudeworld.db` and `worlds/`, merges `agents/` so edits to shipped agents and user-created characters survive while new agents from the release still land, and carries over `.venv` and `frontend/node_modules` rather than rebuilding them. The installed version is recorded in `.claudeworld-version`.

> **`.gitattributes` matters here.** The release workflow runs on `windows-latest`, which checks out with `core.autocrlf=true`. Without `*.sh text eol=lf`, the attached `install.sh` would ship with CRLF line endings and fail to run under any shell.

### User Setup Experience

When users run `ClaudeWorld.exe` for the first time:

1. **Agent Setup:** Default agents are copied from the bundled resources to the working directory
2. **Configuration Wizard** (console window):
   - Password creation (with confirmation)
   - Display name selection
   - Auto-generation of JWT secret
3. **Auto-start:** Server starts and the application opens in a native window
   - The console window is automatically hidden after startup
   - To force browser mode instead: `ClaudeWorld.exe --browser`

### User Data Location

User data is stored in the same directory as the executable:
- `.env` - User configuration
- `agents/` - Agent configurations (editable by user)
- `claudeworld.db` - SQLite database (if using SQLite)

## Build Customization

### Application Icon

The build automatically uses `assets/icon.ico` for the executable icon and taskbar. To regenerate or customize:

```bash
# Regenerate from the script (editable at backend/scripts/generate_icon.py)
make generate-icon

# Or provide your own .ico file at assets/icon.ico
```

The icon is also used as the pywebview window icon at runtime.

### Changing Executable Name

Edit `ClaudeWorld.spec`:
```python
exe = EXE(
    # ... other parameters ...
    name='YourAppName',  # Change from 'ClaudeWorld'
)
```

### Native Window vs. Browser Mode

By default, the bundled executable opens in a **native window** using pywebview (Edge WebView2 on Windows). This provides a standalone desktop experience without browser chrome.

To use the traditional browser mode:
```bash
ClaudeWorld.exe --browser
```

The spec file uses `console=True` so the first-time setup wizard can accept keyboard input. The console window is hidden programmatically once the native window opens.

### Debug Mode

To keep the console window visible for debugging, set the environment variable:
```
CLAUDEWORLD_SHOW_CONSOLE=1
```

### Adding More Data Files

To include additional files in the bundle, edit `ClaudeWorld.spec`:
```python
datas = [
    # ... existing entries ...
    ('path/to/source', 'destination/in/bundle'),
]
```

## Troubleshooting

### Build Fails with Module Not Found

If PyInstaller can't find a module, add it to `hiddenimports` in `ClaudeWorld.spec`:
```python
hiddenimports = [
    # ... existing imports ...
    'your_missing_module',
]
```

### Executable is Too Large

The executable includes all dependencies. To reduce size:
1. Remove unused dependencies from `pyproject.toml`
2. Add more excludes to `ClaudeWorld.spec`:
   ```python
   excludes=[
       'tkinter',
       'matplotlib',
       # Add more here
   ],
   ```

### Missing Data Files at Runtime

If the executable can't find configuration files or agents:
1. Check that paths in `datas` section of `ClaudeWorld.spec` are correct
2. Verify `get_base_path()` in `launcher.py` is working correctly

### First-time Setup Not Running

The setup wizard runs when `.env` file doesn't exist or has placeholder values. If it's not running:
1. Delete the `.env` file next to the executable
2. Run the executable again

## Development vs. Production

### Development Mode

When running from source code:
```bash
make dev
```

The launcher script detects this and uses source paths directly.

### Production Mode

When running as bundled executable:
- Resources are extracted from PyInstaller bundle
- User data is stored in executable directory
- Setup wizard runs on first launch

## Testing the Build

Before distributing:

1. **Test the executable:**
   ```bash
   ./dist/ClaudeWorld.exe
   ```

2. **Verify first-time setup:**
   - Delete `.env` if it exists
   - Run the executable
   - Complete the setup wizard
   - Verify server starts and browser opens

3. **Test agent functionality:**
   - Create a new world
   - Verify agents respond correctly
   - Check that agent configurations are editable

4. **Test database:**
   - Create some data (worlds, messages, etc.)
   - Close and restart the executable
   - Verify data persists

## Advanced Topics

### Multi-file vs. Single-file Bundle

Current configuration creates a single-file executable. To create a multi-file bundle (faster startup):

Edit `ClaudeWorld.spec`:
```python
exe = EXE(
    pyz,
    a.scripts,
    # Remove these two lines:
    # a.binaries,
    # a.datas,
    [],
    name='ClaudeWorld',
    # ... rest of config ...
)

# Add this:
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name='ClaudeWorld'
)
```

### Cross-compilation

PyInstaller generally requires building on the target platform:
- Build Windows executables on Windows
- Build macOS executables on macOS
- Build Linux executables on Linux

For cross-platform distribution, build on each platform separately.

### Continuous Integration

ClaudeWorld includes a GitHub Actions workflow (`.github/workflows/release.yml`) that automatically builds Windows executables.

#### Automated Release Builds

The workflow fires when a release is **published** (not merely created, so drafts don't trigger a build). It then:
1. Generates the icon and builds the frontend
2. Packages everything with PyInstaller
3. Creates a ZIP archive
4. Uploads `ClaudeWorld.exe`, `ClaudeWorld-Windows.zip`, `install.sh` and `install.ps1` to the release

**To cut a release:**

```bash
gh release create <tag> --title "<title>" --target master --generate-notes
```

The workflow attaches all four assets a few minutes later. Verify with:

```bash
gh release view <tag> --json assets --jq '.assets[].name'
curl -fsSL https://github.com/sorryhyun/claudeworld-public/releases/latest/download/install.sh | head -5
```

Or create the release via the GitHub UI at `https://github.com/sorryhyun/claudeworld-public/releases/new` — publishing it there triggers the same build.

Note that a release ships the `install.sh` / `install.ps1` from **its own tag**, so installer changes only reach users once a release is published from a commit containing them.

#### Manual Workflow Trigger

You can also trigger the build manually from GitHub:
1. Go to Actions tab
2. Select "Build and Release Windows Executable"
3. Click "Run workflow"

The artifact will be available for download in the workflow run.

## Support

For issues or questions:
- Check the [main README](../README.md) for general ClaudeWorld documentation
- Review [CLAUDE.md](../CLAUDE.md) for project architecture
- Open an issue on the GitHub repository
