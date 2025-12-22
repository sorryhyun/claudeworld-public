#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"

if [ ! -f ".env" ]; then
  echo ".env not found. Run ./setup.sh first." >&2
  exit 1
fi

echo "Starting ClaudeWorld..."
make dev
