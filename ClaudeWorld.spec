# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for ClaudeWorld.

This bundles the FastAPI backend with the pre-built React frontend
into a single Windows executable.

Build command: pyinstaller ClaudeWorld.spec
"""

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# Version info for Windows executable (helps with SmartScreen/antivirus)
VERSION = '1.0.0.0'
version_tuple = tuple(map(int, VERSION.split('.')))

# Only create version info on Windows
if sys.platform == 'win32':
    from PyInstaller.utils.win32.versioninfo import (
        VSVersionInfo, FixedFileInfo, StringFileInfo, StringTable, StringStruct, VarFileInfo, VarStruct
    )

    version_info = VSVersionInfo(
        ffi=FixedFileInfo(
            filevers=version_tuple,
            prodvers=version_tuple,
            mask=0x3f,
            flags=0x0,
            OS=0x40004,  # VOS_NT_WINDOWS32
            fileType=0x1,  # VFT_APP
            subtype=0x0,
        ),
        kids=[
            StringFileInfo([
                StringTable('040904B0', [  # US English, Unicode
                    StringStruct('CompanyName', 'ClaudeWorld'),
                    StringStruct('FileDescription', 'ClaudeWorld - AI-powered text adventure'),
                    StringStruct('FileVersion', VERSION),
                    StringStruct('InternalName', 'ClaudeWorld'),
                    StringStruct('LegalCopyright', 'MIT License'),
                    StringStruct('OriginalFilename', 'ClaudeWorld.exe'),
                    StringStruct('ProductName', 'ClaudeWorld'),
                    StringStruct('ProductVersion', VERSION),
                ])
            ]),
            VarFileInfo([VarStruct('Translation', [0x0409, 0x04B0])])  # US English, Unicode
        ]
    )
else:
    version_info = None

# Get the project root directory
project_root = Path(SPECPATH)
backend_dir = project_root / 'backend'
frontend_dist = project_root / 'frontend' / 'dist'
agents_dir = project_root / 'agents'
config_dir = backend_dir / 'sdk' / 'config'

# Data files to include
logging_config_dir = backend_dir / 'infrastructure' / 'logging'

datas = [
    # Frontend static files
    (str(frontend_dist), 'static'),
    # Agent configurations
    (str(agents_dir), 'agents'),
    # Backend config files (YAML)
    (str(config_dir), 'backend/sdk/config'),
    # Logging/debug config
    (str(logging_config_dir), 'backend/infrastructure/logging'),
    # .env.example as template
    (str(project_root / '.env.example'), '.'),
]

# Collect ruamel.yaml data files (required for proper YAML handling)
datas += collect_data_files('ruamel.yaml')

# Collect all ruamel.yaml submodules
ruamel_hiddenimports = collect_submodules('ruamel.yaml')

# Collect local backend modules dynamically
def collect_backend_modules(backend_path):
    """Find all Python modules in the backend directory."""
    modules = []
    for root, dirs, files in os.walk(backend_path):
        # Skip __pycache__ and test directories
        dirs[:] = [d for d in dirs if d not in ('__pycache__', 'tests', '.pytest_cache')]

        rel_path = os.path.relpath(root, backend_path)
        if rel_path == '.':
            package = ''
        else:
            package = rel_path.replace(os.sep, '.')

        for file in files:
            if file.endswith('.py') and not file.startswith('test_'):
                module_name = file[:-3]  # Remove .py extension
                if package:
                    full_module = f'{package}.{module_name}'
                else:
                    full_module = module_name
                modules.append(full_module)

    return modules

backend_modules = collect_backend_modules(backend_dir)

# Hidden imports that PyInstaller might miss
hiddenimports = [
    # Local backend modules
    *backend_modules,
    # ruamel.yaml submodules (collected dynamically)
    *ruamel_hiddenimports,
    # Uvicorn internals
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'uvicorn.lifespan.off',
    # Database
    'sqlalchemy.dialects.sqlite',
    'sqlalchemy.dialects.postgresql',
    'aiosqlite',
    'asyncpg',
    # Auth
    'bcrypt',
    'jwt',  # PyJWT package
    # Claude Agent SDK
    'claude_agent_sdk',
    'claude_agent_sdk.client',
    'mcp',
    'mcp.types',
    # HTTP clients
    'httpx',
    'httpcore',
    'anyio',
    'anyio._backends',
    'anyio._backends._asyncio',
    'sniffio',
    'h11',
    'certifi',
    # APScheduler
    'apscheduler.triggers.interval',
    'apscheduler.triggers.cron',
    'apscheduler.schedulers.asyncio',
    'apscheduler.schedulers.background',
    'apscheduler.jobstores.memory',
    'apscheduler.executors.pool',
    # YAML
    'ruamel.yaml',
    'ruamel.yaml.clib',
    # Web framework
    'slowapi',
    'starlette.responses',
    'starlette.staticfiles',
    # Pydantic
    'pydantic',
    'pydantic_core',
    'email_validator',
    # Python-dotenv
    'dotenv',
    # Image processing
    'PIL',
    'PIL.Image',
    # FastAPI MCP
    'fastapi_mcp',
]

a = Analysis(
    [str(backend_dir / 'launcher.py')],
    pathex=[str(backend_dir)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'numpy',
        'pandas',
        'scipy',
        'cv2',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='ClaudeWorld',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # Console window for debugging
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,  # Add icon path here if desired
    version=version_info,  # Windows version info (reduces SmartScreen warnings)
)
