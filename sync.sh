#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./sync.sh [--branch <name>] [--rebase|--merge] [--no-push]
                 [--upstream <name>] [--origin <name>] [--set-upstream-url <url>]

Defaults:
  --branch            current branch
  --merge             merge upstream into current branch
  --push              push to origin after sync
  --upstream upstream
  --origin   origin
EOF
}

UPSTREAM_REMOTE="upstream"
ORIGIN_REMOTE="origin"
MODE="merge"
PUSH="true"
BRANCH=""
SET_UPSTREAM_URL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --rebase)
      MODE="rebase"
      shift
      ;;
    --merge)
      MODE="merge"
      shift
      ;;
    --no-push)
      PUSH="false"
      shift
      ;;
    --upstream)
      UPSTREAM_REMOTE="${2:-}"
      shift 2
      ;;
    --origin)
      ORIGIN_REMOTE="${2:-}"
      shift 2
      ;;
    --set-upstream-url)
      SET_UPSTREAM_URL="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository." >&2
  exit 1
fi

if [ -z "$BRANCH" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

if [ "$BRANCH" = "HEAD" ]; then
  echo "Detached HEAD. Specify --branch explicitly." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash changes before syncing." >&2
  exit 1
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  if [ -n "$SET_UPSTREAM_URL" ]; then
    git remote add "$UPSTREAM_REMOTE" "$SET_UPSTREAM_URL"
  else
    echo "Remote '$UPSTREAM_REMOTE' not found. Use --set-upstream-url <url> to add it." >&2
    exit 1
  fi
fi

if ! git remote get-url "$ORIGIN_REMOTE" >/dev/null 2>&1; then
  echo "Remote '$ORIGIN_REMOTE' not found." >&2
  exit 1
fi

echo "Fetching $UPSTREAM_REMOTE..."
git fetch "$UPSTREAM_REMOTE" --prune

if ! git show-ref --verify --quiet "refs/remotes/$UPSTREAM_REMOTE/$BRANCH"; then
  echo "Upstream branch '$UPSTREAM_REMOTE/$BRANCH' not found." >&2
  exit 1
fi

echo "Syncing $BRANCH with $UPSTREAM_REMOTE/$BRANCH ($MODE)..."
if [ "$MODE" = "rebase" ]; then
  git rebase "$UPSTREAM_REMOTE/$BRANCH"
else
  git merge "$UPSTREAM_REMOTE/$BRANCH"
fi

if [ "$PUSH" = "true" ]; then
  echo "Pushing to $ORIGIN_REMOTE/$BRANCH..."
  git push "$ORIGIN_REMOTE" "$BRANCH"
fi

echo "Sync complete."
