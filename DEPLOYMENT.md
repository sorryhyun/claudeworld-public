# Deployment Guide

This guide explains how to build and deploy ClaudeWorld as a standalone Windows executable.

## Overview

ClaudeWorld can be packaged into a single Windows `.exe` file using PyInstaller. This executable includes:
- FastAPI backend server
- Pre-built React frontend
- All agent configurations
- Configuration files
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
1. Build the React frontend (`npm run build`)
2. Package everything with PyInstaller
3. Create `dist/ClaudeWorld.exe`

### Manual Build Steps

If you prefer to build manually:

1. **Build the frontend:**
   ```bash
   cd frontend
   npm run build
   cd ..
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

After building, distribute the entire `dist/` directory:
```
dist/
├── ClaudeWorld.exe     # Main executable
└── (PyInstaller may create additional files depending on configuration)
```

For a single-file distribution, the current spec file creates a self-contained executable.

### User Setup Experience

When users run `ClaudeWorld.exe` for the first time:

1. **Agent Setup:** Default agents are copied from the bundled resources to the working directory
2. **Configuration Wizard:**
   - Password creation (with confirmation)
   - Display name selection
   - Auto-generation of JWT secret
3. **Auto-start:** Server starts automatically and opens browser to `http://localhost:8000`

### User Data Location

User data is stored in the same directory as the executable:
- `.env` - User configuration
- `agents/` - Agent configurations (editable by user)
- `claudeworld.db` - SQLite database (if using SQLite)

## Build Customization

### Adding an Icon

To add a custom icon to the executable:

1. Create or obtain a `.ico` file
2. Edit `ClauseWorld.spec`:
   ```python
   exe = EXE(
       # ... other parameters ...
       icon='path/to/icon.ico',  # Add this line
   )
   ```

### Changing Executable Name

Edit `ClaudeWorld.spec`:
```python
exe = EXE(
    # ... other parameters ...
    name='YourAppName',  # Change from 'ClaudeWorld'
)
```

### Debug Mode

To create a debug build with console output:

The current spec file already has `console=True` for debugging. To disable the console window:
```python
exe = EXE(
    # ... other parameters ...
    console=False,  # Hide console window
)
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

When you create a GitHub release, the workflow:
1. Builds the frontend
2. Packages everything with PyInstaller
3. Creates a ZIP archive
4. Uploads `ClaudeWorld-Windows.zip` to the release

**To create a release with automatic build:**

```bash
# Create and push a tag
git tag v1.0.0
git push origin v1.0.0

# Create release on GitHub
# The workflow will automatically build and attach the executable
```

Or create the release via GitHub UI at: `https://github.com/YOUR_USERNAME/YOUR_REPO/releases/new`

#### Manual Workflow Trigger

You can also trigger the build manually from GitHub:
1. Go to Actions tab
2. Select "Build and Release Windows Executable"
3. Click "Run workflow"

The artifact will be available for download in the workflow run.

## Support

For issues or questions:
- Check the [main README](README.md) for general ClaudeWorld documentation
- Review [CLAUDE.md](CLAUDE.md) for project architecture
- Open an issue on the GitHub repository
