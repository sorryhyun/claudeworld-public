#!/usr/bin/env python
"""Alembic CLI for ClaudeWorld.

There is no ``alembic.ini`` -- the config lives in
``infrastructure/database/alembic_runner.py`` -- so the stock ``alembic``
command cannot find anything. Use this instead:

    uv run python backend/scripts/alembic_cli.py revision --autogenerate -m "add foo"
    uv run python backend/scripts/alembic_cli.py upgrade head
    uv run python backend/scripts/alembic_cli.py history
    uv run python backend/scripts/alembic_cli.py check      # models.py vs revisions

DATABASE_URL selects the database, exactly as it does for the app. Autogenerate
and ``check`` compare ``models.py`` against whatever that URL points at, so
point them at a database already upgraded to head.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "backend"))

# Default to the dev SQLite database rather than the app's PostgreSQL default,
# so running the CLI without a DATABASE_URL does not silently try to reach a
# server that is not there.
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_REPO_ROOT / 'claudeworld.db'}")


def main() -> int:
    from alembic.config import CommandLine
    from infrastructure.database.alembic_runner import build_alembic_config

    cli = CommandLine(prog="alembic_cli.py")
    options = cli.parser.parse_args(sys.argv[1:])
    if not hasattr(options, "cmd"):
        cli.parser.error("too few arguments")

    config = build_alembic_config()
    config.cmd_opts = options
    cli.run_cmd(config, options)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
