#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found. Install uv first: https://astral.sh/uv" >&2
  exit 1
fi

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

echo "Installing dependencies..."
make install

read -s -p "Enter admin password: " ADMIN_PASSWORD
printf "\n"
read -s -p "Confirm admin password: " ADMIN_PASSWORD_CONFIRM
printf "\n"

if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
  echo "Passwords do not match. Aborting." >&2
  exit 1
fi

API_KEY_HASH=$(
  ADMIN_PASSWORD="$ADMIN_PASSWORD" uv run python - <<'PY'
import bcrypt
import os

pw = os.environ.get("ADMIN_PASSWORD", "").encode("utf-8")
if not pw:
    raise SystemExit("Empty password")
print(bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8"))
PY
)

JWT_SECRET=$(uv run python - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)

API_KEY_HASH="$API_KEY_HASH" JWT_SECRET="$JWT_SECRET" python - <<'PY'
from pathlib import Path
import os

env_path = Path(".env")
content = env_path.read_text(encoding="utf-8").splitlines()
api_key_hash = os.environ.get("API_KEY_HASH", "")
jwt_secret = os.environ.get("JWT_SECRET", "")

updated = []
api_set = False
jwt_set = False

for line in content:
    if line.startswith("API_KEY_HASH="):
        updated.append(f"API_KEY_HASH={api_key_hash}")
        api_set = True
    elif line.startswith("JWT_SECRET="):
        updated.append(f"JWT_SECRET={jwt_secret}")
        jwt_set = True
    else:
        updated.append(line)

if not api_set:
    updated.append(f"API_KEY_HASH={api_key_hash}")
if not jwt_set:
    updated.append(f"JWT_SECRET={jwt_secret}")

env_path.write_text("\n".join(updated) + "\n", encoding="utf-8")
PY

echo "Updated .env with API_KEY_HASH and JWT_SECRET."
echo "Setup complete."
