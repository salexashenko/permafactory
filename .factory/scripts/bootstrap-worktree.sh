#!/usr/bin/env bash
set -euo pipefail

WORKTREE_PATH="${1:?worktree path required}"
cd "$WORKTREE_PATH"

if [[ -f package-lock.json ]]; then
  npm ci
elif [[ -f pnpm-lock.yaml ]]; then
  pnpm install --frozen-lockfile
elif [[ -f yarn.lock ]]; then
  yarn install --frozen-lockfile
fi

if [[ -f .factory.env ]]; then
  set -a
  source .factory.env
  set +a
fi
